import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { app, BrowserWindow, clipboard, Menu, nativeImage, shell, Tray } from "electron";
import { autoUpdater } from "electron-updater";
import QRCode from "qrcode";
import { SERVER_PORT } from "@saarathi/shared";
import { connectPageHtml, connectTargets, type ConnectEntry } from "./connect-page.js";
import { lanAddress, links as makeLinks, type Links } from "./net.js";
import { ServerLog } from "./logs.js";
import { resolvePaths } from "./paths.js";
import { prefsPath, readPrefs, writePrefs } from "./prefs.js";
import { ServerProcess, type ServerStatus } from "./server-process.js";
import { trayMenu, trayTooltip, type MenuAction, type MenuView, type UpdateState } from "./tray-menu.js";
import { Updates } from "./updates.js";

/**
 * The tray. It owns four things and decides none of them: it starts the
 * server as a child, keeps a menu in sync with what that child is doing, opens
 * her pages in a browser, and shows a window with two QR codes on it.
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
    switch (action) {
      case "open-control":
        if (current.links) await shell.openExternal(current.links.control);
        break;
      case "open-deck":
        if (current.links) await shell.openExternal(current.links.deck);
        break;
      case "connect-phone":
        await openConnectWindow(current.links);
        break;
      case "copy-overlay":
        // The overlay URL is the one address she pastes rather than opens, and
        // it is long enough to mistype. Nothing else on this menu copies.
        if (current.links) clipboard.writeText(current.links.overlay);
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

  async function openConnectWindow(current: Links | null): Promise<void> {
    if (!current) return;
    if (connectWindow && !connectWindow.isDestroyed()) {
      connectWindow.show();
      connectWindow.focus();
      return;
    }
    const entries: ConnectEntry[] = await Promise.all(
      connectTargets(current).map(async (target) => ({
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
    });
    await window.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(connectPageHtml(entries))}`,
    );
  }

  await app.whenReady();

  // A tray app, not a window app: a dock icon on macOS is a window she can
  // close and then wonder where the app went. Windows has no equivalent.
  app.dock?.hide();

  tray = new Tray(trayImage(paths.trayIcon));
  tray.setIgnoreDoubleClickEvents(true);
  render();

  // First run on her machine turns this on, because "install once and it is
  // just there" is the whole promise. Every run after reads what she chose,
  // so unticking it sticks.
  const prefs = readPrefs(prefsFile);
  if (process.platform === "win32" && prefs.launchAtLogin === undefined && app.isPackaged) {
    app.setLoginItemSettings({ openAtLogin: true });
    writePrefs(prefsFile, { ...prefs, launchAtLogin: true });
  }

  await server.start();
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
      await server.stop();
      log.close();
      app.quit();
    })();
  });
}

/** An empty image still gives her a clickable tray slot, which is a better
 * failure than a shell that throws on startup over an icon. */
function trayImage(file: string): Electron.NativeImage {
  const image = nativeImage.createFromPath(file);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}
