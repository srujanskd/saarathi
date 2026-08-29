import type { Links } from "./net.js";
import type { ServerStatus } from "./server-process.js";

/**
 * The menu as data. Electron's Menu wants click handlers, which are the one
 * part of a menu no test can read, so the labels, the ordering and every
 * "is this item even here" decision live in a pure function and main.ts binds
 * actions to ids. This is the whole surface of the app for her: if it says
 * the wrong thing, she has nowhere else to look.
 */

export type MenuAction =
  | "status"
  | "open-control"
  | "open-deck"
  | "deck-window"
  | "hotkeys"
  | "connect-phone"
  | "copy-overlay"
  | "restart-server"
  | "open-logs"
  | "launch-at-login"
  | "check-updates"
  | "install-update"
  | "quit";

export interface MenuItemSpec {
  readonly id: MenuAction | "separator";
  readonly label?: string;
  readonly type?: "separator" | "checkbox";
  readonly enabled?: boolean;
  readonly checked?: boolean;
}

export type UpdatePhase = "idle" | "checking" | "downloading" | "ready" | "error" | "unavailable";

export interface UpdateState {
  readonly phase: UpdatePhase;
  readonly detail?: string;
}

export interface MenuView {
  readonly status: ServerStatus;
  readonly links: Links | null;
  readonly port: number;
  readonly platform: NodeJS.Platform;
  /** Installed, rather than run out of the repo. */
  readonly packaged: boolean;
  readonly launchAtLogin: boolean;
  readonly update: UpdateState;
  /** The floating deck window is open. A checkbox rather than two items,
   * because it is one thing with two states and she is reading this fast. */
  readonly deckWindowOpen: boolean;
  /** Already in her words -- `hotkeyNote` decides what it says, because what
   * counts as a working hotkey is that file's business, not this one's. */
  readonly hotkeys: string;
}

/**
 * The first line of the menu, and the tray tooltip. It says what is true and
 * what to do about it, because "a stack trace in a console she will never look
 * at" is the failure mode this whole app exists to avoid.
 */
export function statusLabel(status: ServerStatus, links: Links | null, port: number): string {
  switch (status.phase) {
    case "running":
      return links ? `Running · ${links.origin}` : `Running · port ${port}, no network`;
    case "starting":
      return "Starting…";
    case "restarting":
      return status.detail ? `Restarting · ${status.detail}` : "Restarting…";
    case "port-busy":
      return status.detail ?? `Port ${port} is already in use`;
    case "failed":
      return status.detail ?? "Server failed to start";
    case "stopped":
      return "Stopped";
  }
}

function updateLabel(update: UpdateState): string {
  switch (update.phase) {
    case "checking":
      return "Checking for updates…";
    case "downloading":
      return "Downloading update…";
    case "ready":
      return "Restart to install update";
    case "error":
      return update.detail ? `Update failed · ${update.detail}` : "Update check failed";
    case "unavailable":
    case "idle":
      return "Check for updates";
  }
}

export function trayMenu(view: MenuView): MenuItemSpec[] {
  const live = view.status.phase === "running";
  const reachable = live && view.links !== null;
  const items: MenuItemSpec[] = [
    { id: "status", label: statusLabel(view.status, view.links, view.port), enabled: false },
    { id: "separator", type: "separator" },
    // Disabled rather than hidden while the server is down: a menu that grows
    // and shrinks moves everything else under her finger, and she is opening
    // this mid-workout.
    { id: "open-control", label: "Open control page", enabled: live },
    { id: "open-deck", label: "Open deck in browser", enabled: live },
    {
      id: "deck-window",
      label: "Floating deck",
      type: "checkbox",
      checked: view.deckWindowOpen,
      enabled: live,
    },
    // Disabled, and there whatever the answer is. An item that only appeared
    // when something was wrong would move everything under it exactly when she
    // is opening this in a hurry, and "no hotkeys set" is the state she is
    // most likely to be trying to confirm.
    { id: "hotkeys", label: view.hotkeys, enabled: false },
    { id: "connect-phone", label: "Connect your phone…", enabled: reachable },
    { id: "copy-overlay", label: "Copy overlay URL for OBS", enabled: live },
    { id: "separator", type: "separator" },
    {
      id: "restart-server",
      // Same item, two truths. After a port clash the thing to do is try again
      // once she has closed the other copy, and "Restart" invites her to press
      // it on something that never started.
      label: view.status.phase === "port-busy" ? "Try again" : "Restart server",
    },
    { id: "open-logs", label: "Open logs folder" },
  ];

  // macOS has its own login-items model and she is not on it; this is her
  // Windows machine's setting, and offering it anywhere else is a lie.
  if (view.platform === "win32") {
    items.push(
      { id: "separator", type: "separator" },
      {
        id: "launch-at-login",
        label: "Start with Windows",
        type: "checkbox",
        checked: view.launchAtLogin,
      },
    );
  }

  // Nothing to update when it is running out of the repo, and a menu item that
  // always errors there is noise in the one place noise is expensive.
  if (view.packaged) {
    items.push(
      { id: "separator", type: "separator" },
      view.update.phase === "ready"
        ? { id: "install-update", label: updateLabel(view.update) }
        : {
            id: "check-updates",
            label: updateLabel(view.update),
            enabled: view.update.phase !== "checking" && view.update.phase !== "downloading",
          },
    );
  }

  items.push({ id: "separator", type: "separator" }, { id: "quit", label: "Quit Saarathi" });
  return items;
}

/** What hovering the tray icon says. Same truth, one line, no menu. */
export function trayTooltip(view: MenuView): string {
  return `Saarathi · ${statusLabel(view.status, view.links, view.port)}`;
}
