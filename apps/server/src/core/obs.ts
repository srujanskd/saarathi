import { readFileSync } from "node:fs";
// The default entry point of obs-websocket-js is the MsgPack build. We take the
// JSON one deliberately: it is the encoding OBS uses by default, it keeps
// @msgpack/msgpack out of the running process, and it is the only one a small
// fake server in the tests can speak without pulling a codec in too.
import OBSWebSocket, { OBSWebSocketError } from "obs-websocket-js/json";
import {
  OBS_CONNECT_TIMEOUT_MS,
  OBS_ID,
  OBS_RETRY_MS,
  type ConnectionStatus,
  type InvokeResult,
  type Logger,
  type ObsActions,
  type ObsView,
} from "@saarathi/shared";
import {
  defaultSettings,
  obsStatus,
  readObsConfig,
  resolveSettings,
  type ObsSettings,
} from "./obs-config.js";
import type { StateStore } from "./store.js";

/** OBS closes the socket with this when the password does not match. */
const AUTH_FAILED = 4009;

export interface ObsSink {
  status(status: ConnectionStatus): void;
  /** Settings or scenes changed, so the core slice needs republishing. */
  view(view: ObsView): void;
}

/**
 * The OBS seam, shaped like `ChatAdapter` because it is the same kind of thing:
 * a named external connection that starts, reports itself in words she can act
 * on, retries on its own, and stops cleanly.
 *
 * `actions` is the narrow view modules get as `ctx.obs`. Everything below it is
 * for her surfaces, and no module can reach any of it.
 */
export interface ObsAdapter {
  /** Also the key its connection status appears under on her control page. */
  readonly name: string;
  readonly actions: ObsActions;
  start(sink: ObsSink): Promise<void>;
  stop(): Promise<void>;
  view(): ObsView;
  connect(): Promise<InvokeResult>;
  disconnect(): Promise<InvokeResult>;
  setSettings(host: string, port: string, password: string): Promise<InvokeResult>;
  useAuto(): Promise<InvokeResult>;
  forgetPassword(): Promise<InvokeResult>;
  setScene(name: string): Promise<InvokeResult>;
}

export interface ObsOptions {
  store: StateStore;
  log: Logger;
  /** Where OBS keeps its own settings, or null when we cannot know. */
  configPath: string | null;
}

/**
 * A live obs-websocket connection.
 *
 * The design point worth keeping: in auto mode this re-reads OBS's own config
 * file on every attempt rather than once at boot. That is what turns setup into
 * "tick one checkbox in OBS" -- she enables the WebSocket server while we are
 * already running, and the next tick finds the port and the password OBS
 * generated for itself. She never sees a password, and there is no restart.
 */
export class ObsWebSocketAdapter implements ObsAdapter {
  readonly name = OBS_ID;
  readonly actions: ObsActions;

  private settings: ObsSettings;
  private sink: ObsSink | null = null;
  private socket: OBSWebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /** Set by a refused password. Terminal until she changes a setting. */
  private rejected = false;
  private detected = false;
  private scenes: string[] = [];
  private currentScene: string | null = null;

  constructor(private readonly options: ObsOptions) {
    this.settings = this.load();

    const connected = () => this.socket !== null;
    this.actions = {
      get connected() {
        return connected();
      },
      setScene: async (name) => {
        await this.request("switch scene", (obs) =>
          obs.call("SetCurrentProgramScene", { sceneName: name }),
        );
      },
      setSourceVisible: async (scene, source, visible) => {
        await this.request("change a source", async (obs) => {
          // SetSceneItemEnabled wants a numeric id, not a name, so this is two
          // calls. The id is deliberately not cached: OBS renumbers when she
          // re-adds a source, and a stale id silently toggles the wrong thing.
          const { sceneItemId } = await obs.call("GetSceneItemId", {
            sceneName: scene,
            sourceName: source,
          });
          await obs.call("SetSceneItemEnabled", {
            sceneName: scene,
            sceneItemId,
            sceneItemEnabled: visible,
          });
        });
      },
    };
  }

  // --- lifecycle ------------------------------------------------------------

  async start(sink: ObsSink): Promise<void> {
    this.sink = sink;
    this.stopped = false;
    this.publish();
    await this.tick();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer();
    await this.drop();
    this.sink = null;
  }

  view(): ObsView {
    return viewOf(this.settings, this.detected, this.scenes, this.currentScene);
  }

