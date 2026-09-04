import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * obs-websocket, small enough to read.
 *
 * It speaks the real v5 protocol -- the subprotocol handshake, the Hello /
 * Identify / Identified exchange, the SHA-256 challenge, and the handful of
 * requests we send -- because the things worth proving about OBS control are
 * exactly the things a stub cannot have wrong: whether the auth string we
 * compute is the one OBS expects, whether a refused password looks different
 * from a closed laptop, and what happens to a live connection when OBS quits.
 *
 * Protocol reference: obsproject/obs-websocket, docs/generated/protocol.md.
 */

const OP = { hello: 0, identify: 1, identified: 2, event: 5, request: 6, response: 7 } as const;
const AUTH_FAILED = 4009;
const SUBPROTOCOL = "obswebsocket.json";

const sha256 = (value: string) => createHash("sha256").update(value).digest("base64");

/** OBS's own recipe, from `Utils::Crypto`. */
function authString(password: string, salt: string, challenge: string): string {
  return sha256(sha256(password + salt) + challenge);
}

export interface FakeObsOptions {
  /** Blank means the server does not ask for authentication. */
  password?: string;
  scenes?: string[];
  /** Reuse a port a previous fake had, to be the same OBS starting up again. */
  port?: number;
  /**
   * Sit on the Hello for this long. OBS is not usually slow, but a connect that
   * is still in flight is the only window in which she can tap Disconnect and
   * have an answer arrive afterwards, and that window is otherwise a millisecond
   * wide and untestable.
   */
  helloDelayMs?: number;
  /** Inputs the readiness check should discover through OBS. */
  browserSources?: string[];
  microphones?: { name: string; muted?: boolean }[];
}

export interface FakeObs {
  readonly port: number;
  /** Scene switches it was asked for, in order. */
  readonly switches: string[];
  /** Scene item toggles, as `SetSceneItemEnabled` received them. */
  readonly toggles: { scene: string; sceneItemId: number; enabled: boolean }[];
  /** Microphone changes, as `SetInputMute` received them. */
  readonly microphoneChanges: { name: string; muted: boolean }[];
  readonly browserSourceChanges: {
    operation: "create" | "update" | "attach" | "remove";
    scene?: string;
    name: string;
    settings?: Record<string, unknown>;
  }[];
  currentScene(): string;
  /** Rename or reorder the scene list and tell whoever is listening. */
  setScenes(scenes: string[]): void;
  /** What OBS quitting looks like from the outside. */
  close(): Promise<void>;
}

