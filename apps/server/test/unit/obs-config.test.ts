import { describe, expect, it } from "vitest";
import { OBS_DEFAULT_HOST, OBS_DEFAULT_PORT } from "@saarathi/shared";
import {
  defaultSettings,
  obsConfigPath,
  obsStatus,
  readObsConfig,
  resolveSettings,
} from "../../src/core/obs-config.js";

/** What OBS actually writes, keys and all. */
const obsFile = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    first_load: false,
    server_enabled: true,
    server_port: 4455,
    alerts_enabled: false,
    auth_required: true,
    server_password: "k9Xw2mQpZ4vT8nBc",
    ...extra,
  });

describe("obsConfigPath", () => {
  it("finds OBS's plugin config on Windows", () => {
    expect(obsConfigPath("win32", { APPDATA: "C:\\Users\\Her\\AppData\\Roaming" })).toBe(
      "C:/Users/Her/AppData/Roaming/obs-studio/plugin_config/obs-websocket/config.json",
    );
  });

  it("finds it on macOS and Linux", () => {
    expect(obsConfigPath("darwin", { HOME: "/Users/her" })).toBe(
      "/Users/her/Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json",
    );
    expect(obsConfigPath("linux", { HOME: "/home/her" })).toBe(
      "/home/her/.config/obs-studio/plugin_config/obs-websocket/config.json",
    );
  });

  it("respects XDG_CONFIG_HOME", () => {
    expect(obsConfigPath("linux", { HOME: "/home/her", XDG_CONFIG_HOME: "/home/her/cfg" })).toBe(
      "/home/her/cfg/obs-studio/plugin_config/obs-websocket/config.json",
    );
  });

  // Not an error: the server may be a VPS with no OBS and no home directory,
  // and the settings form is the answer there.
  it("has no answer without the variable it needs", () => {
    expect(obsConfigPath("win32", {})).toBeNull();
    expect(obsConfigPath("darwin", {})).toBeNull();
  });
});

describe("readObsConfig", () => {
  it("reads what OBS wrote", () => {
    expect(readObsConfig(obsFile())).toEqual({
      enabled: true,
      port: 4455,
      authRequired: true,
      password: "k9Xw2mQpZ4vT8nBc",
    });
  });

  it("keeps the enabled flag, because off is the state she has to fix", () => {
    expect(readObsConfig(obsFile({ server_enabled: false }))?.enabled).toBe(false);
  });

  it("treats a missing auth flag as required, the way OBS defaults it", () => {
    const config = readObsConfig(JSON.stringify({ server_port: 4455, server_password: "x" }));
    expect(config?.authRequired).toBe(true);
  });

  it("carries the password even when auth is off, and lets resolve drop it", () => {
    const config = readObsConfig(obsFile({ auth_required: false }))!;
    expect(config.password).toBe("k9Xw2mQpZ4vT8nBc");
    expect(resolveSettings(defaultSettings(), config).password).toBe("");
  });

  // The file belongs to another program. A surprise is her settings form, not
  // a crash on stream night.
  it("shrugs at anything it does not recognise", () => {
    expect(readObsConfig("")).toBeNull();
    expect(readObsConfig("{ not json")).toBeNull();
    expect(readObsConfig("null")).toBeNull();
    expect(readObsConfig("[1,2,3]")).toBeNull();
    expect(readObsConfig(obsFile({ server_port: "4455" }))).toBeNull();
    expect(readObsConfig(obsFile({ server_port: 70000 }))).toBeNull();
  });
});

describe("resolveSettings", () => {
  it("takes the port and password OBS generated for itself", () => {
    const resolved = resolveSettings(defaultSettings(), readObsConfig(obsFile({ server_port: 4499 })));
    expect(resolved).toEqual({
      mode: "auto",
      host: OBS_DEFAULT_HOST,
      port: 4499,
      password: "k9Xw2mQpZ4vT8nBc",
    });
  });

  it("leaves her own settings alone", () => {
    const manual = { mode: "manual" as const, host: "10.0.0.5", port: 4455, password: "mine" };
    expect(resolveSettings(manual, readObsConfig(obsFile()))).toEqual(manual);
  });

  it("falls back to the defaults when there is no OBS to read", () => {
    expect(resolveSettings(defaultSettings(), null)).toEqual({
      mode: "auto",
      host: OBS_DEFAULT_HOST,
      port: OBS_DEFAULT_PORT,
      password: "",
    });
  });
});

describe("obsStatus", () => {
  const at = { host: "127.0.0.1", port: 4455 };

  it("counts scenes in words, not in ones", () => {
    expect(obsStatus({ ...at, phase: "connected", scenes: 1 }).detail).toContain("1 scene");
    expect(obsStatus({ ...at, phase: "connected", scenes: 8 }).detail).toContain("8 scenes");
  });

  it("names the one thing she can do when the server is off", () => {
    const status = obsStatus({ ...at, phase: "off" });
    expect(status.state).toBe("disconnected");
    expect(status.detail).toContain("Tools → WebSocket Server Settings");
  });

  // A refused password is an error rather than a disconnection on purpose: it
  // never becomes true on its own, so the retry loop stops and the line has to
  // tell her that waiting will not help.
  it("treats a refused password as an error she has to act on", () => {
    const status = obsStatus({ ...at, phase: "rejected" });
    expect(status.state).toBe("error");
    expect(status.detail).toContain("refused the password");
    expect(status.detail).not.toContain("Retrying");
  });

  it("never puts the failure text in front of her", () => {
    const status = obsStatus({ ...at, phase: "down", detail: "connect ECONNREFUSED 127.0.0.1:4455" });
    expect(status.detail).not.toContain("ECONNREFUSED");
    expect(status.detail).toContain("OBS is not running");
  });
});
