import { describe, expect, it } from "vitest";
import { SPIN_DURATION_MS, type ActiveSpin } from "@saarathi/shared";
import {
  HOLD_MS,
  HUB_RADIUS,
  RADIUS,
  TURNS,
  elapsedOf,
  labelFontSize,
  maxLabelChars,
  phaseOf,
  segments,
  targetRotation,
  wedgeColour,
} from "../../src/modules/wheel/geometry.js";

/** Every wheel size anyone would plausibly build, and several nobody would. */
const COUNTS = Array.from({ length: 40 }, (_, index) => index + 1);

const wheelOf = (count: number) =>
  segments(Array.from({ length: count }, (_, index) => `challenge ${index}`));

/** Degrees, folded to the shortest distance from zero. */
const offBy = (degrees: number) => {
  const wrapped = ((degrees % 360) + 360) % 360;
  return Math.min(wrapped, 360 - wrapped);
};

describe("where the wheel stops", () => {
  it("puts the segment it named under the pointer", () => {
    for (const count of COUNTS) {
      for (const { index, centre } of wheelOf(count)) {
        expect(offBy(targetRotation(index, count) + centre)).toBeLessThan(1e-9);
      }
    }
  });

  it("only ever turns clockwise, and always far enough to look like a spin", () => {
    for (const count of COUNTS) {
      for (const { index } of wheelOf(count)) {
        const rotation = targetRotation(index, count);
        // A wheel that sometimes goes backwards reads as a bug to chat.
        expect(rotation).toBeGreaterThan(0);
        expect(rotation).toBeGreaterThan((TURNS - 1) * 360);
        expect(rotation).toBeLessThanOrEqual(TURNS * 360);
      }
    }
  });
});

describe("wedge colours", () => {
  it("never puts two of the same next to each other, at any wheel size", () => {
    for (const count of COUNTS.filter((n) => n > 1)) {
      for (let index = 0; index < count; index++) {
        // Including the seam from the last wedge back round to the first,
        // which is the one the modulo gets wrong on its own.
        const next = (index + 1) % count;
        expect(
          wedgeColour(index, count),
          `count ${count}: wedge ${index} and ${next} share a colour`,
        ).not.toBe(wedgeColour(next, count));
      }
    }
  });

  it("is the same colour on every spin, so the wheel does not reshuffle itself", () => {
    expect(wedgeColour(3, 10)).toBe(wedgeColour(3, 10));
  });
});

describe("labels", () => {
  it("cuts them to what fits between the hub and the rim, and says it cut them", () => {
    for (const count of COUNTS) {
      const budget = maxLabelChars(count);
      const wordy = Array.from({ length: count }, () => "a challenge name ".repeat(8).trim());
      expect(wordy[0]!.length).toBeGreaterThan(budget);
      for (const segment of segments(wordy)) {
        expect(segment.label.length).toBeLessThanOrEqual(budget);
        // The ellipsis is the only thing telling her the wheel is not showing
        // the whole challenge. Cutting silently is worse than cutting.
        expect(segment.label.endsWith("…")).toBe(true);
      }
    }
  });

  it("leaves one that already fits alone", () => {
    expect(segments(["20 squats"])[0]!.label).toBe("20 squats");
  });

  it("shrinks the type as the wheel fills up, but not past readable", () => {
    expect(labelFontSize(10)).toBeGreaterThan(labelFontSize(20));
    expect(labelFontSize(20)).toBeGreaterThan(labelFontSize(40));
    expect(labelFontSize(500)).toBe(labelFontSize(40));
  });

  it("always leaves room for at least a short challenge", () => {
    for (const count of COUNTS) expect(maxLabelChars(count)).toBeGreaterThanOrEqual(6);
  });

  it("orients every one the same way, because the wheel turns under them", () => {
    const wheel = wheelOf(12);
    // The flip that would keep the left half upright cannot work: these rotate
    // with the wheel, so any fixed choice is wrong at some rotation. Consistent
    // is the requirement, not upright.
    expect(new Set(wheel.map((segment) => segment.labelAnchor)).size).toBe(1);
    expect(new Set(wheel.map((segment) => segment.labelX)).size).toBe(1);
    for (const segment of wheel) {
      expect(segment.labelTransform).toContain(`rotate(${segment.centre} 50 50)`);
    }
  });

  it("sits inside the rim and clear of the hub", () => {
    const [segment] = wheelOf(8);
    expect(segment!.labelX).toBeLessThan(RADIUS);
    expect(segment!.labelX).toBeGreaterThan(HUB_RADIUS);
  });
});

describe("wedge paths", () => {
  it("draws one per challenge, with nothing undrawable in it", () => {
    for (const count of COUNTS) {
      const wheel = wheelOf(count);
      expect(wheel).toHaveLength(count);
      for (const segment of wheel) expect(segment.path).not.toMatch(/NaN|Infinity/);
    }
  });

  it("draws a single challenge as two arcs, because one arc cannot close 360 degrees", () => {
    expect(segments(["everything"])[0]!.path.match(/A /g)).toHaveLength(2);
  });
});

const spinAt = (startedAt: number): ActiveSpin => ({
  index: 0,
  label: "20 squats",
  by: "Viewer",
  via: "chat",
  startedAt,
  durationMs: SPIN_DURATION_MS,
  wheel: ["20 squats", "30s plank"],
});

/**
 * `now` is server time, handed in rather than read from the clock. These are
 * the cases a client on another machine actually hits: `?server=` exists so the
 * server can be a VPS while the page runs on her phone, and a phone's clock is
 * routinely tens of seconds out.
 */
describe("how far into the spin we are", () => {
  it("is the distance from the start", () => {
    expect(elapsedOf(spinAt(1_000), 3_500)).toBe(2_500);
  });

  it("never goes backwards, however far ahead the caller's clock is", () => {
    expect(elapsedOf(spinAt(10_000), 0)).toBe(0);
    expect(elapsedOf(spinAt(10_000), 9_999)).toBe(0);
  });
});

describe("which phase the overlay is in", () => {
  it("is hidden with no spin at all", () => {
    expect(phaseOf(null, 0)).toBe("hidden");
  });

  it("spins until the animation is done, then holds, then hides", () => {
    const spin = spinAt(0);
    expect(phaseOf(spin, 0)).toBe("spinning");
    expect(phaseOf(spin, SPIN_DURATION_MS - 1)).toBe("spinning");
    expect(phaseOf(spin, SPIN_DURATION_MS)).toBe("landed");
    expect(phaseOf(spin, SPIN_DURATION_MS + HOLD_MS - 1)).toBe("landed");
    expect(phaseOf(spin, SPIN_DURATION_MS + HOLD_MS)).toBe("hidden");
  });

  /**
   * The bug this replaces: with an uncorrected clock, a phone 40 seconds ahead
   * of the server computed an elapsed past the hold and rendered nothing at
   * all, so a live spin was simply invisible. Corrected, the same wall-clock
   * instant is `spinning`.
   */
  it("shows a live spin to a client whose clock is 40 seconds out", () => {
    const serverClock = 1_000;
    const spin = spinAt(serverClock);

    // Her phone, 40 seconds ahead of the VPS. Reading its own clock puts the
    // spin past the hold and renders nothing, which is the bug: a live spin
    // simply invisible.
    const phoneClock = serverClock + 40_000;
    expect(phaseOf(spin, phoneClock)).toBe("hidden");

    // The correction the snapshot enables, computed exactly as `connect` does.
    const offsetMs = serverClock - phoneClock;
    expect(phaseOf(spin, phoneClock + offsetMs)).toBe("spinning");
  });
});
