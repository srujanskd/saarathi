import { contextBridge, ipcRenderer } from "electron";

/**
 * One function, for one button.
 *
 * The floating deck window is frameless, so its close button is drawn by the
 * shell into a page that is otherwise served to her phone. That button needs
 * to reach the shell, and this is the whole of what it is allowed to say.
 * Context isolation stays on and node integration stays off: the page it is
 * attached to talks to the server over a socket and has no business holding
 * anything of Electron's.
 */
contextBridge.exposeInMainWorld("saarathi", {
  closeDeckWindow: () => ipcRenderer.send("deck-window:close"),
});
