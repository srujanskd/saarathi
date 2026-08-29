import { describe, expect, it } from "vitest";
import { lastError, spawnPlan } from "../../src/server-process.js";

describe("spawnPlan", () => {
  const plan = spawnPlan({
    execPath: "/opt/Saarathi/Saarathi.exe",
    entry: "/opt/Saarathi/resources/server.mjs",
    stateFile: "/Users/her/Saarathi/state.json",
    overlaysDist: "/opt/Saarathi/resources/overlays",
    port: 4400,
  });

  it("runs Electron's own binary as Node, so the installer ships one runtime", () => {
    expect(plan.command).toBe("/opt/Saarathi/Saarathi.exe");
    expect(plan.env.ELECTRON_RUN_AS_NODE).toBe("1");
  });

  // These four names are the entire contract between the shell and the server.
  // A rename on either side has to break something, and this is the something.
  it("hands the server every path it must not decide for itself", () => {
    expect(plan.env.STATE_FILE).toBe("/Users/her/Saarathi/state.json");
    expect(plan.env.OVERLAYS_DIST).toBe("/opt/Saarathi/resources/overlays");
    expect(plan.env.PORT).toBe("4400");
    // The fourth, and the one nothing else would notice going missing: the
    // child logs to a file she opens from the menu, so a level nobody set is a
    // support story that says nothing.
    expect(plan.env.LOG_LEVEL).toBe("info");
    expect(plan.args).toEqual(["/opt/Saarathi/resources/server.mjs"]);
  });

  it("lets the shell pick the level, since the log is the whole support story", () => {
    const debug = spawnPlan({
      execPath: "/x/Saarathi.exe",
      entry: "/x/server.mjs",
      stateFile: "/x/state.json",
      overlaysDist: "/x/overlays",
      port: 4400,
      logLevel: "debug",
    });
    expect(debug.env.LOG_LEVEL).toBe("debug");
  });
});

describe("lastError", () => {
  it("pulls the message out of pino's JSON, since a raw tail is unreadable", () => {
    const line = JSON.stringify({ level: 50, msg: "listen EADDRINUSE: address already in use" });
    expect(lastError([line])).toBe("listen EADDRINUSE: address already in use");
  });

  it("ignores anything quieter than an error, which is not why it exited", () => {
    expect(lastError([JSON.stringify({ level: 30, msg: "Server listening" })])).toBeNull();
  });

  it("takes the last error, not the first", () => {
    const lines = [
      JSON.stringify({ level: 50, msg: "first" }),
      JSON.stringify({ level: 50, msg: "second" }),
    ];
    expect(lastError(lines)).toBe("second");
  });

  it("falls back to the raw line when the server died before pino did", () => {
    expect(lastError(["Error: Cannot find module '/x/server.mjs'"])).toContain("Cannot find module");
  });

  it("says nothing rather than something wrong when there is no error in there", () => {
    expect(lastError(["", "starting up"])).toBeNull();
  });
});
