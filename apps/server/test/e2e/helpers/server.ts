import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { io, type Socket } from "socket.io-client";
import { LEDGER_ID } from "@saarathi/shared";
import { mockAuthorId } from "../../../src/chat/mock.js";
import { STATE_VERSION } from "../../../src/core/store.js";
import type {
  ClientToServerEvents,
  Hello,
  InvokeRequest,
  InvokeResult,
  MockChatInput,
  ServerToClientEvents,
  Snapshot,
} from "@saarathi/shared";

export type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** A port the OS just told us is free. Never her 4400. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "object" && address) {
        const { port } = address;
        probe.close(() => resolve(port));
      } else {
        probe.close(() => reject(new Error("no port")));
      }
    });
  });
}

// fileURLToPath, not .pathname: on Windows that gives back "/C:/..." and
// spawn cannot use it. She runs this on Windows, and so does CI.
const SERVER_ENTRY = fileURLToPath(new URL("../../../src/main.ts", import.meta.url));
const SERVER_CWD = fileURLToPath(new URL("../../../", import.meta.url));

export interface RunningServer {
  readonly port: number;
  readonly origin: string;
  /** The state file this run was given. Reuse it to prove a restart. */
  readonly stateFile: string;
  /** The directory holding it, if this run created one. */
  readonly stateDir: string | null;
  readonly controlToken: string;
  readonly overlayToken: string;
  readonly pairingCode: string;
  /** Everything the server printed, for diagnosing a failed boot. */
  output(): string;
  get(path: string): Promise<unknown>;
  raw(path: string, init?: RequestInit): Promise<Response>;
  post(path: string, body: unknown): Promise<unknown>;
  mockChat(input: MockChatInput): Promise<unknown>;
  invoke(request: InvokeRequest): Promise<InvokeResult>;
  connect(hello?: Hello, access?: "control" | "read" | "none"): Promise<Client>;
  /**
   * Stops the process. Pass keepState when a second run is about to boot on the
   * same file, and clean the directory up yourself afterwards.
   */
  stop(options?: { keepState?: boolean }): Promise<void>;
}

export interface Client {
  socket: TestSocket;
  /** The snapshot this client was handed on connect, or after its hello. */
  snapshots: Snapshot[];
  patches: { module: string; state: unknown }[];
  effects: { module: string; name: string; payload?: unknown }[];
  /** Resolve once a condition over what arrived holds, or fail loudly. */
  waitFor(label: string, predicate: (client: Client) => boolean, timeoutMs?: number): Promise<void>;
  latest(module: string): unknown;
  /** Invoke over the socket and wait for the server's ack. */
  invoke(request: InvokeRequest): Promise<InvokeResult>;
  clear(): void;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Point a second run at the first one's file to test a restart. */
  stateFile?: string;
  env?: Record<string, string>;
  /**
   * Ledger balances to boot with, keyed by the name the viewer chats under.
   *
   * A priced command -- !spin is one -- is refused at the gate on an empty
   * ledger, and every viewer starts empty, so a spec that drives one through
   * chat says here who can afford it. Written into the state file before the
   * process starts, which is the only way in: the server owns the ledger and
   * there is no endpoint that hands out gains.
   */
  balances?: Record<string, number>;
}

interface StateDocument {
  version?: number;
  namespaces?: Record<string, Record<string, unknown>>;
}

/**
 * Put balances in a state file the server has not opened yet.
 *
 * It merges rather than overwrites so a restart spec can seed a run whose file
 * already holds what the first run persisted.
 */
function seedBalances(file: string, balances: Record<string, number>): void {
  const doc: StateDocument = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf-8")) as StateDocument)
    : {};
  const namespaces = doc.namespaces ?? {};
  const saved = (namespaces[LEDGER_ID]?.balances ?? {}) as Record<string, number>;
  const seeded = Object.fromEntries(
    Object.entries(balances).map(([name, amount]) => [mockAuthorId(name), amount]),
  );
  namespaces[LEDGER_ID] = { balances: { ...saved, ...seeded } };
  // The store's own version, not a literal: a file stamped with the wrong one
  // is a migration the server would run, or refuse, for no reason.
  writeFileSync(file, JSON.stringify({ version: doc.version ?? STATE_VERSION, namespaces }));
}

/**
 * Boots the real server the way she runs it, on a port the OS handed us and
 * with STATE_FILE in a temp directory. Nothing here may touch her data/.
 */
