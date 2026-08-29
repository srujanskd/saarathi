import { describe, expect, it } from "vitest";
import { boundsToSave, deckWindowBounds, DECK_WINDOW_DEFAULT } from "../../src/deck-window.js";

const laptop = { x: 0, y: 0, width: 1920, height: 1040 };
const second = { x: 1920, y: 0, width: 1920, height: 1080 };

describe("deckWindowBounds", () => {
  it("places it itself the first time, rather than guessing a corner", () => {
    expect(deckWindowBounds(undefined, [laptop])).toEqual(DECK_WINDOW_DEFAULT);
  });

  it("puts it back where she left it", () => {
    const saved = { x: 1500, y: 300, width: 420, height: 500 };
    expect(deckWindowBounds(saved, [laptop])).toEqual(saved);
  });

  it("keeps the size but forgets the place when that monitor is gone", () => {
    // She unplugs the second screen between streams. A window remembered onto
    // it is one she cannot move, cannot close, and will call broken.
    const saved = { x: 2400, y: 200, width: 420, height: 500 };
    expect(deckWindowBounds(saved, [laptop, second])).toEqual(saved);
    expect(deckWindowBounds(saved, [laptop])).toEqual({ width: 420, height: 500 });
  });

  it("treats a sliver hanging off the edge as lost, not as found", () => {
    const sliver = { x: 1880, y: 1020, width: 380, height: 460 };
    expect(deckWindowBounds(sliver, [laptop])).toEqual({ width: 380, height: 460 });
  });

  it("refuses a size too small to press a button in", () => {
    const bounds = deckWindowBounds({ x: 10, y: 10, width: 40, height: 20 }, [laptop]);
    expect(bounds).toMatchObject({ width: 240, height: 220 });
  });

  it("rounds, because a scaled display hands back fractions", () => {
    expect(deckWindowBounds({ x: 10.4, y: 10.6, width: 380.2, height: 460.8 }, [laptop])).toEqual({
      x: 10,
      y: 11,
      width: 380,
      height: 461,
    });
  });
});

describe("boundsToSave", () => {
  it("rounds what goes to disk, so an idle window stops rewriting the file", () => {
    expect(boundsToSave({ x: 10.4, y: 10.6, width: 380.2, height: 460.8 })).toEqual({
      x: 10,
      y: 11,
      width: 380,
      height: 461,
    });
  });
});
