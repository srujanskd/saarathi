/**
 * The deck's third face: her grid as a small window that floats over OBS.
 *
 * The window is frameless, so the shell has to draw its own way to move it and
 * its own way out. Both are injected into the page rather than built into it:
 * `deck.html` is served to her phone, a tablet and a touchscreen monitor as
 * well, and none of those want a drag strip. The page stays one page and the
 * shell owns its own chrome, which is the same split `?server=` makes -- the
 * page knows nothing about where it is running.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Tall enough for two rows of thumb-sized keys, narrow enough to sit beside
 * OBS rather than on top of what she is looking at. */
export const DECK_WINDOW_DEFAULT = { width: 380, height: 460 } as const;
const MIN_WIDTH = 240;
const MIN_HEIGHT = 220;

/** How much of the window has to land on a screen for it to count as findable.
 * A window remembered on a monitor she has since unplugged is a window she
 * cannot move, cannot close, and will assume is broken. */
const VISIBLE_W = 120;
const VISIBLE_H = 60;

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  };
}

/**
 * Where to open it: where she left it, if that is still somewhere she can see,
 * and centred on the primary screen otherwise.
 *
 * Returns a size with no position when there is nothing saved, which is
 * Electron's own way of saying "you place it".
 */
export function deckWindowBounds(
  saved: Partial<Rect> | undefined,
  workAreas: readonly Rect[],
): Rect | { width: number; height: number } {
  const size = {
    width: Math.max(MIN_WIDTH, Math.round(saved?.width ?? DECK_WINDOW_DEFAULT.width)),
    height: Math.max(MIN_HEIGHT, Math.round(saved?.height ?? DECK_WINDOW_DEFAULT.height)),
  };
  if (typeof saved?.x !== "number" || typeof saved?.y !== "number") return size;

  const wanted: Rect = { x: Math.round(saved.x), y: Math.round(saved.y), ...size };
  const visible = workAreas.some((area) => {
    const seen = overlap(wanted, area);
    return seen.width >= VISIBLE_W && seen.height >= VISIBLE_H;
  });
  return visible ? wanted : size;
}

/** What gets written back when she moves or resizes it. Rounded because
 * Electron hands back fractional bounds on a scaled display and a prefs file
 * that churns on every open is a prefs file that will eventually be half
 * written when the machine sleeps. */
export function boundsToSave(bounds: Rect): Rect {
  return {
    x: Math.round(bounds.x),
    y: Math.round(bounds.y),
    width: Math.round(bounds.width),
    height: Math.round(bounds.height),
  };
}

/**
 * The chrome, as one script run once the page has loaded.
 *
 * A string rather than a file for the reason the QR window is one: it has no
 * state, no socket and no reason to reload, and giving the shell a build step
 * that reaches into the overlay bundle would tie the two together for two
 * dozen lines of CSS.
 *
 * The close button is not optional. Frameless means Windows draws no ✕, and
 * "open it from the tray again" is not a way out of something covering her
 * scene -- if you add a way in, you add the way out and the way to see it.
 */
export const DECK_WINDOW_CHROME = `
(() => {
  if (document.getElementById("saarathi-grip")) return;
  const style = document.createElement("style");
  style.textContent = \`
    body { padding-top: 30px; }
    #saarathi-grip {
      position: fixed; inset: 0 0 auto 0; height: 30px;
      display: flex; align-items: center; justify-content: space-between;
      padding: 0 0 0 10px;
      background: rgb(0 0 0 / 0.35);
      -webkit-app-region: drag;
      user-select: none; z-index: 999;
    }
    #saarathi-grip .grip {
      flex: 1; height: 100%;
      background-image: radial-gradient(currentColor 1px, transparent 1px);
      background-size: 5px 5px; background-position: 0 12px;
      background-repeat: repeat-x;
      color: rgb(255 255 255 / 0.25);
    }
    #saarathi-grip button {
      -webkit-app-region: no-drag;
      width: 42px; height: 30px; padding: 0;
      border: 0; background: transparent; cursor: pointer;
      color: rgb(255 255 255 / 0.55); font-size: 15px; line-height: 1;
    }
    #saarathi-grip button:hover { background: #c4362f; color: #fff; }
  \`;
  document.head.appendChild(style);

  const bar = document.createElement("div");
  bar.id = "saarathi-grip";
  const grip = document.createElement("div");
  grip.className = "grip";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "\\u2715";
  close.title = "Close the deck window";
  close.setAttribute("aria-label", "Close the deck window");
  close.addEventListener("click", () => window.saarathi?.closeDeckWindow());
  bar.append(grip, close);
  document.body.prepend(bar);
})();
`;
