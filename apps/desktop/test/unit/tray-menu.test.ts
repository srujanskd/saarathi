import { describe, expect, it } from "vitest";
import { links } from "../../src/net.js";
import { statusLabel, trayMenu, trayTooltip, type MenuView } from "../../src/tray-menu.js";

const base: MenuView = {
  status: { phase: "running" },
  links: links("192.168.1.24", 4400),
  port: 4400,
  platform: "win32",
  packaged: true,
  launchAtLogin: true,
  update: { phase: "idle" },
  deckWindowOpen: false,
  hotkeys: "No hotkeys set",
  overlays: [
    { id: "wheel", title: "Challenge wheel" },
    { id: "media", title: "Media" },
  ],
};

const ids = (view: MenuView) => trayMenu(view).map((item) => item.id);
const item = (view: MenuView, id: string) => trayMenu(view).find((entry) => entry.id === id);

describe("statusLabel", () => {
  it("names the address she can reach while it is running", () => {
    expect(statusLabel(base.status, base.links, 4400)).toBe("Running · http://192.168.1.24:4400");
  });

  it("says so when there is no network, instead of naming localhost", () => {
    expect(statusLabel(base.status, null, 4400)).toBe("Running · port 4400, no network");
  });

  it("carries the reason it is restarting, because there is no console", () => {
    expect(statusLabel({ phase: "restarting", detail: "EADDRINUSE" }, base.links, 4400)).toBe(
      "Restarting · EADDRINUSE",
    );
  });

  it("names the port when something else has it", () => {
    expect(statusLabel({ phase: "port-busy" }, null, 4400)).toBe("Port 4400 is already in use");
  });
});

describe("trayMenu", () => {
  it("offers every declared overlay, so a media deck button has somewhere to render in OBS", () => {
    expect(item(base, "copy-overlay:wheel")!.label).toBe("Copy Challenge wheel overlay URL for OBS");
    expect(item(base, "copy-overlay:media")!.label).toBe("Copy Media overlay URL for OBS");
  });

  it("puts what is true at the top and the way out at the bottom", () => {
    const menu = trayMenu(base);
    expect(menu[0]!.id).toBe("status");
    expect(menu[0]!.enabled).toBe(false);
    expect(menu.at(-1)!.id).toBe("quit");
  });

  it("keeps every item in place while the server is down, only disabled", () => {
    const down = { ...base, status: { phase: "stopped" } } as MenuView;
    // A menu that grows and shrinks moves the next item under her finger, and
    // she is opening this mid-workout.
    expect(ids(down)).toEqual(ids(base));
    expect(item(down, "open-control")!.enabled).toBe(false);
    expect(item(base, "open-control")!.enabled).toBe(true);
  });

  it("will not offer a QR code when there is no address to put in it", () => {
    expect(item({ ...base, links: null }, "connect-phone")!.enabled).toBe(false);
  });

  it("says Try again rather than Restart after a port clash", () => {
    const busy = { ...base, status: { phase: "port-busy" } } as MenuView;
    expect(item(busy, "restart-server")!.label).toBe("Try again");
    expect(item(base, "restart-server")!.label).toBe("Restart server");
  });

  it("offers start-with-Windows only on Windows", () => {
    expect(ids(base)).toContain("launch-at-login");
    expect(ids({ ...base, platform: "darwin" })).not.toContain("launch-at-login");
  });

  it("reflects what she chose rather than what we set", () => {
    expect(item(base, "launch-at-login")!.checked).toBe(true);
    expect(item({ ...base, launchAtLogin: false }, "launch-at-login")!.checked).toBe(false);
  });

  it("says nothing about updates when it is running out of the repo", () => {
    const dev = { ...base, packaged: false };
    expect(ids(dev)).not.toContain("check-updates");
    expect(ids(dev)).not.toContain("install-update");
  });

  it("turns into an install once an update is downloaded", () => {
    const ready = { ...base, update: { phase: "ready" } } as MenuView;
    expect(item(ready, "install-update")!.label).toBe("Restart to install update");
    expect(ids(ready)).not.toContain("check-updates");
  });

  it("does not invite a second check while one is running", () => {
    const checking = { ...base, update: { phase: "checking" } } as MenuView;
    expect(item(checking, "check-updates")!.enabled).toBe(false);
  });

  it("puts a failed check in the menu and nowhere else", () => {
    const failed = { ...base, update: { phase: "error", detail: "getaddrinfo ENOTFOUND" } };
    expect(item(failed as MenuView, "check-updates")!.label).toContain("getaddrinfo ENOTFOUND");
  });
});

describe("trayTooltip", () => {
  it("is the same truth, one line, without opening anything", () => {
    expect(trayTooltip(base)).toBe("Saarathi · Running · http://192.168.1.24:4400");
  });
});

describe("the deck's other two faces", () => {
  it("offers the floating deck as one item with two states, not two items", () => {
    const closed = item(base, "deck-window")!;
    expect(closed.type).toBe("checkbox");
    expect(closed.checked).toBe(false);
    expect(item({ ...base, deckWindowOpen: true }, "deck-window")!.checked).toBe(true);
  });

  it("greys the floating deck while the server is down, rather than hiding it", () => {
    const down = { ...base, status: { phase: "stopped" } as const };
    expect(ids(down)).toContain("deck-window");
    expect(item(down, "deck-window")!.enabled).toBe(false);
  });

  it("stays the way out of a window that outlived its server", () => {
    // Frameless, always on top, sitting over her scene. Greying this out
    // because the server died leaves her nothing to close it with.
    const orphaned = { ...base, status: { phase: "stopped" } as const, deckWindowOpen: true };
    expect(item(orphaned, "deck-window")!.enabled).toBe(true);
  });

  it("says what the hotkeys are doing whatever the answer, and never as a button", () => {
    const none = item(base, "hotkeys")!;
    expect(none.label).toBe("No hotkeys set");
    expect(none.enabled).toBe(false);
    // Same position, same count: a line that only appears when something is
    // wrong moves everything under her finger exactly when she is in a hurry.
    const busy = { ...base, hotkeys: "Ctrl+Alt+1 in use by something else" };
    expect(ids(busy)).toEqual(ids(base));
    expect(item(busy, "hotkeys")!.label).toBe("Ctrl+Alt+1 in use by something else");
  });

  it("distinguishes the two ways to open her deck", () => {
    expect(item(base, "open-deck")!.label).toBe("Open deck in browser");
    expect(item(base, "deck-window")!.label).toBe("Floating deck");
  });
});
