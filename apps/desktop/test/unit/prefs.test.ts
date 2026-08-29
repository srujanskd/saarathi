import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prefsPath, readPrefs, writePrefs } from "../../src/prefs.js";

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
