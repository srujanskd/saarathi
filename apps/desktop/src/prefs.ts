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
  /**
   * Where she last left the floating deck window. Here rather than in the
   * server's state because it is about this machine's screens: her deck moves
   * to a VPS one day and a window position does not go with it.
   */
  deckWindow?: { x?: number; y?: number; width?: number; height?: number };
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

/**
 * Whether this run is the one that turns "start with Windows" on by itself.
 *
 * Only ever the first run of an installed copy on her machine: "install once
 * and it is just there" is the whole promise, and every run after reads what
 * she chose, so unticking it sticks. Never out of the repo -- a checkout that
 * registered itself at login would follow whoever ran `pnpm dev` home -- and
 * never off Windows, which has its own login-items model she is not on.
 */
export function shouldEnableLaunchAtLogin(inputs: {
  platform: NodeJS.Platform;
  packaged: boolean;
  prefs: Prefs;
}): boolean {
  return (
    inputs.platform === "win32" &&
    inputs.packaged &&
    inputs.prefs.launchAtLogin === undefined
  );
}

export function prefsPath(userData: string): string {
  return join(userData, "desktop.json");
}
