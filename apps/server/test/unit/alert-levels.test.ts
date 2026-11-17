import { describe, expect, it } from "vitest";
import { PAID_TIERS, PAID_TIER_SAMPLES } from "@saarathi/shared";
import { defaultLevels, levelOf, parseLevels, restoreLevels, sizeOf } from "../../src/modules/media/levels.js";

const clips = new Set(["horn", "meme"]);

describe("paid alert levels", () => {
  it("starts with one level per rung, and a preview amount for each", () => {
    expect(defaultLevels()).toEqual([1, 2, 3, 4, 5, 6, 7].map((from) => ({ from })));
    expect(PAID_TIER_SAMPLES).toHaveLength(PAID_TIERS);
  });

  it("puts every rung on exactly one of five grouped levels, and an unbanded one on the first", () => {
    const five = [{ from: 1 }, { from: 3 }, { from: 4 }, { from: 5 }, { from: 6 }];
    expect([1, 2, 3, 4, 5, 6, 7].map((tier) => levelOf(five, tier))).toEqual([1, 1, 2, 3, 4, 5, 5]);
    expect(levelOf(five, undefined)).toBe(1);
  });

  it("spreads her levels over every size, so the top one is always the biggest", () => {
    expect([1, 2, 3, 4, 5].map((level) => sizeOf(level, 5))).toEqual([1, 3, 4, 6, 7]);
    expect([1, 2].map((level) => sizeOf(level, 2))).toEqual([1, 7]);
    expect([1, 2, 3, 4, 5, 6, 7].map((level) => sizeOf(level, 7))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(sizeOf(1, 1)).toBe(1);
  });

  it("accepts levels that start at 1 and climb, with intros from her library", () => {
    expect(parseLevels([{ from: 1, introId: "horn" }, { from: 6 }], clips)).toEqual([{ from: 1, introId: "horn" }, { from: 6 }]);
  });

  it("refuses a gap, an overlap, a rung that does not exist, too many levels or a clip that is gone", () => {
    expect(parseLevels([], clips)).toBe("Keep at least one level");
    expect(parseLevels("[]", clips)).toBe("Keep at least one level");
    expect(parseLevels([{ from: 2 }], clips)).toBe("The first level has to start at the smallest");
    expect(parseLevels([{ from: 1 }, { from: 4 }, { from: 4 }], clips)).toBe("Each level has to start above the one before it");
    expect(parseLevels([{ from: 1 }, { from: 3 }, { from: 2 }], clips)).toBe("Each level has to start above the one before it");
    expect(parseLevels([{ from: 1 }, { from: 8 }], clips)).toMatch(/from 1 to 7/);
    expect(parseLevels([{ from: 1.5 }], clips)).toMatch(/from 1 to 7/);
    expect(parseLevels([null], clips)).toBe("Each level needs a starting size");
    expect(parseLevels(Array.from({ length: 8 }, (_, index) => ({ from: index + 1 })), clips)).toBe("Use at most 7 levels");
    expect(parseLevels([{ from: 1, introId: "gone" }], clips)).toBe("That intro clip is gone");
    expect(parseLevels([{ from: 1, introId: 7 }], clips)).toBe("That intro clip is gone");
  });

  it("restores saved levels, dropping a missing clip but keeping its level, and goes back to the default when they make no sense", () => {
    expect(restoreLevels([{ from: 1, introId: "gone" }, { from: 4, introId: "meme" }], clips))
      .toEqual([{ from: 1 }, { from: 4, introId: "meme" }]);
    expect(restoreLevels([{ from: 3 }], clips)).toEqual(defaultLevels());
    expect(restoreLevels(undefined, clips)).toEqual(defaultLevels());
  });
});
