import { readFileSync } from "node:fs";

/**
 * Packaging config as a script rather than YAML for one reason: the version.
 *
 * The whole product is one version and it lives in the root package.json --
 * she installs one thing, and the workspace packages' versions are noise. So
 * the installer's version is read from there rather than from the package it
 * happens to be built out of, which is also what stops a tag from disagreeing
 * with the file it produced.
 */
const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

export default {
  appId: "app.saarathi.tray",
  productName: "Saarathi",
  copyright: `Copyright © ${new Date().getFullYear()} Saarathi contributors`,
  extraMetadata: { version: root.version },
  directories: { output: "release", buildResources: "resources" },

  // Everything the app runs is inside these two bundles: there is no
  // node_modules to walk, which is the point. See build.mjs.
  // The preload is inside the asar with main, because Electron is what loads
  // it. Everything the plain Node child reads is in extraResources below.
  files: ["dist/main.cjs", "dist/preload.cjs", "!dist/**/*.map"],

  extraResources: [
    // The server is spawned as a real file by a child process, so it stays
    // outside the asar. The pages are static files Fastify serves off disk.
    { from: "dist/server.mjs", to: "server.mjs" },
    { from: "resources/tray.png", to: "tray.png" },
    { from: "resources/tray@2x.png", to: "tray@2x.png" },
    { from: "../overlays/dist", to: "overlays" },
  ],

  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    icon: "resources/icon.ico",
  },
  nsis: {
    // One click, no options page, no admin prompt: it installs per-user into
    // LocalAppData, which is also what lets auto-update replace it without
    // UAC. She is the only user of that machine.
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "Saarathi",
  },
  // Otherwise it is named after the package -- "@saarathidesktop-updater" --
  // in a directory she may one day be asked to look in.
  updaterCacheDirName: "saarathi-updater",

  // A macOS build exists so this can be run and looked at on a development
  // machine. She is on Windows and nothing publishes it.
  mac: { target: [{ target: "dir", arch: ["arm64"] }], icon: "resources/icon.png" },

  publish: [{ provider: "github", owner: "srujanskd", repo: "saarathi" }],
};
