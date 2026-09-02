import {
  CORE_ID,
  type ActionInput,
  type Cancel,
  type ConnectionStatus,
  type CoreState,
  type Effect,
  type GameModuleDef,
  type InvokeResult,
  type Logger,
  type MockChatInput,
  type ObsView,
  type Snapshot,
  type StreamEvent,
} from "@saarathi/shared";
import { chatViews, type ChatAdapter, type ChatSink } from "../chat/adapter.js";
import { MockChatAdapter } from "../chat/mock.js";
import { Deck } from "./deck.js";
import { Gains } from "./gains.js";
import type { ObsAdapter } from "./obs.js";
import { Registry } from "./registry.js";
import { Stats } from "./stats.js";
import type { StateStore } from "./store.js";
import { CommandGate, parseCommand } from "./triggers.js";
import { ChatWriter, WriteMeter, type SayTier } from "./writes.js";

export interface KernelDeps {
  modules: GameModuleDef[];
  chat: ChatAdapter[];
  store: StateStore;
  obs: ObsAdapter;
  log: Logger;
}

/**
 * Wires the registry, the trigger gate and the chat adapters together.
 *
 * It takes its dependencies rather than building them, so a headless run boots
 * with mock chat, a memory store and a no-op OBS and drives the entire pipeline
 * through the same interface the real server uses.
 */
export class Kernel {
  readonly registry: Registry;
  private readonly gains: Gains;
  private readonly deck: Deck;
  private readonly stats: Stats;
  private readonly gate: CommandGate;
  private readonly writer: ChatWriter;
  private readonly mock?: MockChatAdapter;
  private readonly connections: Record<string, ConnectionStatus> = {};
  private obsView: ObsView;
  private readonly startedAt = Date.now();
  private readonly patchListeners = new Set<(module: string, state: unknown) => void>();
  private readonly effectListeners = new Set<(effect: Effect) => void>();

  constructor(private readonly deps: KernelDeps) {
    this.gains = new Gains(deps.store, deps.log);
    this.deck = new Deck(deps.store, deps.log, () => this.emitPatch(CORE_ID, this.coreState()));
    this.obsView = deps.obs.view();
    this.stats = new Stats(deps.chat, deps.log, () =>
      this.emitPatch(CORE_ID, this.coreState()),
    );
    this.gate = new CommandGate(this.gains);
    this.writer = new ChatWriter(
      deps.chat,
      new WriteMeter(deps.store, deps.log),
      deps.log,
      () =>
        deps.chat.some(
          (adapter) =>
            !adapter.standIn && this.connections[adapter.name]?.state === "connected",
        ),
    );
    this.mock = deps.chat.find((adapter): adapter is MockChatAdapter => adapter instanceof MockChatAdapter);

    this.registry = new Registry({
      store: deps.store,
      gains: this.gains,
      obs: deps.obs,
      chat: deps.chat,
      deck: this.deck,
      stats: this.stats.forModules(),
      log: deps.log,
      say: (text, key) => this.say(text, "info", key),
      onPatch: (module, state) => this.emitPatch(module, state),
      onEffect: (effect) => this.emitEffect(effect),
      onCoreChange: () => this.emitPatch(CORE_ID, this.coreState()),
    });

    for (const module of deps.modules) this.registry.register(module);

    for (const adapter of [...deps.chat, deps.obs]) {
      this.connections[adapter.name] = { state: "disconnected", detail: "Not started" };
    }
  }

