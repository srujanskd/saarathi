import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";

/**
 * The server runs as a child of the tray, not inside it. Three reasons, in
 * the order they bite: a server that throws takes down a window she can see
 * and a tray icon she can click instead of vanishing silently; the server
 * already grew an IPC shutdown handler for exactly this parent, because a
 * signal is not a request on Windows; and a child can be restarted from a
 * menu item without her reinstalling anything.
 *
 * It is spawned as Electron's own binary in Node mode, so the installer ships
 * one runtime rather than two.
 */

export type ServerPhase =
  | "starting"
  | "running"
  | "restarting"
  | "stopped"
  | "port-busy"
  | "failed";

export interface ServerStatus {
  readonly phase: ServerPhase;
  /** One line she can act on. Never a stack trace. */
  readonly detail?: string;
}

export interface SpawnPlan {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string>;
}

export interface ServerPaths {
  /** Electron's own binary, run as Node. */
  readonly execPath: string;
  /** The bundled server, one file, no node_modules beside it. */
  readonly entry: string;
  /** Under userData: the install directory is read-only on Windows. */
  readonly stateFile: string;
  /** The built overlay pages, wherever packaging put them. */
  readonly overlaysDist: string;
  readonly port: number;
  readonly logLevel?: string;
}

/**
 * Everything the shell decides about how the server runs, as data. It is a
 * function rather than four lines inside start() because these four env vars
 * are the entire contract between the shell and the server, and a test that
 * reads them is what stops a rename on either side from shipping.
 */
export function spawnPlan(paths: ServerPaths): SpawnPlan {
  return {
    command: paths.execPath,
    args: [paths.entry],
    env: {
      // Electron's binary is a browser unless told otherwise. This is what
      // makes it a Node runtime, and it is why nothing here ships a second one.
      ELECTRON_RUN_AS_NODE: "1",
      STATE_FILE: paths.stateFile,
      OVERLAYS_DIST: paths.overlaysDist,
      PORT: String(paths.port),
      LOG_LEVEL: paths.logLevel ?? "info",
    },
  };
}

/** Free means free for us: something else already listening is her real dev
 * server or a copy that outlived its tray, and both need saying out loud. */
export async function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(true));
    probe.once("listening", () => probe.close(() => resolve(false)));
    probe.listen(port, "0.0.0.0");
  });
}

export interface ServerProcessOptions extends ServerPaths {
  onStatus(status: ServerStatus): void;
  onLog(line: string): void;
  /** Flat, like every other retry here. Overridable so a test is not slow. */
  retryMs?: number;
}

const HEALTH_TIMEOUT_MS = 30_000;

export class ServerProcess {
  private child: ChildProcess | null = null;
  private retry: NodeJS.Timeout | null = null;
  private stopping = false;
  private generation = 0;
  private readonly retryMs: number;

  constructor(private readonly options: ServerProcessOptions) {
    this.retryMs = options.retryMs ?? 5_000;
  }

  async start(): Promise<void> {
    if (this.child) return;
    this.stopping = false;
    const generation = ++this.generation;
    this.clearRetry();

    if (await portInUse(this.options.port)) {
      // Not a crash and not something a retry fixes on its own, so it gets its
      // own phase: the menu names the port and offers a retry she can press
      // once she has closed whatever is holding it.
      this.options.onStatus({
        phase: "port-busy",
        detail: `Port ${this.options.port} is already in use`,
      });
      return;
    }
    if (generation !== this.generation) return;

    this.options.onStatus({ phase: "starting" });
    const plan = spawnPlan(this.options);
    const child = spawn(plan.command, plan.args, {
      env: { ...process.env, ...plan.env },
      // The fourth slot is the channel shutdown() asks over. Without it a stop
      // on Windows is a kill, and the pending state write dies with it.
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    this.child = child;

    const recent: string[] = [];
    const take = (data: unknown) => {
      const text = String(data);
      this.options.onLog(text);
      recent.push(text);
      if (recent.length > 20) recent.shift();
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);

    child.once("exit", (code) => {
      if (generation !== this.generation) return;
      this.child = null;
      if (this.stopping) {
        this.options.onStatus({ phase: "stopped" });
        return;
      }
      this.options.onStatus({
        phase: "restarting",
        detail: lastError(recent) ?? `Server stopped unexpectedly (code ${code ?? "unknown"})`,
      });
      this.retry = setTimeout(() => void this.start(), this.retryMs);
    });

    void this.awaitHealth(generation);
  }

  /**
   * Listening is the only thing that means "running". The process being alive
   * does not: it may be four seconds from an EADDRINUSE, and a tray that says
   * Running while OBS cannot connect is worse than one that says nothing.
   */
  private async awaitHealth(generation: number): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (generation !== this.generation || this.stopping) return;
      if (!this.child) return;
      try {
        const response = await fetch(`http://127.0.0.1:${this.options.port}/health`);
        if (response.ok) {
          if (generation === this.generation) this.options.onStatus({ phase: "running" });
          return;
        }
      } catch {
        // Not up yet.
      }
      await delay(150);
    }
    if (generation === this.generation) {
      this.options.onStatus({ phase: "failed", detail: "Server never finished starting" });
    }
  }

  /** Stop and start again, on purpose, from the menu. */
  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    this.generation++;
    this.stopping = true;
    this.clearRetry();
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode) {
      this.options.onStatus({ phase: "stopped" });
      return;
    }
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // Ask first: kernel.stop() flushes the store, and a kill loses whatever
    // the debounce was still holding -- her challenge list, her deck.
    if (child.connected) child.send({ type: "shutdown" });
    else child.kill("SIGTERM");
    const forced = setTimeout(() => child.kill("SIGKILL"), 5_000);
    await exited;
    clearTimeout(forced);
    this.options.onStatus({ phase: "stopped" });
  }

  private clearRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
  }
}

/**
 * The one line worth showing her out of everything the server printed. Pino
 * writes JSON, so a raw tail is unreadable; this pulls the message out and
 * falls back to the raw line rather than to nothing.
 */
export function lastError(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const raw of lines[i]!.split("\n").reverse()) {
      const line = raw.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        if (typeof parsed === "object" && parsed !== null) {
          const record = parsed as { level?: unknown; msg?: unknown; err?: { message?: unknown } };
          const message =
            typeof record.msg === "string"
              ? record.msg
              : typeof record.err?.message === "string"
                ? record.err.message
                : null;
          // 50 is pino's error level. Anything quieter is not why it exited.
          if (message && typeof record.level === "number" && record.level >= 50) return message;
        }
      } catch {
        if (line.includes("Error") || line.includes("error")) return line.slice(0, 200);
      }
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
