import { join, resolve } from "node:path";

/**
 * Where the three things the shell hands the server actually are. Packaged and
 * run-from-the-repo disagree about all of them, and that disagreement is the
 * cheapest thing in this app to get silently wrong: a wrong overlays path
 * serves her a JSON hint instead of a wheel, and a wrong state path writes her
 * challenge list somewhere Program Files will not let it land.
 */

export interface PathInputs {
  /** Installed, rather than run out of the repo. */
  readonly packaged: boolean;
  /** Electron's resources directory, where extraResources land. */
  readonly resourcesPath: string;
  /**
   * The directory the running main bundle sits in. Not app.getAppPath():
   * `electron dist/main.cjs` makes that dist/ already, and `electron .` makes
   * it apps/desktop, so anything derived from it is right in one of the two.
   * __dirname is the same directory in both, packaged or not.
   */
  readonly distDir: string;
  /** app.getPath("userData"). */
  readonly userData: string;
}

export interface ResolvedPaths {
  readonly serverEntry: string;
  readonly overlaysDist: string;
  readonly stateFile: string;
  readonly logDir: string;
  readonly trayIcon: string;
}

export function resolvePaths(inputs: PathInputs): ResolvedPaths {
  return {
    // Both live beside the asar rather than inside it. The server is spawned
    // as a real file path by a child process, and reading it back out of an
    // archive is a dependency on Electron's fs patches that a plain
    // ELECTRON_RUN_AS_NODE child has no reason to be relying on.
    serverEntry: inputs.packaged
      ? join(inputs.resourcesPath, "server.mjs")
      : join(inputs.distDir, "server.mjs"),
    overlaysDist: inputs.packaged
      ? join(inputs.resourcesPath, "overlays")
      : resolve(inputs.distDir, "..", "..", "overlays", "dist"),
    // Never cwd/data: the server's own default is a developer's default, and
    // a packaged app's cwd is wherever the shortcut that launched it pointed.
    stateFile: join(inputs.userData, "state.json"),
    logDir: join(inputs.userData, "logs"),
    // A path rather than a buffer because Electron picks the @2x sibling up
    // itself, and her monitor and mine disagree about which one that is.
    trayIcon: inputs.packaged
      ? join(inputs.resourcesPath, "tray.png")
      : resolve(inputs.distDir, "..", "resources", "tray.png"),
  };
}
