import { networkInterfaces } from "node:os";
import { join } from "node:path";
import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray,
} from "electron";
import { autoUpdater } from "electron-updater";
import QRCode from "qrcode";
import { SERVER_PORT } from "@saarathi/shared";
import { localAccess, ServerClient } from "./client.js";
import { connectPageHtml, connectTargets, type ConnectEntry } from "./connect-page.js";
import {
  boundsToSave,
  deckWindowBounds,
  DECK_WINDOW_CHROME,
  type Rect,
} from "./deck-window.js";
import {
  hotkeyClaim,
  hotkeyNote,
  hotkeyPlan,
  HOTKEY_RETRY_MS,
  type HotkeyBinding,
} from "./hotkeys.js";
import {
  lanAddress,
  links as makeLinks,
  overlayLink,
  overlayUrl,
  pairingLink,
  type Links,
} from "./net.js";
import { ServerLog } from "./logs.js";
import { resolvePaths } from "./paths.js";
import { prefsPath, readPrefs, shouldEnableLaunchAtLogin, writePrefs } from "./prefs.js";
import { ServerProcess, type ServerStatus } from "./server-process.js";
import { trayMenu, trayTooltip, type MenuAction, type MenuView, type UpdateState } from "./tray-menu.js";
import { Updates } from "./updates.js";

/**
 * The tray. It owns six things and decides none of them: it starts the server
 * as a child, keeps a menu in sync with what that child is doing, opens her
 * pages in a browser, shows a window with two QR codes on it, floats her deck
 * over OBS, and claims the keys she put on its buttons.
 *
 * Everything with a rule in it -- which address to show, what the menu says,
 * how the child is spawned -- lives in a pure module beside this one, because
 * Electron is the one part of this repo no test can boot.
 */

// Before anything reads a path, the single-instance lock included: unpackaged,
// Electron names this directory after the package -- "@saarathi/desktop" is not
// a directory name, so it falls back to "Electron" and her state lands
// somewhere neither of us would look. Naming it here makes the build I develop
// against and the one she installs agree.
app.setName("Saarathi");
app.setPath("userData", join(app.getPath("appData"), "Saarathi"));