export async function startFakeObs(options: FakeObsOptions = {}): Promise<FakeObs> {
  const password = options.password ?? "";
  let scenes = options.scenes ?? ["Workout", "Just Chatting", "BRB"];
  let current = scenes[0]!;
  const switches: string[] = [];
  const toggles: FakeObs["toggles"] = [];
  const identified = new Set<WebSocket>();
  const browserSources = [...(options.browserSources ?? [])];
  const browserSourceChanges: FakeObs["browserSourceChanges"] = [];
  const sceneItems = new Set(browserSources.map((name) => `${current}\0${name}`));
  const microphones = (options.microphones ?? []).map((microphone) => ({ ...microphone }));
  const microphoneChanges: FakeObs["microphoneChanges"] = [];

  const wss = new WebSocketServer({
    port: options.port ?? 0,
    host: "127.0.0.1",
    // obs-websocket-js checks the negotiated subprotocol and refuses the
    // connection without it, so a fake that skips this never gets as far as
    // the handshake it is meant to be testing.
    handleProtocols: (protocols) => (protocols.has(SUBPROTOCOL) ? SUBPROTOCOL : false),
  });

  await new Promise<void>((resolve) => wss.once("listening", resolve));

  const send = (socket: WebSocket, op: number, d: unknown) =>
    socket.send(JSON.stringify({ op, d }));

  const broadcast = (eventType: string, eventData: unknown) => {
    for (const socket of identified) {
      send(socket, OP.event, { eventType, eventIntent: 4, eventData });
    }
  };

  const sceneList = () => ({
    currentProgramSceneName: current,
    currentPreviewSceneName: null,
    // OBS numbers from the far end of its own list, so the array arrives in the
    // opposite order to the indices. Reproduced here because sorting it back is
    // something the adapter has to get right.
    scenes: scenes.map((sceneName, i) => ({ sceneName, sceneIndex: scenes.length - i - 1 })),
  });

  wss.on("connection", (socket) => {
    const salt = randomBytes(16).toString("base64");
    const challenge = randomBytes(16).toString("base64");

    const hello = () =>
      send(socket, OP.hello, {
        obsWebSocketVersion: "5.6.2",
        rpcVersion: 1,
        ...(password ? { authentication: { challenge, salt } } : {}),
      });
    if (options.helloDelayMs) setTimeout(hello, options.helloDelayMs).unref?.();
    else hello();

    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { op: number; d: Record<string, unknown> };

      if (message.op === OP.identify) {
        if (password && message.d.authentication !== authString(password, salt, challenge)) {
          socket.close(AUTH_FAILED, "Authentication failed.");
          return;
        }
        identified.add(socket);
        send(socket, OP.identified, { negotiatedRpcVersion: 1 });
        return;
      }

      if (message.op !== OP.request) return;
      const { requestType, requestId, requestData } = message.d as {
        requestType: string;
        requestId: string;
        requestData?: Record<string, unknown>;
      };

      const reply = (responseData: unknown, ok = true, comment = "") =>
        send(socket, OP.response, {
          requestType,
          requestId,
          requestStatus: { result: ok, code: ok ? 100 : 600, ...(comment ? { comment } : {}) },
          responseData,
        });

      switch (requestType) {
        case "GetSceneList":
          reply(sceneList());
          return;
        case "GetInputList":
          reply({
            inputs:
              requestData?.inputKind === "browser_source"
                ? browserSources.map((inputName) => ({
                    inputName,
                    inputKind: "browser_source",
                    unversionedInputKind: "browser_source",
                  }))
                : [],
          });
          return;
        case "GetSpecialInputs":
          reply(
            Object.fromEntries(microphones.map((microphone, index) => [`mic${index + 1}`, microphone.name])),
          );
          return;
        case "GetInputMute": {
          const inputName = String(requestData?.inputName ?? "");
          const microphone = microphones.find((input) => input.name === inputName);
          if (!microphone) {
            reply(undefined, false, "No input by that name.");
            return;
          }
          reply({ inputMuted: microphone.muted ?? false });
          return;
        }
        case "SetInputMute": {
          const inputName = String(requestData?.inputName ?? "");
          const microphone = microphones.find((input) => input.name === inputName);
          if (!microphone) {
            reply(undefined, false, "No input by that name.");
            return;
          }
          const inputMuted = requestData?.inputMuted === true;
          microphone.muted = inputMuted;
          microphoneChanges.push({ name: inputName, muted: inputMuted });
          reply(undefined);
          broadcast("InputMuteStateChanged", { inputName, inputMuted });
          return;
        }
        case "SetCurrentProgramScene": {
          const sceneName = String(requestData?.sceneName ?? "");
          if (!scenes.includes(sceneName)) {
            reply(undefined, false, "No scene by that name.");
            return;
          }
          switches.push(sceneName);
          current = sceneName;
          reply(undefined);
          broadcast("CurrentProgramSceneChanged", { sceneName });
          return;
        }
        case "GetSceneItemId": {
          const scene = String(requestData?.sceneName ?? "");
          const name = String(requestData?.sourceName ?? "");
          if (!sceneItems.has(`${scene}\0${name}`)) {
            reply(undefined, false, "No scene item by that name.");
            return;
          }
          reply({ sceneItemId: 7 });
          return;
        }
        case "SetSceneItemEnabled":
          toggles.push({
            scene: String(requestData?.sceneName ?? ""),
            sceneItemId: Number(requestData?.sceneItemId),
            enabled: requestData?.sceneItemEnabled === true,
          });
          reply(undefined);
          return;
        case "CreateInput": {
          const name = String(requestData?.inputName ?? "");
          if (browserSources.includes(name)) {
            reply(undefined, false, "An input with that name already exists.");
            return;
          }
          browserSources.push(name);
          sceneItems.add(`${String(requestData?.sceneName ?? "")}\0${name}`);
          browserSourceChanges.push({
            operation: "create",
            scene: String(requestData?.sceneName ?? ""),
            name,
            settings: requestData?.inputSettings as Record<string, unknown>,
          });
          reply({ sceneItemId: 8 });
          return;
        }
        case "CreateSceneItem": {
          const scene = String(requestData?.sceneName ?? "");
          const name = String(requestData?.sourceName ?? "");
          if (!browserSources.includes(name)) {
            reply(undefined, false, "No input by that name.");
            return;
          }
          sceneItems.add(`${scene}\0${name}`);
          browserSourceChanges.push({ operation: "attach", scene, name });
          reply({ sceneItemId: 9 });
          return;
        }
        case "SetInputSettings":
          browserSourceChanges.push({
            operation: "update",
            name: String(requestData?.inputName ?? ""),
            settings: requestData?.inputSettings as Record<string, unknown>,
          });
          reply(undefined);
          return;
        case "RemoveInput": {
          const name = String(requestData?.inputName ?? "");
          const index = browserSources.indexOf(name);
          if (index < 0) {
            reply(undefined, false, "No input by that name.");
            return;
          }
          browserSources.splice(index, 1);
          for (const item of sceneItems) {
            if (item.endsWith(`\0${name}`)) sceneItems.delete(item);
          }
          browserSourceChanges.push({ operation: "remove", name });
          reply(undefined);
          return;
        }
        default:
          reply(undefined, false, `Unhandled in the fake: ${requestType}`);
      }
    });

    socket.on("close", () => identified.delete(socket));
  });

  return {
    port: (wss.address() as AddressInfo).port,
    switches,
    toggles,
    microphoneChanges,
    browserSourceChanges,
    currentScene: () => current,
    setScenes(next) {
      scenes = next;
      current = next.includes(current) ? current : (next[0] ?? "");
      for (const item of sceneItems) {
        const scene = item.slice(0, item.indexOf("\0"));
        if (!next.includes(scene)) sceneItems.delete(item);
      }
      broadcast("SceneListChanged", { scenes: sceneList().scenes });
    },
    close() {
      for (const socket of identified) socket.terminate();
      identified.clear();
      return new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
