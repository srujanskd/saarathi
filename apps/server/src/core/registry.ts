import {
  CORE_ID,
  type ActionInput,
  type Cancel,
  type Effect,
  type EventType,
  type GainsLedger,
  type GameModuleDef,
  type InvokeResult,
  type Logger,
  type ModuleContext,
  type ModuleStatus,
  type StreamEvent,
} from "@saarathi/shared";
import { deckCommand, type DeckCommands } from "./deck.js";
import { obsCommand, type ObsAdapter } from "./obs.js";
import type { StateStore } from "./store.js";
import { ActionRefused } from "./triggers.js";

/** Long enough to batch a burst of chat, short enough to feel instant. */
const PATCH_COALESCE_MS = 60;

const LIFECYCLE_KEY = "lifecycle";

export interface RegistryDeps {
  store: StateStore;
  gains: GainsLedger;
  obs: ObsAdapter;
  deck: DeckCommands;
  log: Logger;
  say(text: string): void;
  onPatch(module: string, state: unknown): void;
  onEffect(effect: Effect): void;
  /** Enabled or armed changed, so the core slice needs republishing. */
  onLifecycleChange(): void;
}

type Handler = (event: never) => void;

interface Runtime {
  def: GameModuleDef;
  state: Record<string, unknown>;
  ctx: ModuleContext<Record<string, unknown>>;
  subs: Map<EventType, Set<Handler>>;
  timers: Set<NodeJS.Timeout>;
  enabled: boolean;
  armed: boolean;
  started: boolean;
}

/**
 * Holds every module, its state slice, its subscriptions and its timers, and
 * owns the two lifecycle flags the core is responsible for.
 *
 * Modules reach the outside world only through the context this builds, so a
 * module cannot touch a socket, a file or a save timer even by accident. That
 * is the whole point: sync, persistence and teardown are solved once here
 * instead of once per game.
 */
