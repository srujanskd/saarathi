import { useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import {
  CORE_ID,
  type ClientToServerEvents,
  type CoreState,
  type Effect,
  type InvokeRequest,
  type InvokeResult,
  type MockChatInput,
  type ServerToClientEvents,
  type Surface,
} from "@saarathi/shared";

export type SaarathiSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

export interface ClientState {
  connected: boolean;
  core: CoreState | null;
  /** Only the modules this client said hello about. */
  modules: Record<string, unknown>;
  /**
   * Bot replies, newest first, and only for a client that asked for them.
   * They arrive as effects rather than as state because there is no send path
   * yet, and a missed one is just a missed one. Capped so a flood of refusals
   * cannot grow the page.
   */
  botReplies: string[];
}

export interface Connection {
  subscribe(listener: () => void): () => void;
  getState(): ClientState;
  /**
   * The server's clock, as best this client can tell. Every timestamp in the
   * state is server time, so this is the only `now` worth comparing them to.
   */
  serverNow(): number;
  invoke(request: InvokeRequest): Promise<InvokeResult>;
  /**
   * Effects from the modules this client subscribed to, for the few things a
   * page does rather than draws: the goals overlay plays a chime off one.
   *
   * State is still where anything visible comes from. An effect is missed by a
   * page that was not connected when it fired, which is exactly right for a
   * sound and exactly wrong for a bar -- a browser source reloading mid
   * celebration should rejoin the celebration and not hear the chime again.
   */
  onEffect(listener: (effect: Effect) => void): () => void;
  mockChat(input: MockChatInput): void;
  close(): void;
}

export interface ConnectOptions {
  url: string;
  surface: Surface;
  /** Module ids to subscribe to. An overlay asks for the one it renders and
   * nothing else, so OBS is not paying to receive a chat log it never draws.
   * Omit for every module, which is what her control page wants. */
  modules?: string[];
  /** Keep the bot's replies for a page that shows them. Off by default: an
   * overlay draws none of them, and state nothing renders is state that only
   * has bugs in it. */
  botReplies?: boolean;
}

/** Enough of a refusal history to see what chat just tried, and no more. */
const BOT_REPLY_LIMIT = 8;

/**
 * One socket, one immutable state object, and no game logic.
 *
 * The server is authoritative and re-sends a full snapshot on every connect,
 * so reconnecting is the same code path as connecting: replace everything.
 * That is what makes an OBS browser source reloading mid-stream, or her phone
 * waking up, land in the right state without anyone replaying events at it.
 */
export function connect({ url, surface, modules, botReplies }: ConnectOptions): Connection {
  const socket: SaarathiSocket = io(url, { transports: ["websocket", "polling"] });

  let state: ClientState = { connected: false, core: null, modules: {}, botReplies: [] };
  const listeners = new Set<() => void>();

  /**
   * How far this client's clock is from the server's. Zero until the first
   * snapshot, which is also the only point at which nothing is rendered yet.
   *
   * It is out by roughly the one-way network latency, because the snapshot
   * takes time to arrive -- single-digit milliseconds on her LAN and tens on a
   * VPS, against a spin that lasts six seconds. Clock disagreement between two
   * machines is the thing that is worth tens of seconds, and that is what this
   * removes. It is not React state: nothing renders it, and a render triggered
   * by a clock correction would be a render nobody asked for.
   */
  let offsetMs = 0;

  // A new object every time, because useSyncExternalStore compares by identity
  // and a mutated one would render nothing.
  function set(next: Partial<ClientState>): void {
    state = { ...state, ...next };
    for (const listener of listeners) listener();
  }

  socket.on("connect", () => {
    // Say hello on every connect, not just the first: after a reconnect the
    // server has a brand new socket that is subscribed to everything.
    socket.emit("hello", { surface, modules });
    set({ connected: true });
  });

  socket.on("disconnect", () => set({ connected: false }));

  socket.on("snapshot", (snapshot) => {
    // Before `set`, not after: the render this snapshot causes is the one that
    // draws a spin already in progress, and it has to do that maths against a
    // corrected clock rather than the previous connection's.
    offsetMs = snapshot.serverNow - Date.now();
    set({ core: snapshot.core, modules: snapshot.modules });
  });

  socket.on("patch", (patch) => {
    if (patch.module === CORE_ID) set({ core: patch.state as CoreState });
    else set({ modules: { ...state.modules, [patch.module]: patch.state } });
  });

  const effectListeners = new Set<(effect: Effect) => void>();

  socket.on("effect", (effect) => {
    for (const listener of effectListeners) listener(effect);

    if (!botReplies || effect.module !== CORE_ID || effect.name !== "say") return;
    const text = sayText(effect.payload);
    if (!text) return;
    set({ botReplies: [text, ...state.botReplies].slice(0, BOT_REPLY_LIMIT) });
  });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    getState: () => state,
    serverNow: () => Date.now() + offsetMs,
    onEffect(listener) {
      effectListeners.add(listener);
      return () => void effectListeners.delete(listener);
    },
    invoke(request) {
      if (!socket.connected) {
        return Promise.resolve({ ok: false, reason: "Cannot reach Saarathi" });
      }
      return new Promise((resolve) => {
        socket.emit("invoke", request, (result) => resolve(result));
      });
    },
    mockChat(input) {
      socket.emit("mockChat", input);
    },
    close() {
      listeners.clear();
      socket.close();
    },
  };
}

function sayText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || !("text" in payload)) return null;
  return typeof payload.text === "string" ? payload.text : null;
}

/**
 * The one module slice this page renders, or null until the snapshot lands.
 *
 * The slice is read directly rather than through the whole `ClientState`,
 * because the server broadcasts core patches to every client: an adapter
 * reconnecting would otherwise re-render the wheel mid-spin. A patch replaces
 * the slice object wholesale, so its identity is already stable and
 * `useSyncExternalStore` skips the render on its own.
 */
export function useModuleState<S>(connection: Connection, id: string): S | null {
  const read = () => (connection.getState().modules[id] as S | undefined) ?? null;
  return useSyncExternalStore(connection.subscribe, read, read);
}

/** Whether the socket is up, on its own, for the same reason as above. */
export function useConnected(connection: Connection): boolean {
  const read = () => connection.getState().connected;
  return useSyncExternalStore(connection.subscribe, read, read);
}

/** Core slice: adapter status and the module list the control page renders. */
export function useCoreState(connection: Connection): CoreState | null {
  const read = () => connection.getState().core;
  return useSyncExternalStore(connection.subscribe, read, read);
}

/** What the bot has said back, newest first. Empty unless the page asked for
 * them with `botReplies`. */
export function useBotReplies(connection: Connection): string[] {
  const read = () => connection.getState().botReplies;
  return useSyncExternalStore(connection.subscribe, read, read);
}
