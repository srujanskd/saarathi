import type { Author, EventOf, EventType, StreamEvent } from "./events.js";
import type { ChannelStats, InvokeResult, StatCounts } from "./protocol.js";

/** How an action was triggered. Every trigger converges on the same action. */
export type TriggerVia =
  | "chat"
  | "paid"
  | "gains"
  | "deck"
  // Her deck too, pressed by a key on the PC rather than a finger on a screen.
  // Separate so the history can tell her which, the way "deck" is separate
  // from "control".
  | "hotkey"
  | "control"
  // An overlay renders and does not decide, so nothing should send this. It
  // exists so that if one ever does, the history says so instead of quietly
  // filing it under the control page.
  | "overlay"
  | "auto";

/**
 * Gains the core took for a trigger, and who to give them back to.
 *
 * Data rather than a callback because a module may accept a paid trigger and
 * hold it -- the wheel queues one behind a busy spin -- and a queue that
 * survives a restart cannot store a closure. Whoever holds the charge owes the
 * refund, so this travels with the thing that was paid for.
 */
export interface Charge {
  userId: string;
  amount: number;
}

export interface ActionInput {
  /** Display name of whoever caused this, or "streamer" for her own surfaces. */
  by: string;
  via: TriggerVia;
  args: string[];
  /** Present when a platform event triggered the action. */
  event?: StreamEvent;
  /**
   * What the gate charged for this trigger, when it charged anything.
   *
   * The core gives it back itself if the action refuses, so a module needs this
   * only when it *accepts* a paid trigger without running it yet: from that
   * moment the charge is the module's to return. Absent on every free trigger,
   * including all of hers.
   */
  charge?: Charge;
}

/**
 * One thing a module can do. Actions are the only unit of behaviour the core
 * dispatches, so a chat command, a paid event, a deck button, a hotkey and the
 * control page all land in the same `run`. There is no second code path.
 */
export interface ActionSpec<S = unknown> {
  /** Button label on the deck and the control page. */
  label: string;
  /**
   * This action takes positional arguments, so no grid may offer it as a plain
   * button. `ModuleStatus.actions` is what the deck picker and the control
   * page press with none, and a button that saved `args: []` for an action
   * that needed one is a refusal she meets by pressing it.
   *
   * Still invocable by id, from whichever card knows what to pass it -- the
   * challenge editor, the OBS card's scene list. That is what keeps a free
   * text args box, which is the no-terminal rule in a different costume, out
   * of the app.
   */
  needsArgs?: boolean;
  run(input: ActionInput, ctx: ModuleContext<S>): void | Promise<void>;
}

/**
 * A chat command bound to an action. Cooldown, price and permission are data:
 * the core enforces them before dispatch, so no module ever writes a cooldown
 * check. A cooldown belongs to one viewer on one binding -- patience is per
 * viewer the same way a balance is -- so it never lets one person lock the rest
 * of chat out, and a paid event invoking the same action is not rate-limited by
 * it at all.
 */
export interface CommandSpec {
  /** Without "!", lowercase. */
  name: string;
  /** Action id within the same module. */
  action: string;
  cooldownMs?: number;
  /** Price in gains. Debited before dispatch, refunded if the action throws. */
  cost?: number;
  allow?: "everyone" | "members" | "mods" | "streamer";
  /** One line she or chat can read when the command is rejected. */
  help?: string;
}

/** One-shot, advisory. If a client missed it, nothing is broken. */
export interface Effect {
  module: string;
  name: string;
  payload?: unknown;
}

export interface GainsLedger {
  balance(userId: string): number;
  grant(userId: string, amount: number, reason: string): number;
  /** False when they cannot afford it; no partial spends. */
  spend(userId: string, amount: number, reason: string): boolean;
}