  async start(): Promise<void> {
    await this.registry.start();
    for (const adapter of this.deps.chat) {
      const sink: ChatSink = {
        event: (event) => this.handleEvent(event),
        status: (status) => this.setConnection(adapter.name, status),
      };
      try {
        await adapter.start(sink);
      } catch (err) {
        this.setConnection(adapter.name, { state: "error", detail: String(err) });
      }
    }

    // After the adapters are started, never before: an adapter learns what it
    // can answer with by connecting -- YouTube only finds out which video is
    // live when its chat reader does -- so polling first would ask every one of
    // them a question none of them can answer yet.
    this.stats.start();

    // After the chat adapters, so a slow OBS handshake never delays chat: the
    // stream is happening either way, and OBS retries on its own.
    try {
      await this.deps.obs.start({
        status: (status) => this.setConnection(this.deps.obs.name, status),
        view: (view) => {
          this.obsView = view;
          this.emitPatch(CORE_ID, this.coreState());
        },
      });
    } catch (err) {
      this.setConnection(this.deps.obs.name, { state: "error", detail: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.stats.stop();
    this.writer.stop();
    for (const adapter of this.deps.chat) await adapter.stop().catch(() => {});
    await this.deps.obs.stop().catch(() => {});
    await this.registry.stop();
    this.deps.store.flush();
  }

  // --- what clients see -----------------------------------------------------

  coreState(): CoreState {
    return {
      startedAt: this.startedAt,
      connections: { ...this.connections },
      modules: this.registry.statuses(),
      obs: this.obsView,
      deck: this.deck.view(),
      stats: this.stats.snapshot(),
      chat: chatViews(this.deps.chat),
      writes: this.writer.view(),
    };
  }

  /**
   * `serverNow` is stamped here rather than where the snapshot is emitted, so
   * the socket and `/api/state` cannot disagree about what the server's clock
   * said. See `Snapshot.serverNow` for why a client needs it at all.
   */
  snapshot(moduleIds?: string[]): Snapshot {
    return {
      core: this.coreState(),
      modules: this.registry.snapshot(moduleIds),
      serverNow: Date.now(),
    };
  }

  onPatch(listener: (module: string, state: unknown) => void): Cancel {
    this.patchListeners.add(listener);
    return () => this.patchListeners.delete(listener);
  }

  onEffect(listener: (effect: Effect) => void): Cancel {
    this.effectListeners.add(listener);
    return () => this.effectListeners.delete(listener);
  }

  // --- triggers -------------------------------------------------------------

  /** Her own surfaces: the control page, the deck, a hotkey. She is in charge, so no gate. */
  invoke(action: string, input?: Partial<ActionInput>): Promise<InvokeResult> {
    return this.registry.dispatch(action, {
      by: "streamer",
      via: "control",
      args: [],
      ...input,
    });
  }

  sendMockChat(input: MockChatInput): void {
    this.mock?.send(input);
  }

  private handleEvent(incoming: StreamEvent): void {
    let event = incoming;

    // A command is not also a plain message: promoting it here means a module
    // subscribing to chat-message never has to filter "!" out itself, and the
    // chat log shows each line exactly once.
    if (event.type === "chat-message") {
      const parsed = parseCommand(event.text);
      if (parsed) {
        event = { ...event, type: "chat-command", command: parsed.command, args: parsed.args };
      }
    }

    this.registry.handleEvent(event);
    if (event.type === "chat-command") void this.runCommand(event);
  }

  private async runCommand(event: Extract<StreamEvent, { type: "chat-command" }>): Promise<void> {
    const found = this.registry.findCommand(event.command);
    if (!found) return;

    const key = `${found.moduleId}.${found.spec.name}`;
    const gate = this.gate.consume(key, found.spec, event.author, event.at);
    if (!gate.ok) {
      this.deps.log.info(`!${event.command} from ${event.author.name} refused: ${gate.reason}`);
      this.say(`@${event.author.name} ${gate.reason}`, "refusal", key);
      return;
    }

    const result = await this.registry.dispatch(`${found.moduleId}.${found.spec.action}`, {
      by: event.author.name,
      // The gate says which trigger this is, not this line: it is the thing
      // that charged, so a priced command arrives downstream as "gains" and
      // there is no second place that decision can drift out of step.
      via: gate.via,
      // And what it took, for the same reason: a module that accepts this
      // trigger without running it now owes the refund, and cannot work out
      // what to give back on its own.
      charge: gate.charge,
      args: event.args,
      event,
    });

    if (!result.ok) {
      // The trigger did not happen, so it costs nothing: the cooldown it
      // stamped and the gains it debited both go back.
      gate.release();
      this.say(`@${event.author.name} ${result.reason}`, "refusal", key);
    }
  }

  // --- plumbing -------------------------------------------------------------

  private setConnection(name: string, status: ConnectionStatus): void {
    this.connections[name] = status;
    this.deps.log.info(`${name}: ${status.state} — ${status.detail}`);
    this.emitPatch(CORE_ID, this.coreState());
  }

  /**
   * A bot reply, said twice: to the log and her control page as an effect, and
   * to chat itself when an adapter can write and the budget allows it.
   *
   * Additive rather than a mode switch, and that is the load-bearing part. A
   * dev run with mock chat, CI, a VPS with no grant and a grant that was
   * revoked ten minutes ago all behave exactly as they did before the write
   * path existed, because the surface she reads refusals on is the one that
   * never depended on Google. What chat gets is the extra.
   */
  private say(text: string, tier: SayTier, key: string): void {
    this.deps.log.info(`say: ${text}`);
    this.emitEffect({ module: CORE_ID, name: "say", payload: { text } });
    this.writer.say({ text, tier, key });
  }

  private emitPatch(module: string, state: unknown): void {
    for (const listener of this.patchListeners) listener(module, state);
  }

  private emitEffect(effect: Effect): void {
    for (const listener of this.effectListeners) listener(effect);
  }
}

export function createKernel(deps: KernelDeps): Kernel {
  return new Kernel(deps);
}
