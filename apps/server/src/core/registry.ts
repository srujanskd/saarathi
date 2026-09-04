import {
  ACCESS_ID,
  CORE_ID,
  DECK_ID,
  LEDGER_ID,
  OBS_ID,
  type ActionInput,
  type Cancel,
  type ChatWriteActions,
  type Effect,
  type EventType,
  type GainsLedger,
  type GameModuleDef,
  type InvokeResult,
  type Logger,
  type ModuleContext,
  type ModuleStatus,
  type StatsView,
  type StreamEvent,
} from "@saarathi/shared";
import { chatCommand, type ChatAdapter } from "../chat/adapter.js";
import { deckCommand, type DeckCommands } from "./deck.js";
import { obsBrowserSourceName, obsCommand, type ObsAdapter, type ObsOverlay } from "./obs.js";
import type { StateStore } from "./store.js";
import { ActionRefused } from "./triggers.js";

/** Long enough to batch a burst of chat, short enough to feel instant. */
const PATCH_COALESCE_MS = 60;

const LIFECYCLE_KEY = "lifecycle";

export interface RegistryDeps {
  store: StateStore;
  gains: GainsLedger;
  obs: ObsAdapter;
  /** For her settings only. Events arrive through the kernel, not through here. */
  chat: readonly ChatAdapter[];
  deck: DeckCommands;
  /** The counts, read-only. A core service every module shares, like OBS. */
  stats: StatsView;
  /**
   * Taking a message down and banning who sent it. Passed through untouched,
   * the way `gains` is: `available` has to answer as of now, so the object the
   * write path built is the object a module holds.
   */
  writes: ChatWriteActions;
  log: Logger;
  /**
   * A bot reply, with what it is about: replies about the same command merge
   * into one message. The module names the key; tier is not its to pick.
   */
  say(text: string, key: string): void;
  onPatch(module: string, state: unknown): void;
  onEffect(effect: Effect): void;
  /** Something in the core slice changed, so it needs republishing. */
  onCoreChange(): void;
}

type Handler = (event: never) => void;

interface Runtime {
  def: GameModuleDef;
  state: Record<string, unknown>;
  /** `def.serverOnly` as a set, because it is read on every patch. */
  hidden: Set<string>;
  ctx: ModuleContext<Record<string, unknown>>;
  subs: Map<EventType, Set<Handler>>;
  timers: Set<NodeJS.Timeout>;
  /**
   * Everything else this module holds open on a core service -- a stats
   * subscription today. Same contract as `timers` and `subs`: the module asked
   * for it, the core drops it when the module stops, and no module writes a
   * teardown to undo something the core handed it.
   */
  cancels: Set<Cancel>;
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

  /**
   * Every namespace the core itself writes to the store. Chat adapters are in
   * it because they save her settings under their own name, and the set of
   * adapters is a composition-root decision rather than a constant.
   */
  private readonly reserved: Set<string>;

  constructor(private readonly deps: RegistryDeps) {
    this.reserved = new Set([
      ACCESS_ID,
      CORE_ID,
      LEDGER_ID,
      DECK_ID,
      OBS_ID,
      ...deps.chat.map((adapter) => adapter.name),
    ]);
  }