/**
 * The counts, read-only.
 *
 * A core service no module owns, on the same footing as `obs` and `gains`: the
 * poll belongs to the core, every module may read what it found, and none of
 * them may write it. It is deliberately not on the event bus. That bus carries
 * the four normalized platform events -- things that *happened* -- and a poll
 * landing is not one of them; a subscriber count has no moment, only a value
 * that reads differently next time somebody asks.
 *
 * Which adapter answers is the core's business, not the module's. She streams
 * one platform at a time, and mock chat -- registered beside the real one on
 * every run -- answers only when nothing real can, so a goal cannot end up
 * quietly rendering test numbers on her stream.
 */
export interface StatsView {
  /** Every adapter's counts, keyed by adapter name, as the core slice has them. */
  all(): Record<string, ChannelStats>;
  /** The count as the best-placed adapter has it, or undefined if none has one. */
  count(name: keyof StatCounts): number | undefined;
  /** The stream those counts belong to. See `ChannelStats.stream`. */
  stream(): string | undefined;
  /**
   * A poll landed and something moved. Cancelled for you when the module stops,
   * exactly as its timers and its event subscriptions are.
   */
  onChange(fn: () => void): Cancel;
}

/**
 * Writing back to the platform, past what the bot says.
 *
 * A core service no module owns, on the same footing as `obs` and `stats`: the
 * grant is hers, the budget is one allowance, and the core decides which
 * adapter a write goes through. Named after what it does rather than after the
 * one module using it today -- a delete is a platform capability, not a
 * moderation feature, and a core surface called `moderation` would be the
 * wheel-shaped hook this contract exists to avoid.
 *
 * Deliberately separate from `say`, which is the same three adapter calls'
 * third sibling, because the two differ in kind rather than in degree. A reply
 * is advisory: it is tiered, merged on a window, dropped when the budget is
 * spent, and always additive -- her control page has already rendered it, so
 * `say` returns nothing and cannot fail in a way anyone needs to hear about.
 * These two are the opposite. There is no second surface that shows her the
 * message going away, they are never queued or merged, and whether one
 * happened is the only thing she actually wants to know -- so they answer, in
 * the same shape every other refusal in this app arrives in.
 */
/**
 * What she is told when nothing can write yet.
 *
 * One sentence and not one per caller: the core refuses with it when a write
 * is attempted with no adapter behind it, and a module refuses with it when it
 * checked `available` first. Two wordings for one condition is two sentences
 * to keep in step, and the one that drifts is the one she reads.
 */
export const NO_WRITER = "Nothing is signed in that can do that yet";

export interface ChatWriteActions {
  /**
   * Whether anything can write right now.
   *
   * Read at the moment of use and never cached, because it changes underneath
   * a running module: a grant is revoked, a token expires, an adapter connects.
   * It is what her queue renders the difference on -- a button that cannot work
   * is not offered, rather than offered and refused when she presses it.
   */
  readonly available: boolean;
  /**
   * Take one message down, named by the platform's own id for it.
   *
   * The caller has to have one. `ModFlag.messageId` is null on every adapter
   * that does not hand them out, and there is nothing this can do with that.
   */
  removeMessage(messageId: string): Promise<InvokeResult>;
  /** Ban an account from her chat, named by the author id events carry. */
  banAuthor(authorId: string): Promise<InvokeResult>;
}

export interface ObsActions {
  readonly connected: boolean;
  setScene(name: string): Promise<void>;
  setSourceVisible(scene: string, source: string, visible: boolean): Promise<void>;
}

export type Cancel = () => void;