// One server, one port, one state file. A second copy would fight the first
// for 4400 and the loser would look like a crash, so the second launch just
// wakes the first one's window and leaves.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main(): Promise<void> {
  const paths = resolvePaths({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    distDir: __dirname,
    userData: app.getPath("userData"),
  });
  const port = Number(process.env.PORT) || SERVER_PORT;
  const prefsFile = prefsPath(app.getPath("userData"));

  const log = new ServerLog(paths.logDir);
  log.open();

  let status: ServerStatus = { phase: "starting" };
  let update: UpdateState = { phase: "idle" };
  let tray: Tray | null = null;
  let connectWindow: BrowserWindow | null = null;
  let connectExpiresAt = 0;
  let deckWindow: BrowserWindow | null = null;
  let bindings: HotkeyBinding[] = [];
  let failedKeys: HotkeyBinding[] = [];
  let hotkeyLine = hotkeyNote(bindings, failedKeys);
  /** The last grid the server published, so the retry below has something to
   * ask for again without waiting for her to touch the deck. */
  let deckSlots: Parameters<typeof hotkeyPlan>[0] = [];
  let overlays: MenuView["overlays"] = [];
  let retryTimer: NodeJS.Timeout | null = null;

  const server = new ServerProcess({
    execPath: process.execPath,
    entry: paths.serverEntry,
    stateFile: paths.stateFile,
    overlaysDist: paths.overlaysDist,
    port,
    onStatus: (next) => {
      status = next;
      log.write(`[tray] ${next.phase}${next.detail ? ` — ${next.detail}` : ""}\n`);
      render();
    },
    onLog: (line) => log.write(line),
  });

  /**
   * The shell as a client of its own server, which is what makes a hotkey and
   * a finger on the deck page the same press. It is started once and left to
   * reconnect: a restart from the menu is a gap, not an event this has to know
   * about.
   */
  const client = new ServerClient({
    port,
    onCore: (core) => {
      deckSlots = core.deck.slots;
      const nextOverlays = core.modules
        .filter((module) => module.overlay)
        .map((module) => ({ id: module.id, title: module.title }));
      const overlaysChanged =
        nextOverlays.length !== overlays.length ||
        nextOverlays.some(
          (overlay, index) =>
            overlay.id !== overlays[index]?.id || overlay.title !== overlays[index]?.title,
        );
      overlays = nextOverlays;
      applyHotkeys(deckSlots);
      if (overlaysChanged) render();
    },
    onState: (connected) => {
      if (!connected) log.write("[tray] hotkeys waiting for the server\n");
    },
    log: (line) => log.write(line),
  });

  /**
   * Claim the keys her grid asks for. Registration can fail -- Windows gives a
   * shortcut to whoever asked first -- so a failure is a state the menu
   * reports, not an error anyone throws. `hotkeyClaim` decides what that means
   * for a given grid; this only makes the calls Electron needs.
   */
  function applyHotkeys(slots: Parameters<typeof hotkeyPlan>[0]): void {
    const plan = hotkeyPlan(slots);
    const { unregisterAll, claim } = hotkeyClaim(plan, bindings, failedKeys);
    if (!unregisterAll && claim.length === 0) return;

    if (unregisterAll) globalShortcut.unregisterAll();
    const failed: HotkeyBinding[] = [];
    for (const binding of claim) {
      // register() returns false, but it also throws on an accelerator it
      // cannot parse -- which hotkeyPlan has already made impossible, and
      // which would take the tray down if it ever became possible again.
      let claimed = false;
      try {
        claimed = globalShortcut.register(binding.accelerator, () =>
          client.invoke(binding.action, binding.args),
        );
      } catch (err) {
        log.write(`[tray] hotkey ${binding.key} could not be registered: ${String(err)}\n`);
      }
      if (!claimed) failed.push(binding);
    }
    bindings = plan;
    failedKeys = failed;

    // A retry that changed nothing is not news. Saying so every thirty seconds
    // would bury the line that matters in a log she only opens when something
    // is wrong.
    const line = hotkeyNote(bindings, failedKeys);
    if (line === hotkeyLine) return;
    hotkeyLine = line;
    log.write(`[tray] ${line}\n`);
    render();
  }

  const updates = new Updates(autoUpdater, {
    onState: (next) => {
      update = next;
      render();
    },
    log: (line) => log.write(line),
  });

  /** The address she can reach, recomputed every render: Wi-Fi comes and goes,
   * and a menu holding yesterday's IP is a QR code that scans to nothing. */
  function currentLinks(): Links | null {
    const host = lanAddress(networkInterfaces());
    return host ? makeLinks(host, port) : null;
  }

  function view(): MenuView {
    return {
      status,
      links: currentLinks(),
      port,
      platform: process.platform,
      packaged: app.isPackaged,
      launchAtLogin: app.getLoginItemSettings().openAtLogin,
      update,
      deckWindowOpen: deckWindow !== null && !deckWindow.isDestroyed(),
      hotkeys: hotkeyLine,
      overlays,
    };
  }

  function render(): void {
    if (!tray) return;
    const current = view();
    tray.setToolTip(trayTooltip(current));
    tray.setContextMenu(
      Menu.buildFromTemplate(
        trayMenu(current).map((item) =>
          item.id === "separator"
            ? { type: "separator" as const }
            : {
                label: item.label,
                type: item.type,
                enabled: item.enabled,
                checked: item.checked,
                click: () => void run(item.id as MenuAction, current),
              },
        ),
      ),
    );
  }

  async function run(action: MenuAction, current: MenuView): Promise<void> {
    if (action.startsWith("copy-overlay:")) {
      const moduleId = action.slice("copy-overlay:".length);
      const declared = current.overlays.some((overlay) => overlay.id === moduleId);
      if (current.links && declared) {
        const grant = await localAccess(port);
        if (grant) {
          clipboard.writeText(
            overlayLink(overlayUrl(current.links, moduleId), grant.overlayToken),
          );
        }
      }
      return;
    }

    switch (action) {
      case "open-control":
        if (current.links) {
          const grant = await localAccess(port);
          if (grant) await shell.openExternal(pairingLink(current.links.control, grant.pairing.code));
        }
        break;
      case "open-deck":
        if (current.links) {
          const grant = await localAccess(port);
          if (grant) await shell.openExternal(pairingLink(current.links.deck, grant.pairing.code));
        }
        break;
      case "deck-window":
        if (current.deckWindowOpen) closeDeckWindow();
        else openDeckWindow();
        break;
      case "hotkeys":
        break;
      case "connect-phone":
        await openConnectWindow(current.links);
        break;
      case "restart-server":
        await server.restart();
        break;
      case "open-logs":
        await shell.openPath(paths.logDir);
        break;
      case "launch-at-login": {
        const next = !current.launchAtLogin;
        app.setLoginItemSettings({ openAtLogin: next });
        writePrefs(prefsFile, { ...readPrefs(prefsFile), launchAtLogin: next });
        render();
        break;
      }
      case "check-updates":
        await updates.check();
        break;
      case "install-update":
        updates.install();
        break;
      case "quit":
        app.quit();
        break;
      case "status":
        break;
    }
  }

  /**
   * Her deck, floating over OBS on the machine she is standing in front of.
   *
   * It loads the same `deck.html` her phone does, from the server that is
   * already serving it -- there is no second grid and no second renderer, and
   * a button she adds on her phone is on this window before she has put the
   * phone down.
   */
  function openDeckWindow(): void {
    if (deckWindow && !deckWindow.isDestroyed()) {
      deckWindow.show();
      deckWindow.focus();
      return;
    }
    const saved = readPrefs(prefsFile).deckWindow;
    const areas = screen.getAllDisplays().map((display) => display.workArea);
    const window = new BrowserWindow({
      ...deckWindowBounds(saved, areas),
      // Frameless, so it reads as a deck rather than as a browser someone left
      // open. The shell draws the strip she drags it by and the ✕ that closes
      // it, because deck.html is also served to her phone and a tablet, and
      // neither of those wants either.
      frame: false,
      resizable: true,
      minWidth: 240,
      minHeight: 220,
      title: "Deck",
      backgroundColor: "#0f1117",
      skipTaskbar: true,
      // Over OBS, which is the entire point. "floating" is enough for a
      // windowed OBS and stays out of the way of anything the OS puts above
      // it, which a screen-saver-level window would not.
      alwaysOnTop: true,
      webPreferences: {
        preload: paths.preload,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    deckWindow = window;
    window.setAlwaysOnTop(true, "floating");
    window.setMenuBarVisibility(false);

    const drawChrome = () => {
      // After the load rather than before: the page is a React app and the
      // strip is prepended to a body it has already rendered into.
      void window.webContents.executeJavaScript(DECK_WINDOW_CHROME);
    };
    window.webContents.on("did-finish-load", drawChrome);
    // And onto whatever the failure left on screen. A frameless always-on-top
    // window with no ✕ is a thing covering her scene that she cannot move and
    // cannot close, which is worse than the load having failed.
    window.webContents.on("did-fail-load", (_event, code, description) => {
      log.write(`[tray] deck window failed to load: ${description || code}\n`);
      drawChrome();
    });

    const remember = () => {
      if (window.isDestroyed()) return;
      const prefs = readPrefs(prefsFile);
      writePrefs(prefsFile, { ...prefs, deckWindow: boundsToSave(window.getBounds() as Rect) });
    };
    window.on("moved", remember);
    window.on("resized", remember);
    window.once("closed", () => {
      deckWindow = null;
      render();
    });

    // The origin it was served from is this machine, so no ?server= -- the
    // page's own fallback is right here and is the one case where it is.
    void window.loadURL(`http://127.0.0.1:${port}/deck.html`);
    render();
  }

  function closeDeckWindow(): void {
    if (deckWindow && !deckWindow.isDestroyed()) deckWindow.close();
    deckWindow = null;
    render();
  }

  async function openConnectWindow(current: Links | null): Promise<void> {
    if (!current) return;
    if (connectWindow && !connectWindow.isDestroyed()) {
      if (Date.now() < connectExpiresAt) {
        connectWindow.show();
        connectWindow.focus();
        return;
      }
      connectWindow.close();
      connectWindow = null;
    }
    const grant = await localAccess(port);
    if (!grant) return;
    connectExpiresAt = grant.pairing.expiresAt;
    const entries: ConnectEntry[] = await Promise.all(
      connectTargets(current, grant.pairing.code).map(async (target) => ({
        ...target,
        qr: await QRCode.toString(target.url, { type: "svg", margin: 0 }),
      })),
    );
    const window = new BrowserWindow({
      width: 600,
      height: 512,
      resizable: false,
      title: "Connect your phone",
      backgroundColor: "#0f1117",
      // The page is a string we just built and it talks to nothing. No preload,
      // no node integration, no reason for either.
      webPreferences: { nodeIntegration: false, contextIsolation: true },
    });
    connectWindow = window;
    window.setMenuBarVisibility(false);
    window.once("closed", () => {
      connectWindow = null;
      connectExpiresAt = 0;
    });
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(connectPageHtml(entries, grant.pairing.code))}`,
    );
  }

  await app.whenReady();

  // A tray app, not a window app: a dock icon on macOS is a window she can
  // close and then wonder where the app went. Windows has no equivalent.
  app.dock?.hide();

  // A missing icon comes back as an empty image rather than a throw, which is
  // the failure we want: a clickable tray slot with nothing drawn in it beats a
  // shell that will not start over a PNG.
  tray = new Tray(nativeImage.createFromPath(paths.trayIcon));
  tray.setIgnoreDoubleClickEvents(true);
  render();

  const prefs = readPrefs(prefsFile);
  if (shouldEnableLaunchAtLogin({ platform: process.platform, packaged: app.isPackaged, prefs })) {
    app.setLoginItemSettings({ openAtLogin: true });
    writePrefs(prefsFile, { ...prefs, launchAtLogin: true });
  }

  // The window's own ✕. It is the way out of something covering her scene, so
  // it is wired before anything can open the window.
  ipcMain.on("deck-window:close", () => closeDeckWindow());

  await server.start();
  client.start();

  // Ask again for the keys something else already owned. A grid that has none
  // makes this a no-op, and one that does is the only case where she would
  // otherwise have to edit a deck she has no reason to think is wrong.
  retryTimer = setInterval(() => {
    if (failedKeys.length > 0) applyHotkeys(deckSlots);
  }, HOTKEY_RETRY_MS);
  retryTimer.unref();
  if (app.isPackaged) updates.start();

  app.on("second-instance", () => void openConnectWindow(currentLinks()));
  // Closing the QR window is not quitting: the server keeps running and the
  // tray icon is still there. This is the default on macOS and not on Windows.
  app.on("window-all-closed", () => {
    /* the tray is the app */
  });

  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    // Stop the server first: kernel.stop() flushes the store, and a quit that
    // races it loses whatever the debounce was holding.
    event.preventDefault();
    quitting = true;
    void (async () => {
      updates.stop();
      if (retryTimer) clearInterval(retryTimer);
      // Hers, and claimed process-wide: leaving one registered after the app
      // is gone would be a key that does nothing until she reboots.
      globalShortcut.unregisterAll();
      client.stop();
      await server.stop();
      log.close();
      app.quit();
    })();
  });
}