export async function startServer(options: StartOptions = {}): Promise<RunningServer> {
  const port = await freePort();
  const owned = !options.stateFile;
  const dir = owned ? mkdtempSync(join(tmpdir(), "saarathi-e2e-")) : null;
  const stateFile = options.stateFile ?? join(dir!, "state.json");
  if (options.balances) seedBalances(stateFile, options.balances);

  const child: ChildProcess = spawn(
    process.execPath,
    ["--import", "tsx", SERVER_ENTRY],
    {
      cwd: SERVER_CWD,
      env: {
        ...process.env,
        ...options.env,
        // After options.env, not before: a test may point the server at a
        // different overlays directory or turn the log up, but the port and
        // the state file belong to this helper. Rule 2 -- nothing here gets to
        // aim a server at her data/.
        PORT: String(port),
        STATE_FILE: stateFile,
        LOG_LEVEL: "warn",
        // Never the real adapter: it would go looking for her live stream.
        YT_CHANNEL_ID: "",
        YT_LIVE_ID: "",
        // Same reason, one machine closer to home: autodetect would read the
        // real OBS settings of whoever is running the suite and connect to
        // their OBS mid-test. Blank switches it off. A test that wants the
        // autodetect path writes its own config file and names it here.
        OBS_CONFIG: options.env?.OBS_CONFIG ?? "",
      },
      // The fourth slot is the IPC channel stop() asks over, because on
      // Windows a signal is not a request.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );

  const chunks: string[] = [];
  child.stdout?.on("data", (data) => void chunks.push(String(data)));
  child.stderr?.on("data", (data) => void chunks.push(String(data)));

  const origin = `http://127.0.0.1:${port}`;
  const output = () => chunks.join("");
  const clients: Client[] = [];

  await waitForHealth(origin, child, output);

  const localResponse = await fetch(`${origin}/api/access/local`);
  if (!localResponse.ok) throw new Error(`local access -> ${localResponse.status}`);
  const local = (await localResponse.json()) as {
    controlToken: string;
    overlayToken: string;
    pairing: { code: string };
  };

  const request = async (path: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${local.controlToken}`);
    const response = await fetch(`${origin}${path}`, { ...init, headers });
    if (!response.ok) throw new Error(`${path} -> ${response.status}`);
    return response.json();
  };

  return {
    port,
    origin,
    stateFile,
    stateDir: dir,
    controlToken: local.controlToken,
    overlayToken: local.overlayToken,
    pairingCode: local.pairing.code,
    output,
    get: (path) => request(path),
    raw: (path, init) => fetch(`${origin}${path}`, init),
    post: (path, body) =>
      request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    mockChat(input) {
      return request("/api/mock-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
    },
    invoke(req) {
      return request("/api/invoke", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(req),
      }) as Promise<InvokeResult>;
    },
    async connect(hello, level = "control") {
      const token = level === "control" ? local.controlToken : level === "read" ? local.overlayToken : "";
      const client = await connectClient(origin, token, hello);
      clients.push(client);
      return client;
    },
    async stop(options) {
      for (const client of clients) await client.close();
      await stopChild(child);
      // Only the directory this run created, and only when nothing else is
      // about to read it. See rule 2: her state file is never ours to touch.
      if (dir && !options?.keepState) rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function waitForHealth(
  origin: string,
  child: ChildProcess,
  output: () => string,
): Promise<void> {
  const deadline = Date.now() + 20_000;
  let exited = false;
  child.once("exit", () => void (exited = true));

  while (Date.now() < deadline) {
    if (exited) throw new Error(`server exited before it listened:\n${output()}`);
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server never answered /health:\n${output()}`);
}

/** Kill only the PID we spawned. Never by pattern -- see rule 1. */
async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  // Ask over IPC first. SIGTERM never reaches a Node process on Windows, so a
  // run that relied on it would lose the state a restart test is about to
  // assert on. SIGKILL stays as the backstop for a server that ignores both.
  if (child.connected) child.send({ type: "shutdown" });
  else child.kill("SIGTERM");
  const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await exited;
  clearTimeout(forced);
}

async function connectClient(origin: string, token: string, hello?: Hello): Promise<Client> {
  const socket: TestSocket = io(origin, {
    auth: { token },
    transports: ["websocket"],
    forceNew: true,
    reconnection: false,
  });

  const client: Client = {
    socket,
    snapshots: [],
    patches: [],
    effects: [],
    waitFor(label, predicate, timeoutMs = 5_000) {
      return waitFor(label, () => predicate(client), timeoutMs);
    },
    latest(module) {
      for (let i = client.patches.length - 1; i >= 0; i--) {
        if (client.patches[i]!.module === module) return client.patches[i]!.state;
      }
      const snapshot = client.snapshots.at(-1);
      return module === "core" ? snapshot?.core : snapshot?.modules[module];
    },
    invoke(request) {
      return new Promise<InvokeResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no ack for ${request.action}`)), 5_000);
        socket.emit("invoke", request, (result) => {
          clearTimeout(timer);
          resolve(result);
        });
      });
    },
    clear() {
      client.snapshots.length = 0;
      client.patches.length = 0;
      client.effects.length = 0;
    },
    async close() {
      if (socket.connected) socket.disconnect();
      socket.close();
    },
  };

  socket.on("snapshot", (snapshot) => void client.snapshots.push(snapshot));
  socket.on("patch", (patch) => void client.patches.push(patch));
  socket.on("effect", (effect) => void client.effects.push(effect));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("socket never connected")), 10_000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });

  // The server sends a snapshot the moment a client connects, whether or not it
  // ever says hello. A hello then earns a second one, scoped to what it asked
  // for, so wait for that rather than racing the first.
  await client.waitFor("connect snapshot", (c) => c.snapshots.length > 0);
  if (hello) {
    socket.emit("hello", hello);
    await client.waitFor("hello snapshot", (c) => c.snapshots.length > 1);
  }
  return client;
}

/** Poll a predicate rather than sleeping, so a fast machine is not punished. */
export async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}
