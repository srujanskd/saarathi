import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prefsPath, readPrefs, shouldEnableLaunchAtLogin, writePrefs } from "../../src/prefs.js";

let dir: string | null = null;
const scratch = () => (dir = mkdtempSync(join(tmpdir(), "saarathi-prefs-")));

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("prefs", () => {
  it("says nothing on a first run, which is what makes the default a default", () => {
    expect(readPrefs(join(scratch(), "desktop.json")).launchAtLogin).toBeUndefined();
  });

  it("remembers what she chose, so unticking it sticks across a restart", () => {
    const file = prefsPath(scratch());
    writePrefs(file, { launchAtLogin: false });
    expect(readPrefs(file).launchAtLogin).toBe(false);
  });

  it("falls back to defaults rather than throwing on a broken file", () => {
    const file = prefsPath(scratch());
    writeFileSync(file, "{ not json");
    expect(readPrefs(file)).toEqual({});
  });
});

describe("turning start-with-Windows on by itself", () => {
  const installed = { platform: "win32" as NodeJS.Platform, packaged: true };

  it("does it once, on the first run of an installed copy", () => {
    expect(shouldEnableLaunchAtLogin({ ...installed, prefs: {} })).toBe(true);
  });

  it("never argues with her, whichever way she set it", () => {
    expect(shouldEnableLaunchAtLogin({ ...installed, prefs: { launchAtLogin: false } })).toBe(false);
    expect(shouldEnableLaunchAtLogin({ ...installed, prefs: { launchAtLogin: true } })).toBe(false);
  });

  it("leaves a checkout alone, which would otherwise follow whoever ran it home", () => {
    expect(shouldEnableLaunchAtLogin({ ...installed, packaged: false, prefs: {} })).toBe(false);
  });

  it("is a Windows setting, and she is on Windows", () => {
    expect(shouldEnableLaunchAtLogin({ ...installed, platform: "darwin", prefs: {} })).toBe(false);
  });
});