  // --- her surfaces ---------------------------------------------------------

  async connect(): Promise<InvokeResult> {
    if (this.stopped) return { ok: false, reason: "OBS control is switched off" };
    // Trying again is exactly what she means by tapping this, so a password
    // OBS refused earlier stops being the last word.
    this.rejected = false;
    this.clearTimer();
    await this.drop();
    await this.tick();
    return { ok: true };
  }

  async disconnect(): Promise<InvokeResult> {
    this.clearTimer();
    await this.drop();
    this.report({ phase: "stopped" });
    return { ok: true };
  }

  async setSettings(host: string, port: string, password: string): Promise<InvokeResult> {
    const address = host.trim() || this.settings.host;
    const number = Number(port.trim());
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      return { ok: false, reason: `"${port}" is not a port number. OBS uses 4455 by default.` };
    }

    this.save({
      mode: "manual",
      host: address,
      port: number,
      // Blank means "leave it alone", because the password is never sent to a
      // client to prefill the field with. Forgetting it is its own button.
      password: password || this.settings.password,
    });
    return this.connect();
  }

  async useAuto(): Promise<InvokeResult> {
    this.save({ ...defaultSettings() });
    return this.connect();
  }

  async forgetPassword(): Promise<InvokeResult> {
    this.save({ ...this.settings, password: "" });
    return this.connect();
  }

  async setScene(name: string): Promise<InvokeResult> {
    if (!name) return { ok: false, reason: "No scene named" };
    if (!this.socket) return { ok: false, reason: "OBS is not connected" };
    if (this.scenes.length > 0 && !this.scenes.includes(name)) {
      return { ok: false, reason: `OBS has no scene called "${name}"` };
    }
    const ok = await this.request("switch scene", (obs) =>
      obs.call("SetCurrentProgramScene", { sceneName: name }),
    );
    return ok ? { ok: true } : { ok: false, reason: "OBS did not take that. Check the log." };
  }

  // --- connecting -----------------------------------------------------------

  /**
   * One attempt, plus the decision about whether an attempt is even worth
   * making. In auto mode with no OBS on this machine we deliberately do not
   * dial: there is nothing to dial, and a blind retry every few seconds against
   * a port we have no evidence about is how a dev machine ends up talking to a
   * real OBS during a test run.
   */
  private async tick(): Promise<void> {
    if (this.stopped || this.rejected || !this.sink) return;

    const config = this.settings.mode === "auto" ? this.readConfig() : null;
    this.detected = config !== null;
    const resolved = resolveSettings(this.settings, config);
    this.publish();

    if (this.settings.mode === "auto") {
      if (!config) {
        this.report({
          phase: "down",
          host: resolved.host,
          port: resolved.port,
          detail: "no OBS settings found on this machine",
        });
        this.schedule();
        return;
      }
      if (!config.enabled) {
        this.report({ phase: "off", host: resolved.host, port: resolved.port });
        this.schedule();
        return;
      }
    }

    await this.attempt(resolved);
  }

  private async attempt(settings: ObsSettings): Promise<void> {
    const { host, port, password } = settings;
    this.report({ phase: "connecting", host, port });

    const obs = new OBSWebSocket();
    try {
      await withTimeout(
        obs.connect(`ws://${host}:${port}`, password || undefined),
        OBS_CONNECT_TIMEOUT_MS,
        `OBS did not answer within ${OBS_CONNECT_TIMEOUT_MS / 1000}s`,
      );
    } catch (err) {
      // A timed-out connect leaves a socket half-open, and connect() itself
      // only cleans up the failures it saw.
      await obs.disconnect().catch(() => {});
      if (err instanceof OBSWebSocketError && err.code === AUTH_FAILED) {
        this.rejected = true;
        this.report({ phase: "rejected", host, port, detail: err.message });
        return;
      }
      this.report({ phase: "down", host, port, detail: String(err) });
      this.schedule();
      return;
    }

    this.socket = obs;
    // Attached only now, so it cannot fire for a connect that never landed --
    // and a fresh socket per attempt means listeners never stack up.
    obs.on("ConnectionClosed", () => this.onDropped(obs, settings));
    obs.on("CurrentProgramSceneChanged", ({ sceneName }) => {
      this.currentScene = sceneName;
      this.publish();
    });
    obs.on("SceneListChanged", () => void this.refreshScenes());

    await this.refreshScenes();
    this.report({ phase: "connected", host, port, scenes: this.scenes.length });
  }

  private onDropped(obs: OBSWebSocket, settings: ObsSettings): void {
    // Our own disconnect() nulls the socket first, so this only ever runs for a
    // drop she did not ask for: OBS quit, or the network went away.
    if (this.socket !== obs) return;
    this.socket = null;
    this.scenes = [];
    this.currentScene = null;
    this.publish();
    this.report({ phase: "down", host: settings.host, port: settings.port });
    this.schedule();
  }

  private async refreshScenes(): Promise<void> {
    const obs = this.socket;
    if (!obs) return;
    try {
      const list = await obs.call("GetSceneList");
      this.scenes = [...list.scenes]
        // OBS's own numbering, so her buttons keep the same order every time
        // rather than whatever order the array happened to arrive in.
        .sort((a, b) => Number(a.sceneIndex ?? 0) - Number(b.sceneIndex ?? 0))
        .map((scene) => String(scene.sceneName));
      this.currentScene = list.currentProgramSceneName ?? null;
      this.publish();
    } catch (err) {
      this.options.log.warn("obs: could not read the scene list", err);
    }
  }

  /**
   * Every call a module makes lands here. It never throws: obs-websocket-js
   * throws "Not connected" on a socket that has gone away, and a module calling
   * `ctx.obs.setScene` in the middle of a spin must not take the kernel down
   * because OBS was quit.
   */
  private async request(what: string, run: (obs: OBSWebSocket) => Promise<unknown>): Promise<boolean> {
    const obs = this.socket;
    if (!obs) {
      this.options.log.info(`obs (not connected): would ${what}`);
      return false;
    }
    try {
      await run(obs);
      return true;
    } catch (err) {
      this.options.log.error(`obs: could not ${what}`, err);
      return false;
    }
  }

  // --- plumbing -------------------------------------------------------------

  private schedule(): void {
    if (this.stopped || this.rejected || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, OBS_RETRY_MS);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drops the socket without letting the close handler treat it as a failure. */
  private async drop(): Promise<void> {
    const obs = this.socket;
    this.socket = null;
    this.scenes = [];
    this.currentScene = null;
    this.publish();
    if (obs) await obs.disconnect().catch(() => {});
  }

  private readConfig() {
    const path = this.options.configPath;
    if (!path) return null;
    try {
      return readObsConfig(readFileSync(path, "utf-8"));
    } catch {
      // Not installed, not run yet, or not readable. All ordinary: her settings
      // form is right there, and this is a hint rather than a requirement.
      return null;
    }
  }

  private load(): ObsSettings {
    const saved = this.options.store.read(OBS_ID);
    const fallback = defaultSettings();
    if (!saved) return fallback;
    return {
      mode: saved.mode === "manual" ? "manual" : "auto",
      host: typeof saved.host === "string" && saved.host ? saved.host : fallback.host,
      port: typeof saved.port === "number" ? saved.port : fallback.port,
      password: typeof saved.password === "string" ? saved.password : "",
    };
  }

  private save(settings: ObsSettings): void {
    this.settings = settings;
    // Its own namespace, not core's: the registry rewrites the whole `core`
    // namespace every time she switches a module on or off.
    this.options.store.write(OBS_ID, { ...settings });
    this.rejected = false;
    this.publish();
  }

  private report(condition: {
    phase: "connecting" | "connected" | "down" | "rejected" | "off" | "stopped";
    host?: string;
    port?: number;
    scenes?: number;
    detail?: string;
  }): void {
    const status = obsStatus({
      ...condition,
      host: condition.host ?? this.settings.host,
      port: condition.port ?? this.settings.port,
    });
    if (condition.detail) this.options.log.info(`obs: ${condition.detail}`);
    this.sink?.status(status);
  }

  private publish(): void {
    this.sink?.view(this.view());
  }
}

function viewOf(
  settings: ObsSettings,
  detected: boolean,
  scenes: string[],
  currentScene: string | null,
): ObsView {
  return {
    mode: settings.mode,
    host: settings.host,
    port: settings.port,
    hasPassword: settings.password !== "",
    detected,
    scenes: [...scenes],
    currentScene,
  };
}

/**
 * obs-websocket-js waits for the socket to open with no clock of its own, so a
 * port that is filtered rather than refused -- a firewall, a VPN, a machine
 * that is simply gone -- hangs the retry loop for good instead of failing.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
