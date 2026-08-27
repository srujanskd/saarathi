import type { Author, EventOf, EventType, StreamEvent } from "./events.js";

/** How an action was triggered. Every trigger converges on the same action. */
export type TriggerVia = "chat" | "paid" | "gains" | "deck" | "control" | "auto";

export interface ActionInput {
  /** Display name of whoever caused this, or "streamer" for her own surfaces. */
  by: string;
  via: TriggerVia;
  args: string[];
  /** Present when a platform event triggered the action. */
  event?: StreamEvent;
}

/**
 * One thing a module can do. Actions are the only unit of behaviour the core
 * dispatches, so a chat command, a paid event, a deck button, a hotkey and the
 * control page all land in the same `run`. There is no second code path.
 */
export interface ActionSpec<S = unknown> {
  /** Button label on the deck and the control page. */
  label: string;
  /** Hide from the deck/control grids; still invocable by id. */
  hidden?: boolean;
  run(input: ActionInput, ctx: ModuleContext<S>): void | Promise<void>;
}

/**
 * A chat command bound to an action. Cooldown, price and permission are data:
 * the core enforces them before dispatch, so no module ever writes a cooldown
 * check. A cooldown belongs to the binding, not the action, which is why a paid
 * event that invokes the same action is not rate-limited by it.
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
  /** Trigger one of this module's own actions. */
  invoke(action: string, input?: Partial<ActionInput>): Promise<void>;
  /**
   * Refuse the action in progress with a reason chat and the control page can
   * read. The core refunds any gains it debited and clears the cooldown the
   * command binding just stamped, so a refused trigger costs the viewer nothing.
   */
  refuse(reason: string): never;
  gains: GainsLedger;
  obs: ObsActions;
  /** Timers are cancelled for you when the module stops. */
  after(ms: number, fn: () => void): Cancel;
  every(ms: number, fn: () => void): Cancel;
  /** Bot reply. Platform-agnostic; a no-op until the send path exists. */
  say(text: string): void;
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
  initialState: S;
  /**
   * Keys that survive a restart. Everything else is transient by default, so
   * every new field forces the durable-or-not decision at the point it is added.
   */
  persist?: (keyof S)[];
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
  enabled: boolean;
  /** Always true for modules that did not opt into arming. */
  armed: boolean;
  arming: boolean;
  actions: { id: string; label: string }[];
  commands: { name: string; action: string; cooldownMs?: number; cost?: number }[];
}

export type { Author };
