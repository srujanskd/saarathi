import {
  OBS_DEFAULT_HOST,
  OBS_DEFAULT_PORT,
  OBS_RETRY_MS,
  type ConnectionStatus,
} from "@saarathi/shared";

/**
 * The pure half of OBS control: where OBS keeps its own WebSocket settings,
 * what they mean, and what to tell her when the connection is unhappy.
 *
 * It is a separate file from the adapter so all of it is reachable from a unit
 * test without a socket, and so the one Windows-shaped path in the project sits
 * somewhere obvious. Nothing here reads a file or dials anything.
 */

/** What OBS writes for its own plugin, from obs-websocket's `Config.cpp`. */
export interface ObsConfig {
  enabled: boolean;
  port: number;
  authRequired: boolean;
  password: string;
}

/** Her settings as we persist them. `password` never leaves the server. */
export interface ObsSettings {
  mode: "auto" | "manual";
  host: string;
  port: number;
  password: string;
}

export const defaultSettings = (): ObsSettings => ({
  mode: "auto",
  host: OBS_DEFAULT_HOST,
  port: OBS_DEFAULT_PORT,
  password: "",
});

/**
 * Where OBS's obs-websocket plugin keeps `config.json`.
 *
 * Reading it is what saves her from copying a generated password out of a
 * dialog, which is the whole reason this feature clears the no-terminal bar.
 * It is a hint and never a requirement: the server may be a VPS with no OBS on
 * it at all, so every caller treats `null` -- and a file that is not there --
 * as ordinary.
 */
export function obsConfigPath(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
): string | null {
  const tail = "obs-studio/plugin_config/obs-websocket/config.json";
  if (platform === "win32") {
    return env.APPDATA ? `${env.APPDATA.replace(/\\/g, "/")}/${tail}` : null;
  }
  const home = env.HOME;
  if (!home) return null;
  if (platform === "darwin") return `${home}/Library/Application Support/${tail}`;
  return `${env.XDG_CONFIG_HOME || `${home}/.config`}/${tail}`;
}

/**
 * Parse what OBS wrote. Anything unexpected is `null` rather than a throw: this
 * file belongs to another program, which is free to change it, and the answer
 * to a surprise is her settings form, not a crash on her stream night.
 */
export function readObsConfig(text: string): ObsConfig | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const config = raw as Record<string, unknown>;
  const port = config.server_port;
  const password = config.server_password;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    return null;
  }

  return {
    enabled: config.server_enabled === true,
    port,
    // OBS defaults this to true, so a missing key means "yes", not "no".
    authRequired: config.auth_required !== false,
    password: typeof password === "string" ? password : "",
  };
}

/**
 * The settings a connect attempt should actually use. In auto mode OBS's file
 * wins, and it is re-read on every attempt rather than once at boot -- that is
 * what lets her tick the checkbox in OBS while we are already running and watch
 * the status go green without restarting anything.
 */
export function resolveSettings(saved: ObsSettings, config: ObsConfig | null): ObsSettings {
  if (saved.mode === "manual" || !config) return saved;
  return {
    mode: "auto",
    host: OBS_DEFAULT_HOST,
    port: config.port,
    password: config.authRequired ? config.password : "",
  };
}

/** Exported so the adapter names it rather than retyping the union. */
export type ObsPhase = "connecting" | "connected" | "down" | "rejected" | "off" | "stopped";

export interface ObsCondition {
  phase: ObsPhase;
  host: string;
  port: number;
  /** Scene count, for the connected line. */
  scenes?: number;
  /** Whatever went wrong, for the log. Never the only thing she is told. */
  detail?: string;
}

/**
 * What her phone says. Every line names the thing she could do about it, which
 * is the difference between a status and a stack trace -- "OBS is not running"
 * is actionable at arm's length; `ECONNREFUSED 127.0.0.1:4455` is not.
 */
export function obsStatus(condition: ObsCondition): ConnectionStatus {
  const where = `${condition.host}:${condition.port}`;
  const seconds = OBS_RETRY_MS / 1000;

  switch (condition.phase) {
    case "connecting":
      return { state: "connecting", detail: `Looking for OBS on ${where}` };
    case "connected": {
      const count = condition.scenes ?? 0;
      return {
        state: "connected",
        detail: `OBS connected — ${count} ${count === 1 ? "scene" : "scenes"}`,
      };
    }
    case "off":
      return {
        state: "disconnected",
        detail:
          "OBS is running, but its WebSocket server is off. " +
          `In OBS: Tools → WebSocket Server Settings → Enable WebSocket server. Checking every ${seconds}s.`,
      };
    case "down":
      return {
        state: "disconnected",
        detail: `OBS is not running, or its WebSocket server is off. Retrying every ${seconds}s.`,
      };
    case "rejected":
      // Terminal on purpose. Retrying a password OBS has already refused is a
      // log flood that never becomes true on its own, so we stop and wait for
      // her to change something.
      return {
        state: "error",
        detail:
          "OBS refused the password. Check Tools → WebSocket Server Settings in OBS, " +
          "or use OBS's own settings from here.",
      };
    case "stopped":
      return { state: "disconnected", detail: "OBS control is switched off" };
  }
}
