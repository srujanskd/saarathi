import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * The two or three things the shell remembers about itself. Deliberately not
 * in the server's state file: that one is hers -- challenges, deck, spin
 * history -- and it moves to a VPS one day, where "start with Windows" means
 * nothing.
 */

export interface Prefs {
  /** Undefined means never asked, which is what makes the first run default. */
  launchAtLogin?: boolean;
}

export function readPrefs(file: string): Prefs {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed === "object" && parsed !== null) return parsed as Prefs;
  } catch {
    // No prefs yet, or something wrote nonsense. Defaults are safe here, so a
    // broken file is not worth a dialog on startup.
  }
  return {};
}

export function writePrefs(file: string, prefs: Prefs): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(prefs, null, 2)}\n`);
}

export function prefsPath(userData: string): string {
  return join(userData, "desktop.json");
}
