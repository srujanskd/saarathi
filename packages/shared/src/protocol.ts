import type { ConnectionStatus, EventType } from "./events.js";
import type { Effect, ModuleStatus } from "./module.js";

/** Reserved module id for the core's own slice. */
export const CORE_ID = "core";

/**
 * What she is allowed to know about the OBS connection. Deliberately not the
 * password: this slice reaches every client, and in IRL mode that is her phone
 * over somebody else's network. `hasPassword` is enough to render the field.
 */
export interface ObsView {
  mode: "auto" | "manual";
  /** Effective values -- what the next connect attempt will actually use. */
  host: string;
  port: number;
  hasPassword: boolean;
  /** True when these came from OBS's own config file rather than from her. */
  detected: boolean;
  /** Transient: OBS tells us on connect, and we forget on disconnect. */
  scenes: string[];
  currentScene: string | null;
}

export interface CoreState {
  startedAt: number;
  /** One entry per external connection, keyed by adapter name: chat, and OBS. */
  connections: Record<string, ConnectionStatus>;
  modules: ModuleStatus[];
  obs: ObsView;
}

export interface Snapshot {
  core: CoreState;
  /** Only the slices this client subscribed to. */
  modules: Record<string, unknown>;
  /**
   * The server's clock when it built this snapshot.
   *
   * Every timestamp downstream of here -- `spin.startedAt` above all -- is
   * server time, and a client is not necessarily on the same machine: `?server=`
   * exists precisely so the server can be a VPS while the page runs on her
   * phone. A client that subtracts its own `Date.now()` from a server timestamp
   * is out by however far the two clocks disagree, which for a phone is
   * routinely tens of seconds and enough to make a six second spin arrive
   * already finished.
   *
   * It rides on the snapshot rather than the patch because the server re-sends
   * a full snapshot on every connect, so a client re-syncs for free exactly
   * when it could have drifted, and a patch does not pay for a timestamp to
   * correct a drift that cannot accumulate inside one spin.
   */
  serverNow: number;
}

export interface Patch {
  /** Module id, or CORE_ID. */
  module: string;
  state: unknown;
}

export type Surface = "overlay" | "control" | "deck";

export interface Hello {
  surface: Surface;
  /** Module ids to subscribe to. Omit for all of them. */
  modules?: string[];
}

export interface MockChatInput {
  author?: string;
  text: string;
  type?: "chat" | "superchat" | "member";
  /** Display amount for superchats, e.g. "$5.00". */
  amount?: string;
}

export type InvokeResult =
  | { ok: true }
  | { ok: false; reason: string; retryInMs?: number };

export interface InvokeRequest {
  /** Fully qualified: "wheel.spin". */
  action: string;
  args?: string[];
}

/**
 * Adding a module adds zero socket events. If you are tempted to add one here,
 * you are probably reaching for state that belongs in a module slice.
 */
export interface ServerToClientEvents {
  snapshot: (snapshot: Snapshot) => void;
  patch: (patch: Patch) => void;
  effect: (effect: Effect) => void;
}

export interface ClientToServerEvents {
  hello: (hello: Hello) => void;
  invoke: (request: InvokeRequest, ack?: (result: InvokeResult) => void) => void;
  mockChat: (input: MockChatInput) => void;
}

export type { EventType };
