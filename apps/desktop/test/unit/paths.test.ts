import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePaths } from "../../src/paths.js";

// Built with node:path rather than written out, because this suite runs on
// Windows too and that is the whole reason these four values are a function.
const inputs = {
  resourcesPath: resolve("/opt/Saarathi/resources"),
  distDir: resolve("/repo/apps/desktop/dist"),
  userData: resolve("/Users/her/Saarathi"),
};

describe("resolvePaths", () => {
  it("puts her state under userData, packaged or not", () => {
    for (const packaged of [true, false]) {
      const paths = resolvePaths({ ...inputs, packaged });
      // Never cwd/data: a packaged app's cwd is wherever the shortcut pointed,
      // and the install directory is not writable on Windows.
      expect(paths.stateFile).toBe(join(inputs.userData, "state.json"));
      expect(paths.logDir).toBe(join(inputs.userData, "logs"));
    }
  });

  it("reads the server and the pages out of resources once packaged", () => {
    const paths = resolvePaths({ ...inputs, packaged: true });
    expect(paths.serverEntry).toBe(join(inputs.resourcesPath, "server.mjs"));
    expect(paths.overlaysDist).toBe(join(inputs.resourcesPath, "overlays"));
    expect(paths.trayIcon).toBe(join(inputs.resourcesPath, "tray.png"));
  });

  it("finds all three beside the bundle when it is run out of the repo", () => {
    const paths = resolvePaths({ ...inputs, packaged: false });
    // dist/server.mjs, not dist/dist/server.mjs. Deriving this from
    // app.getAppPath() cost a boot: Electron hands back dist when it is given
    // a file and apps/desktop when it is given a directory.
    expect(paths.serverEntry).toBe(join(inputs.distDir, "server.mjs"));
    expect(paths.overlaysDist).toBe(resolve("/repo/apps/overlays/dist"));
    expect(paths.trayIcon).toBe(resolve("/repo/apps/desktop/resources/tray.png"));
  });

  it("finds the preload beside main either way, because it rides in the asar", () => {
    // The one file Electron itself loads rather than the plain Node child, so
    // it is the one file allowed to be inside the archive. It is packed by
    // name in electron-builder.config.mjs -- a `files` list that still said
    // only main.cjs would leave the floating deck with no way to close it,
    // and only on an installed build.
    for (const packaged of [true, false]) {
      expect(resolvePaths({ ...inputs, packaged }).preload).toBe(
        join(inputs.distDir, "preload.cjs"),
      );
    }
  });
});
