import type { ConnectionStatus, EventType } from "./events.js";
import type { Effect, ModuleStatus } from "./module.js";

/** Reserved module id for the core's own slice. */
export const CORE_ID = "core";

export interface CoreState {
  startedAt: number;
  /** One entry per chat adapter, keyed by adapter name. */
  connections: Record<string, ConnectionStatus>;
  modules: ModuleStatus[];
}

export interface Snapshot {
  core: CoreState;
  /** Only the slices this client subscribed to. */
  modules: Record<string, unknown>;
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