export interface Logger {
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

/**
 * Everything a module gets from the core. `setState` is the only write path:
 * the core coalesces broadcasts and persists the declared keys, so a module
 * never touches a socket, a file, or a save timer.
 */
export interface ModuleContext<S> {
  readonly id: string;
  readonly state: Readonly<S>;
  /** True when the module is not using arming, or is armed. */
  readonly armed: boolean;
  setState(patch: Partial<S> | ((state: Readonly<S>) => Partial<S>)): void;
  on<T extends EventType>(type: T, handler: (event: EventOf<T>) => void): Cancel;
  effect(effect: { name: string; payload?: unknown }): void;
  /**
   * Trigger one of this module's own actions.
   *
   * It answers with the result rather than swallowing it, because a module that
   * hands a deferred trigger back to itself has to know whether it ran: if it
   * did not, the module is still holding somebody's `charge`.
   */
  invoke(action: string, input?: Partial<ActionInput>): Promise<InvokeResult>;
  /**
   * Refuse the action in progress with a reason chat and the control page can
   * read. The core refunds any gains it debited and clears the cooldown the
   * command binding just stamped, so a refused trigger costs the viewer nothing.
   */
  refuse(reason: string): never;
  gains: GainsLedger;
  obs: ObsActions;
  stats: StatsView;
  /**
   * Taking a message down, and banning who sent it. See `ChatWriteActions`,
   * and note that it is not where `say` lives.
   */
  writes: ChatWriteActions;
  /** Timers are cancelled for you when the module stops. */
  after(ms: number, fn: () => void): Cancel;
  every(ms: number, fn: () => void): Cancel;
  /**
   * A bot reply. The effect her control page renders always fires; chat hears
   * it too when an adapter can write and the budget allows it.
   *
   * `key` is what this reply is about — a command binding, an action id — so
   * replies about the same thing merge on one window and a balance does not
   * share a sentence with a refusal. Tier is not this module's to pick.
   */
  say(text: string, key: string): void;
  log: Logger;
}

/**
 * `S` defaults to `any`, not `unknown`, and this is the second and last place
 * `any` is allowed. The core holds modules in one heterogeneous list, so it
 * names this type unparameterised; with `unknown`, `keyof S` is `never` and a
 * module that persists its own keys stops being assignable to its own
 * interface. The alternative is a cast at every registration site, which moves
 * the same hole somewhere it is harder to see.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface GameModuleDef<S = any> {
  /** Namespaces state, actions, the overlay route and the persisted slice. */
  id: string;
  /** Heading on her control page. */
  title: string;
  /**
   * This slice may be read by an OBS browser source holding the read-only
   * capability. Omitted means control clients only. The server owns this
   * decision because trusting a client-supplied module id would let an overlay
   * URL read the moderation queue by changing one query parameter.
   */
  overlay?: boolean;
  initialState: S;
  /**
   * Keys that survive a restart. Everything else is transient by default, so
   * every new field forces the durable-or-not decision at the point it is added.
   */
  persist?: (keyof S)[];
  /**
   * Keys the core never sends to a client -- not in a snapshot, not in a patch.
   *
   * Module state otherwise rides whole in every snapshot and every patch, which
   * is right for a wheel and wrong for anything keyed by viewer: a roster is
   * unbounded, it is her chat's names, and in IRL mode it goes down her phone's
   * mobile data once a minute for nothing. So a module keeps the working set
   * server-side and publishes the small derived thing a page actually draws.
   *
   * Orthogonal to `persist`. A key can be durable and private, which is the
   * usual case for anything like this, or either alone.
   */
  serverOnly?: (keyof S)[];
  /** Opt in to arm/disarm. Modules without it are always considered armed. */
  arming?: boolean;
  commands?: CommandSpec[];
  actions: Record<string, ActionSpec<S>>;
  setup?(ctx: ModuleContext<S>): void | Promise<void>;
  teardown?(ctx: ModuleContext<S>): void | Promise<void>;
}

/** Per-module lifecycle the core owns. Both flags are reversible and persisted. */
export interface ModuleStatus {
  id: string;
  title: string;
  /** Whether OBS may subscribe to this module's state and render its overlay. */
  overlay: boolean;
  enabled: boolean;
  /** Always true for modules that did not opt into arming. */
  armed: boolean;
  arming: boolean;
  actions: { id: string; label: string }[];
  commands: { name: string; action: string; cooldownMs?: number; cost?: number }[];
}

export type { Author };