export class Registry {
  private readonly modules = new Map<string, Runtime>();
  private readonly dirty = new Set<string>();
  private patchTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RegistryDeps) {}

  register(def: GameModuleDef): void {
    if (this.modules.has(def.id)) throw new Error(`Duplicate module id "${def.id}"`);
    if (def.id === CORE_ID) throw new Error(`"${CORE_ID}" is reserved`);

    const state = structuredClone(def.initialState) as Record<string, unknown>;
    for (const [key, value] of Object.entries(this.readPersisted(def))) state[key] = value;

    const lifecycle = this.readLifecycle()[def.id];
    const runtime: Runtime = {
      def,
      state,
      ctx: null as unknown as ModuleContext<Record<string, unknown>>,
      subs: new Map(),
      timers: new Set(),
      enabled: lifecycle?.enabled ?? true,
      armed: lifecycle?.armed ?? false,
      started: false,
    };
    runtime.ctx = this.buildContext(runtime);
    this.modules.set(def.id, runtime);
  }

  async start(): Promise<void> {
    for (const runtime of this.modules.values()) {
      if (runtime.enabled) await this.startModule(runtime);
    }
  }

  async stop(): Promise<void> {
    for (const runtime of this.modules.values()) await this.stopModule(runtime);
    if (this.patchTimer) {
      clearTimeout(this.patchTimer);
      this.patchTimer = null;
    }
  }

  ids(): string[] {
    return [...this.modules.keys()];
  }

  statuses(): ModuleStatus[] {
    return [...this.modules.values()].map((runtime) => ({
      id: runtime.def.id,
      title: runtime.def.title,
      enabled: runtime.enabled,
      armed: runtime.def.arming ? runtime.armed : true,
      arming: Boolean(runtime.def.arming),
      actions: Object.entries(runtime.def.actions)
        .filter(([, spec]) => !spec.needsArgs)
        .map(([id, spec]) => ({ id: `${runtime.def.id}.${id}`, label: spec.label })),
      commands: (runtime.def.commands ?? []).map((command) => ({
        name: command.name,
        action: `${runtime.def.id}.${command.action}`,
        cooldownMs: command.cooldownMs,
        cost: command.cost,
      })),
    }));
  }

  /** State slices for the modules a client asked for. */
  snapshot(ids?: string[]): Record<string, unknown> {
    const wanted = ids ? new Set(ids) : null;
    const out: Record<string, unknown> = {};
    for (const [id, runtime] of this.modules) {
      if (!wanted || wanted.has(id)) out[id] = runtime.state;
    }
    return out;
  }

  /** The command index, built from enabled modules only. */
  findCommand(name: string) {
    const wanted = name.toLowerCase();
    for (const runtime of this.modules.values()) {
      if (!runtime.enabled) continue;
      const spec = runtime.def.commands?.find((command) => command.name.toLowerCase() === wanted);
      if (spec) return { moduleId: runtime.def.id, spec };
    }
    return undefined;
  }

  /** Fan a normalized event out to every enabled module that asked for it. */
  handleEvent(event: StreamEvent): void {
    for (const runtime of this.modules.values()) {
      if (!runtime.enabled || !runtime.started) continue;
      const handlers = runtime.subs.get(event.type);
      if (!handlers) continue;
      for (const handler of handlers) {
        try {
          (handler as (e: StreamEvent) => void)(event);
        } catch (err) {
          this.deps.log.error(`${runtime.def.id}: handler for ${event.type} threw`, err);
        }
      }
    }
  }

  async dispatch(actionId: string, input: ActionInput): Promise<InvokeResult> {
    const separator = actionId.indexOf(".");
    if (separator < 1) return { ok: false, reason: `"${actionId}" is not a module action` };
    const moduleId = actionId.slice(0, separator);
    const name = actionId.slice(separator + 1);

    if (moduleId === CORE_ID) return this.dispatchCore(actionId, name, input);

    const runtime = this.modules.get(moduleId);
    if (!runtime) return { ok: false, reason: `There is no "${moduleId}"` };
    if (!runtime.enabled) return { ok: false, reason: `${runtime.def.title} is switched off` };

    const spec = runtime.def.actions[name];
    if (!spec) return { ok: false, reason: `${runtime.def.title} has no "${name}"` };
    if (runtime.def.arming && !runtime.armed) {
      return { ok: false, reason: `${runtime.def.title} is not armed yet` };
    }

    try {
      await spec.run(input, runtime.ctx);
      return { ok: true };
    } catch (err) {
      if (err instanceof ActionRefused) {
        // Refusals are normal, not failures, but they still have to be legible:
        // an auto-triggered action has no caller waiting to be told why.
        this.deps.log.info(`${actionId} refused: ${err.message}`);
        return { ok: false, reason: err.message };
      }
      this.deps.log.error(`${actionId} failed`, err);
      return { ok: false, reason: "That did not work. Check the log." };
    }
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Every way in has a way out, and both survive a restart. Arming is opt-in:
   * a module that did not ask for it counts as armed and refuses arm/disarm,
   * so her control page never shows a button that does nothing.
   */
  private async dispatchCore(
    /** Whole, because the two routers below key off `CORE_ACTIONS`. */
    actionId: string,
    name: string,
    input: ActionInput,
  ): Promise<InvokeResult> {
    // OBS routes itself. What its actions are called and what their arguments
    // mean is knowledge about OBS, and this file is about modules.
    const obs = obsCommand(this.deps.obs, actionId, input.args);
    if (obs) return obs;

    // Same arrangement, same reason: what a button is made of is knowledge
    // about the deck.
    const deck = deckCommand(this.deps.deck, actionId, input.args);
    if (deck) return deck;

    // Resolving the target module belongs to the cases that have one, which is
    // why these are closures. Doing it eagerly refused every core action that
    // is not about a module -- which, once OBS arrived, was most of them.
    const target = (): Runtime | null => this.modules.get(input.args[0] ?? "") ?? null;
    const missing = (): InvokeResult => ({
      ok: false,
      reason: `There is no "${input.args[0] ?? ""}"`,
    });

    switch (name) {
      case "enable":
      case "disable": {
        const runtime = target();
        if (!runtime) return missing();
        const enabled = name === "enable";
        if (runtime.enabled === enabled) return { ok: true };
        runtime.enabled = enabled;
        if (enabled) await this.startModule(runtime);
        else await this.stopModule(runtime);
        this.saveLifecycle();
        this.deps.onLifecycleChange();
        return { ok: true };
      }
      case "arm":
      case "disarm": {
        const runtime = target();
        if (!runtime) return missing();
        if (!runtime.def.arming) {
          return { ok: false, reason: `${runtime.def.title} does not use arming` };
        }
        runtime.armed = name === "arm";
        this.saveLifecycle();
        this.deps.onLifecycleChange();
        return { ok: true };
      }
      default:
        return { ok: false, reason: `There is no core action "${name}"` };
    }
  }

  private async startModule(runtime: Runtime): Promise<void> {
    if (runtime.started) return;
    runtime.started = true;
    try {
      await runtime.def.setup?.(runtime.ctx);
    } catch (err) {
      this.deps.log.error(`${runtime.def.id}: setup failed`, err);
    }
  }

  private async stopModule(runtime: Runtime): Promise<void> {
    if (!runtime.started) return;
    runtime.started = false;
    try {
      await runtime.def.teardown?.(runtime.ctx);
    } catch (err) {
      this.deps.log.error(`${runtime.def.id}: teardown failed`, err);
    }
    for (const timer of runtime.timers) clearTimeout(timer as NodeJS.Timeout);
    runtime.timers.clear();
    runtime.subs.clear();
  }

  // --- the context modules see ----------------------------------------------

  private buildContext(runtime: Runtime): ModuleContext<Record<string, unknown>> {
    const { def } = runtime;

    const track = (timer: NodeJS.Timeout, repeating: boolean): Cancel => {
      timer.unref?.();
      runtime.timers.add(timer);
      return () => {
        runtime.timers.delete(timer);
        if (repeating) clearInterval(timer);
        else clearTimeout(timer);
      };
    };

    return {
      id: def.id,
      get state() {
        return runtime.state;
      },
      get armed() {
        return def.arming ? runtime.armed : true;
      },
      // Every function below is an arrow property rather than a shorthand
      // method, so `this` is the registry throughout. Some of them need it and
      // some do not, but a mix of the two forms invites a reader to work out
      // which is which: a shorthand method here gets the context as `this`,
      // not the registry, and aliasing the registry into a local instead reads
      // fine and lints badly.
      setState: (patch) => {
        const next = typeof patch === "function" ? patch(runtime.state) : patch;
        Object.assign(runtime.state, next);
        this.markDirty(runtime);
      },
      on: (type, handler) => {
        let handlers = runtime.subs.get(type);
        if (!handlers) {
          handlers = new Set();
          runtime.subs.set(type, handlers);
        }
        handlers.add(handler as Handler);
        return () => handlers.delete(handler as Handler);
      },
      effect: (effect) => {
        // Publish the state this effect goes with first. Otherwise the sound
        // plays a frame before the overlay has the label to show alongside it.
        this.flushPatches();
        this.deps.onEffect({ module: def.id, ...effect });
      },
      invoke: async (action, input) => {
        await this.dispatch(`${def.id}.${action}`, {
          by: "system",
          via: "auto",
          args: [],
          ...input,
        });
      },
      refuse: (reason): never => {
        throw new ActionRefused(reason);
      },
      gains: this.deps.gains,
      obs: this.deps.obs.actions,
      after: (ms, fn) => track(setTimeout(fn, ms), false),
      every: (ms, fn) => track(setInterval(fn, ms), true),
      say: (text) => this.deps.say(text),
      log: this.deps.log,
    };
  }

  // --- publish and persist ---------------------------------------------------

  private markDirty(runtime: Runtime): void {
    this.persist(runtime);
    this.dirty.add(runtime.def.id);
    if (this.patchTimer) return;
    this.patchTimer = setTimeout(() => this.flushPatches(), PATCH_COALESCE_MS);
    this.patchTimer.unref?.();
  }

  private flushPatches(): void {
    if (this.patchTimer) {
      clearTimeout(this.patchTimer);
      this.patchTimer = null;
    }
    for (const id of this.dirty) {
      const target = this.modules.get(id);
      if (target) this.deps.onPatch(id, target.state);
    }
    this.dirty.clear();
  }

  private persist(runtime: Runtime): void {
    const keys = runtime.def.persist;
    if (!keys?.length) return;
    const durable: Record<string, unknown> = {};
    for (const key of keys) durable[key as string] = runtime.state[key as string];
    this.deps.store.write(runtime.def.id, durable);
  }

  private readPersisted(def: GameModuleDef): Record<string, unknown> {
    const keys = def.persist;
    if (!keys?.length) return {};
    const saved = this.deps.store.read(def.id);
    if (!saved) return {};
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      if (saved[key as string] !== undefined) out[key as string] = saved[key as string];
    }
    return out;
  }

  private readLifecycle(): Record<string, { enabled: boolean; armed: boolean }> {
    const saved = this.deps.store.read(CORE_ID)?.[LIFECYCLE_KEY];
    return saved && typeof saved === "object"
      ? (saved as Record<string, { enabled: boolean; armed: boolean }>)
      : {};
  }

  private saveLifecycle(): void {
    const lifecycle: Record<string, { enabled: boolean; armed: boolean }> = {};
    for (const [id, runtime] of this.modules) {
      lifecycle[id] = { enabled: runtime.enabled, armed: runtime.armed };
    }
    this.deps.store.write(CORE_ID, { [LIFECYCLE_KEY]: lifecycle });
  }
}