  register(def: GameModuleDef): void {
    if (this.modules.has(def.id)) throw new Error(`Duplicate module id "${def.id}"`);
    // A module's id is also the key its persisted slice lives under, so an id
    // the core already writes there is not a name clash -- it is one of them
    // overwriting the other's data, silently, on the first save. The ledger
    // and the module that ranks it very nearly shipped as the same key.
    if (this.reserved.has(def.id)) throw new Error(`"${def.id}" is reserved`);

    const state = structuredClone(def.initialState) as Record<string, unknown>;
    for (const [key, value] of Object.entries(this.readPersisted(def))) state[key] = value;

    const lifecycle = this.readLifecycle()[def.id];
    const runtime: Runtime = {
      def,
      state,
      hidden: new Set((def.serverOnly ?? []) as string[]),
      ctx: null as unknown as ModuleContext<Record<string, unknown>>,
      subs: new Map(),
      timers: new Set(),
      cancels: new Set(),
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

  /** Slices an OBS read capability may subscribe to. */
  overlayIds(): string[] {
    return [...this.modules.values()]
      .filter((runtime) => runtime.def.overlay)
      .map((runtime) => runtime.def.id);
  }

  statuses(): ModuleStatus[] {
    return [...this.modules.values()].map((runtime) => ({
      id: runtime.def.id,
      title: runtime.def.title,
      overlay: Boolean(runtime.def.overlay),
      ...(runtime.def.overlay
        ? { browserSourceName: obsBrowserSourceName(runtime.def.title) }
        : {}),
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
      if (!wanted || wanted.has(id)) out[id] = published(runtime);
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
    // Each of these routes itself, and each returns null for an action that is
    // not its own. What an OBS action is called, what a channel id looks like
    // and what a button is made of are knowledge about OBS, about the chat
    // layer and about the deck, and this file is about modules. A fourth of
    // them is an entry in this list.
    const routers = [
      () => obsCommand(this.deps.obs, actionId, input.args, (id) => this.obsOverlay(id)),
      () =>
        chatCommand(this.deps.chat, actionId, input.args)?.then((result) => {
          // Explicitly, rather than leaning on the reconnect a save happens to
          // cause: forgetting a key changes `hasKey` and reconnects nothing.
          this.deps.onCoreChange();
          return result;
        }),
      () => deckCommand(this.deps.deck, actionId, input.args),
    ];
    for (const route of routers) {
      const handled = route();
      if (handled) return handled;
    }

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
        this.deps.onCoreChange();
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
        this.deps.onCoreChange();
        return { ok: true };
      }
      default:
        return { ok: false, reason: `There is no core action "${name}"` };
    }
  }

  private obsOverlay(id: string): ObsOverlay | null {
    const runtime = this.modules.get(id);
    if (!runtime?.def.overlay) return null;
    return {
      id: runtime.def.id,
      title: runtime.def.title,
      sourceName: obsBrowserSourceName(runtime.def.title),
    };
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
    for (const cancel of runtime.cancels) cancel();
    runtime.cancels.clear();
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
        this.persist(runtime);
        // A write that only moved server-only keys has nothing for a client to
        // draw, so it does not become a patch. Every chat message touches the
        // gains roster; without this she gets a patch a message saying exactly
        // what the last one said, on mobile data, in IRL mode.
        if (Object.keys(next).some((key) => !runtime.hidden.has(key))) this.markDirty(runtime);
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
      invoke: (action, input) =>
        this.dispatch(`${def.id}.${action}`, {
          by: "system",
          via: "auto",
          args: [],
          ...input,
        }),
      refuse: (reason): never => {
        throw new ActionRefused(reason);
      },
      gains: this.deps.gains,
      obs: this.deps.obs.actions,
      stats: {
        all: () => this.deps.stats.all(),
        count: (name) => this.deps.stats.count(name),
        stream: () => this.deps.stats.stream(),
        onChange: (fn) => {
          const cancel = this.deps.stats.onChange(fn);
          runtime.cancels.add(cancel);
          return () => {
            runtime.cancels.delete(cancel);
            cancel();
          };
        },
      },
      writes: this.deps.writes,
      after: (ms, fn) => track(setTimeout(fn, ms), false),
      every: (ms, fn) => track(setInterval(fn, ms), true),
      say: (text, key) => this.deps.say(text, key),
      log: this.deps.log,
    };
  }

  // --- publish and persist ---------------------------------------------------

  private markDirty(runtime: Runtime): void {
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
      if (target) this.deps.onPatch(id, published(target));
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

/**
 * The half of a module's state a client is allowed to see.
 *
 * The same object when a module declares nothing private, which is every module
 * but one, so the common path allocates nothing.
 */
function published(runtime: Runtime): unknown {
  if (runtime.hidden.size === 0) return runtime.state;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(runtime.state)) {
    if (!runtime.hidden.has(key)) out[key] = value;
  }
  return out;
}
