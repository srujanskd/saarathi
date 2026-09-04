import { readFileSync } from "node:fs";
// The default entry point of obs-websocket-js is the MsgPack build. We take the
// JSON one deliberately: it is the encoding OBS uses by default, it keeps
// @msgpack/msgpack out of the running process, and it is the only one a small
// fake server in the tests can speak without pulling a codec in too.
import OBSWebSocket, { OBSWebSocketError } from "obs-websocket-js/json";
import {
  CORE_ACTIONS,
  COUGH_MUTE_MS,
  OBS_CALL_TIMEOUT_MS,
  OBS_CONNECT_TIMEOUT_MS,
  OBS_DEFAULT_PORT,
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
  type ObsCondition,
  type ObsPhase,
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

/** Where she says OBS is, once it has been parsed out of her control page. */
export interface ManualSettings {
  host: string;
  /** Already a number: the string never travels past `obsCommand`. */
  port: number;
  /** Blank means "leave the stored one alone". */
  password: string;
}

/** One server-declared overlay, already checked by the module registry. */
export interface ObsOverlay {
  id: string;
  title: string;
  sourceName: string;
}

export function obsBrowserSourceName(moduleId: string): string {
  return `Saarathi ${moduleId}`;
}

export interface ObsCommandContext {
  /** Host from the HTTP/WebSocket request that carried the invoke. */
  serverHost?: string;
}

/** Everything her surfaces can ask of OBS, and all `obsCommand` needs to route. */
export interface ObsCommands {
  connect(): Promise<InvokeResult>;
  disconnect(): Promise<InvokeResult>;
  useAuto(): Promise<InvokeResult>;
  forgetPassword(): Promise<InvokeResult>;
  setScene(name: string): Promise<InvokeResult>;
  setMicrophoneMuted(name: string, muted: boolean): Promise<InvokeResult>;
  coughMute(name: string): Promise<InvokeResult>;
  createBrowserSource(overlay: ObsOverlay, serverUrl: string): Promise<InvokeResult>;
  removeBrowserSource(overlay: ObsOverlay): Promise<InvokeResult>;
  setSettings(settings: ManualSettings): Promise<InvokeResult>;
}

/**
 * The OBS seam, shaped like `ChatAdapter` because it is the same kind of thing:
 * a named external connection that starts, reports itself in words she can act
 * on, retries on its own, and stops cleanly.
 *
 * `actions` is the narrow view modules get as `ctx.obs`. Everything below it is
 * for her surfaces, and no module can reach any of it.
 */
export interface ObsAdapter extends ObsCommands {
  /** Also the key its connection status appears under on her control page. */
  readonly name: string;
  readonly actions: ObsActions;
  start(sink: ObsSink): Promise<void>;
  stop(): Promise<void>;
  view(): ObsView;
}

/**
 * Her control page's OBS actions, routed here rather than in the registry.
 * Knowing that `obsScene` takes a scene name and `obsSettings` takes a port
 * that has to parse is knowledge about OBS, and the registry's job is modules.
 * `null` means "not one of ours", so the registry can carry on to its own.
 *
 * Keyed by the whole action id out of `CORE_ACTIONS`, which is the same
 * constant her pages send, so the two ends of one string cannot drift apart.
 */
export function obsCommand(
  obs: ObsCommands,
  actionId: string,
  args: string[],
  findOverlay: (id: string) => ObsOverlay | null,
  context: ObsCommandContext = {},
): Promise<InvokeResult> | null {
  if (actionId === CORE_ACTIONS.obsBrowserSource) {
    const overlay = findOverlay(args[0] ?? "");
    if (!overlay) {
      return Promise.resolve({ ok: false, reason: `There is no overlay "${args[0] ?? ""}"` });
    }
    const serverUrl = trustedOverlayOrigin(args[1] ?? "", context.serverHost);
    if (!serverUrl) {
      return Promise.resolve({
        ok: false,
        reason: "That server address does not match this Saarathi connection",
      });
    }
    return obs.createBrowserSource(overlay, serverUrl);
  }
  if (actionId === CORE_ACTIONS.obsRemoveBrowserSource) {
    const overlay = findOverlay(args[0] ?? "");
    if (!overlay) {
      return Promise.resolve({ ok: false, reason: `There is no overlay "${args[0] ?? ""}"` });
    }
    return obs.removeBrowserSource(overlay);
  }
  const run = OBS_COMMANDS.get(actionId);
  return run ? run(obs, args) : null;
}

/**
 * Accepts the address the page actually connected to, without letting it aim
 * the server-owned overlay capability at another host. The page still supplies
 * the scheme because a reverse proxy may terminate TLS before the socket reaches
 * us; the Host header is the transport's independently observed half.
 */
export function trustedOverlayOrigin(serverUrl: string, requestHost?: string): string | null {
  if (!requestHost) return null;
  try {
    const candidate = new URL(serverUrl);
    const observed = new URL(`http://${requestHost}`);
    if (candidate.protocol !== "http:" && candidate.protocol !== "https:") return null;
    if (candidate.username || candidate.password || candidate.host !== observed.host) return null;
    return candidate.origin;
  } catch {
    return null;
  }
}

const OBS_COMMANDS = new Map<string, (obs: ObsCommands, args: string[]) => Promise<InvokeResult>>([
  [CORE_ACTIONS.obsConnect, (obs) => obs.connect()],
  [CORE_ACTIONS.obsDisconnect, (obs) => obs.disconnect()],
  [CORE_ACTIONS.obsAuto, (obs) => obs.useAuto()],
  [CORE_ACTIONS.obsForget, (obs) => obs.forgetPassword()],
  [CORE_ACTIONS.obsScene, (obs, args) => obs.setScene(args[0] ?? "")],
  [CORE_ACTIONS.obsMute, (obs, args) => obs.setMicrophoneMuted(args[0] ?? "", true)],
  [CORE_ACTIONS.obsUnmute, (obs, args) => obs.setMicrophoneMuted(args[0] ?? "", false)],
  [CORE_ACTIONS.obsCoughMute, (obs, args) => obs.coughMute(args[0] ?? "")],
  [CORE_ACTIONS.obsSettings, (obs, args) => applySettings(obs, args)],
]);

/**
 * Positional strings, because `InvokeRequest.args` is `string[]` -- the same
 * constraint `wheel.setChallenges` already lives with. They are parsed here and
 * only here, so nothing past this line carries a port that might not be one.
 */
async function applySettings(obs: ObsCommands, args: string[]): Promise<InvokeResult> {
  const [host = "", port = "", password = ""] = args;
  const number = Number(port.trim());
  if (!Number.isInteger(number) || number < 1 || number > 65535) {
    return {
      ok: false,
      reason: `"${port}" is not a port number. OBS uses ${OBS_DEFAULT_PORT} by default.`,
    };
  }
  return obs.setSettings({ host: host.trim(), port: number, password });
}

export interface ObsOptions {
  store: StateStore;
  log: Logger;
  /** Where OBS keeps its own settings, or null when we cannot know. */
  configPath: string | null;
  /** Read at creation time so an access reset is repaired by the next tap. */
  overlayToken: () => string;
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
  /**
   * What the next attempt will actually dial, which in auto mode is what OBS's
   * config file said rather than what is stored. Her card renders this: a port
   * we detected and a port we saved are different numbers, and showing her the
   * saved one while talking to the detected one is a lie on the one surface she
   * has for working out why OBS is unhappy.
   */
  private effective: ObsSettings;
  private sink: ObsSink | null = null;
  private socket: OBSWebSocket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  /**
   * She tapped Disconnect. Separate from `stopped`, which is the kernel's
   * lifecycle: conflating them meant the card said "switched off" while the
   * adapter was merely idle, and `connect()`'s refusal could never fire.
   * In memory on purpose -- a restart should come back up talking to OBS.
   */
  private paused = false;
  /** Set by a refused password. Terminal until she changes a setting. */
  private rejected = false;
  private detected = false;
  private scenes: string[] = [];
  private currentScene: string | null = null;
  private browserSources: string[] = [];
  private microphones: ObsView["microphones"] = [];
  private readonly coughMutes = new Map<
    string,
    { until: number; restoreMuted: boolean; timer: NodeJS.Timeout | null }
  >();
  /** Invalidates a cough start when a later explicit command overtakes it. */
  private readonly microphoneCommandVersions = new Map<string, number>();

  constructor(private readonly options: ObsOptions) {
    this.settings = this.load();
    this.effective = this.settings;

    const connected = () => this.socket !== null;
    this.actions = {
      get connected() {
        return connected();
      },
      setScene: async (name) => {
        await this.switchScene(name);
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
    const coughMuted = [...this.coughMutes];
    this.clearCoughTimers();
    // A normal mute belongs to OBS and survives us. A cough mute promised to
    // restore itself, so a clean tray shutdown must keep that promise before
    // it drops the socket.
    for (const [name, pending] of coughMuted) {
      await this.changeMicrophoneMuted(name, pending.restoreMuted);
    }
    this.coughMutes.clear();
    await this.drop();
    this.sink = null;
  }

  view(): ObsView {
    return {
      mode: this.settings.mode,
      host: this.effective.host,
      port: this.effective.port,
      // Hers, not the detected one: this is what the password field and Forget
      // password act on, and neither has anything to do for OBS's own.
      hasPassword: this.settings.password !== "",
      detected: this.detected,
      scenes: [...this.scenes],
      currentScene: this.currentScene,
      browserSources: [...this.browserSources],
      microphones: this.microphones.map((input) => ({
        ...input,
        coughMutedUntil: this.coughMutes.get(input.name)?.until ?? null,
      })),
    };
  }

  // --- her surfaces ---------------------------------------------------------

  async connect(): Promise<InvokeResult> {
    if (this.stopped) return { ok: false, reason: "OBS control is not running" };
    // Trying again is exactly what she means by tapping this, so neither a
    // password OBS refused earlier nor a Disconnect she tapped is the last word.
    this.rejected = false;
    this.paused = false;
    this.clearTimer();
    await this.drop();
    await this.tick();
    return { ok: true };
  }

  async disconnect(): Promise<InvokeResult> {
    // Actually off, not merely idle: without this the retry loop would pick the
    // connection back up behind her and the card would keep saying it was off.
    this.paused = true;
    this.clearTimer();
    await this.drop();
    this.report({ phase: "stopped" });
    return { ok: true };
  }

  async setSettings({ host, port, password }: ManualSettings): Promise<InvokeResult> {
    this.save({
      mode: "manual",
      host: host || this.settings.host,
      port,
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
    const ok = await this.switchScene(name);
    return ok ? { ok: true } : { ok: false, reason: "OBS did not take that. Check the log." };
  }

  async setMicrophoneMuted(name: string, muted: boolean): Promise<InvokeResult> {
    this.nextMicrophoneCommand(name);
    if (this.clearCough(name)) this.publish();
    return this.changeMicrophoneMuted(name, muted);
  }

  async coughMute(name: string): Promise<InvokeResult> {
    const microphone = this.microphones.find((input) => input.name === name);
    if (!microphone) return { ok: false, reason: `OBS has no microphone called "${name}"` };
    if (microphone.muted == null) {
      return { ok: false, reason: `OBS has not reported whether "${name}" is muted` };
    }

    const pending = this.coughMutes.get(name);
    if (pending) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.until = Date.now() + COUGH_MUTE_MS;
      pending.timer = null;
      this.scheduleCoughRestore(name, pending.until);
      this.publish();
      return { ok: true };
    }

    const restoreMuted = microphone.muted;
    const commandVersion = this.nextMicrophoneCommand(name);
    const result = await this.changeMicrophoneMuted(name, true);
    if (!result.ok) return result;
    // An explicit mute or unmute arrived while OBS was answering this request.
    // That later command owns the microphone and must not inherit our timer.
    if (this.microphoneCommandVersions.get(name) !== commandVersion) return { ok: true };

    const until = Date.now() + COUGH_MUTE_MS;
    this.coughMutes.set(name, { until, restoreMuted, timer: null });
    this.scheduleCoughRestore(name, until);
    this.publish();
    return { ok: true };
  }

  async createBrowserSource(overlay: ObsOverlay, serverUrl: string): Promise<InvokeResult> {
    if (!this.socket) return { ok: false, reason: "OBS is not connected" };
    const sceneName = this.currentScene;
    if (!sceneName) return { ok: false, reason: "OBS has no current scene" };

    const url = overlayUrl(serverUrl, overlay.id, this.options.overlayToken());
    if (!url) {
      return { ok: false, reason: "That server address is not a valid http or https address" };
    }

    const inputSettings = {
      url,
      width: 1920,
      height: 1080,
      shutdown: false,
      restart_when_active: true,
    };
    const exists = this.browserSources.includes(overlay.sourceName);
    const ok = await this.request(
      exists ? "repair a browser source" : "create a browser source",
      async (obs) => {
        if (exists) {
          await obs.call("SetInputSettings", {
            inputName: overlay.sourceName,
            inputSettings,
            overlay: true,
          });
          try {
            await obs.call("GetSceneItemId", {
              sceneName,
              sourceName: overlay.sourceName,
            });
          } catch {
            await obs.call("CreateSceneItem", {
              sceneName,
              sourceName: overlay.sourceName,
              sceneItemEnabled: true,
            });
          }
          return;
        }
        await obs.call("CreateInput", {
          sceneName,
          inputName: overlay.sourceName,
          inputKind: "browser_source",
          inputSettings,
          sceneItemEnabled: true,
        });
      },
    );
    if (!ok) return { ok: false, reason: "OBS did not create that source. Check the log." };
    await this.refreshInputs();
    return { ok: true };
  }

  async removeBrowserSource(overlay: ObsOverlay): Promise<InvokeResult> {
    if (!this.socket) return { ok: false, reason: "OBS is not connected" };
    if (!this.browserSources.includes(overlay.sourceName)) return { ok: true };
    const ok = await this.request("remove a browser source", (obs) =>
      obs.call("RemoveInput", { inputName: overlay.sourceName }),
    );
    if (!ok) return { ok: false, reason: "OBS did not remove that source. Check the log." };
    await this.refreshInputs();
    return { ok: true };
  }

  /** The one place a scene is switched, for her button and for `ctx.obs` alike. */
  private switchScene(name: string): Promise<boolean> {
    return this.request("switch scene", (obs) =>
      obs.call("SetCurrentProgramScene", { sceneName: name }),
    );
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
    if (this.stopped || this.paused || this.rejected || !this.sink) return;

    const config = this.settings.mode === "auto" ? this.readConfig() : null;
    this.detected = config !== null;
    this.effective = resolveSettings(this.settings, config);
    this.publish();

    if (this.settings.mode === "auto") {
      if (!config) {
        this.report({ phase: "down", detail: "no OBS settings found on this machine" });
        this.schedule();
        return;
      }
      if (!config.enabled) {
        this.report({ phase: "off" });
        this.schedule();
        return;
      }
    }

    await this.attempt(this.effective);
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
      if (this.abandoned()) return;
      if (err instanceof OBSWebSocketError && err.code === AUTH_FAILED) {
        this.rejected = true;
        this.report({ phase: "rejected", host, port, detail: err.message });
        return;
      }
      this.report({ phase: "down", host, port, detail: String(err) });
      this.schedule();
      return;
    }

    // A connect takes as long as OBS takes, and she can tap Disconnect in the
    // middle of one. Adopting the socket anyway would flip her card back to
    // connected after she asked for it off, which is a one-way door.
    if (this.abandoned()) {
      await obs.disconnect().catch(() => {});
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
    // Inputs are the preflight facts the control page cannot learn on its own:
    // whether OBS has somewhere to render an overlay and whether a microphone
    // exists. Refresh the small list when OBS changes it instead of polling.
    obs.on("InputCreated", () => void this.refreshInputs());
    obs.on("InputRemoved", () => void this.refreshInputs());
    obs.on("InputNameChanged", () => void this.refreshInputs());
    obs.on("InputMuteStateChanged", ({ inputName, inputMuted }) => {
      const microphone = this.microphones.find((input) => input.name === inputName);
      if (!microphone) return;
      microphone.muted = inputMuted;
      if (!inputMuted) this.clearCough(inputName);
      this.publish();
    });

    await Promise.all([this.refreshScenes(), this.refreshInputs()]);
    this.report({ phase: "connected", host, port, scenes: this.scenes.length });
  }

  private onDropped(obs: OBSWebSocket, settings: ObsSettings): void {
    // Our own disconnect() nulls the socket first, so this only ever runs for a
    // drop she did not ask for: OBS quit, or the network went away.
    if (this.socket !== obs) return;
    this.socket = null;
    this.scenes = [];
    this.currentScene = null;
    this.browserSources = [];
    this.microphones = [];
    this.clearCoughTimers();
    this.publish();
    this.report({ phase: "down", host: settings.host, port: settings.port });
    this.schedule();
  }

  private async refreshScenes(): Promise<void> {
    const obs = this.socket;
    if (!obs) return;
    try {
      const list = await obs.call("GetSceneList");
      if (this.socket !== obs) return;
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

  private async refreshInputs(): Promise<void> {
    const obs = this.socket;
    if (!obs) return;
    try {
      const [browsers, special] = await Promise.all([
        obs.call("GetInputList", { inputKind: "browser_source" }),
        obs.call("GetSpecialInputs"),
      ]);

      const browserSources = browsers.inputs
        .map((input) => input.inputName)
        .filter((name): name is string => typeof name === "string" && name.length > 0)
        .sort((a, b) => a.localeCompare(b));

      const microphoneNames = Object.entries(special)
        .filter(([key, value]) => key.startsWith("mic") && typeof value === "string" && value)
        .map(([, value]) => value as string);

      const microphones = await Promise.all(
        microphoneNames.map(async (name) => {
          try {
            const result = await obs.call("GetInputMute", { inputName: name });
            return { name, muted: result.inputMuted };
          } catch {
            return { name, muted: null };
          }
        }),
      );
      if (this.socket !== obs) return;
      this.browserSources = browserSources;
      this.microphones = microphones;
      this.publish();
      // Also runs after an InputCreated event. If the named microphone was
      // absent during reconnect, restoring waits until OBS names it again.
      this.resumeCoughMutes();
    } catch (err) {
      this.options.log.warn("obs: could not inspect browser sources and microphones", err);
    }
  }

  private async changeMicrophoneMuted(name: string, muted: boolean): Promise<InvokeResult> {
    if (!name) return { ok: false, reason: "No microphone named" };
    if (!this.socket) return { ok: false, reason: "OBS is not connected" };
    const microphone = this.microphones.find((input) => input.name === name);
    if (!microphone) return { ok: false, reason: `OBS has no microphone called "${name}"` };

    const verb = muted ? "mute" : "unmute";
    const ok = await this.request(`${verb} ${name}`, (obs) =>
      obs.call("SetInputMute", { inputName: name, inputMuted: muted }),
    );
    if (!ok) return { ok: false, reason: `OBS did not ${verb} ${name}. Check the log.` };

    // The event is authoritative. Reading the value back also covers OBS builds
    // that acknowledge this request without sending InputMuteStateChanged.
    const observed = await this.refreshMicrophoneMute(name);
    return observed === muted
      ? { ok: true }
      : { ok: false, reason: `OBS did not ${verb} ${name}. Check the log.` };
  }

  private async refreshMicrophoneMute(name: string): Promise<boolean | null> {
    let observed: boolean | undefined;
    const ok = await this.request(`check whether ${name} is muted`, async (obs) => {
      const result = await obs.call("GetInputMute", { inputName: name });
      if (this.socket === obs) observed = result.inputMuted;
    });
    if (!ok || observed === undefined) return null;
    const microphone = this.microphones.find((input) => input.name === name);
    if (!microphone) return null;
    microphone.muted = observed;
    this.publish();
    return observed;
  }

  private scheduleCoughRestore(
    name: string,
    until: number,
    delayMs = Math.max(0, until - Date.now()),
  ): void {
    const pending = this.coughMutes.get(name);
    if (!pending || pending.until !== until) return;
    const timer = setTimeout(() => void this.finishCough(name, until), delayMs);
    timer.unref?.();
    pending.timer = timer;
  }

  private async finishCough(name: string, until: number): Promise<void> {
    const pending = this.coughMutes.get(name);
    if (!pending || pending.until !== until) return;
    pending.timer = null;
    if (!this.socket) return;
    const result = await this.changeMicrophoneMuted(name, pending.restoreMuted);
    const current = this.coughMutes.get(name);
    if (!current || current.until !== until) return;
    if (result.ok) {
      this.coughMutes.delete(name);
      this.publish();
    } else {
      this.scheduleCoughRestore(name, until, OBS_RETRY_MS);
    }
  }

  private resumeCoughMutes(): void {
    for (const [name, pending] of this.coughMutes) {
      if (!pending.timer) this.scheduleCoughRestore(name, pending.until);
    }
  }

  private clearCough(name: string): boolean {
    const pending = this.coughMutes.get(name);
    if (pending?.timer) clearTimeout(pending.timer);
    return this.coughMutes.delete(name);
  }

  private nextMicrophoneCommand(name: string): number {
    const version = (this.microphoneCommandVersions.get(name) ?? 0) + 1;
    this.microphoneCommandVersions.set(name, version);
    return version;
  }

  private clearCoughTimers(): void {
    for (const pending of this.coughMutes.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.timer = null;
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
      // A half-open socket never answers and never errors, so this needs its
      // own clock for the same reason connect() does.
      await withTimeout(
        run(obs),
        OBS_CALL_TIMEOUT_MS,
        `OBS did not answer within ${OBS_CALL_TIMEOUT_MS / 1000}s`,
      );
      return true;
    } catch (err) {
      this.options.log.error(`obs: could not ${what}`, err);
      return false;
    }
  }

  // --- plumbing -------------------------------------------------------------

  /** She stopped wanting this connection while we were still making it. */
  private abandoned(): boolean {
    return this.stopped || this.paused;
  }

  private schedule(): void {
    if (this.stopped || this.paused || this.rejected || this.timer) return;
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
    this.browserSources = [];
    this.microphones = [];
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
    // Whatever we had detected is about to be recomputed by the next tick, and
    // until then what she just typed is the honest answer to "where is OBS".
    this.effective = settings;
    this.detected = false;
    // Its own namespace, not core's: the registry rewrites the whole `core`
    // namespace every time she switches a module on or off.
    this.options.store.write(OBS_ID, { ...settings });
    this.rejected = false;
    this.publish();
  }

  /** Host and port default to what we would actually dial, not what is saved. */
  private report(condition: Partial<ObsCondition> & { phase: ObsPhase }): void {
    const status = obsStatus({
      ...condition,
      host: condition.host ?? this.effective.host,
      port: condition.port ?? this.effective.port,
    });
    if (condition.detail) this.options.log.info(`obs: ${condition.detail}`);
    this.sink?.status(status);
  }

  private publish(): void {
    this.sink?.view(this.view());
  }
}

/** Builds the exact URL OBS receives without returning its read token to a client. */
function overlayUrl(serverUrl: string, moduleId: string, token: string): string | null {
  try {
    const server = new URL(serverUrl);
    if (server.protocol !== "http:" && server.protocol !== "https:") return null;
    if (server.username || server.password) return null;
    const overlay = new URL("/overlay.html", server.origin);
    overlay.searchParams.set("module", moduleId);
    overlay.searchParams.set("server", server.origin);
    overlay.searchParams.set("access", token);
    return overlay.toString();
  } catch {
    return null;
  }
}

/**
 * obs-websocket-js has no clock of its own, at either end. A port that is
 * filtered rather than refused -- a firewall, a VPN, a machine that is simply
 * gone -- hangs a connect for good instead of failing, and a half-open socket
 * does the same to a request. Both get this.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
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
