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

/* WCAG relative luminance and contrast, so the palette's separation is a
   number this suite can hold rather than a claim in a comment. */
const luminance = (hex: string) => {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

const contrast = (a: string, b: string) => {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
};

/** What wheel.css fills `.wedge-label` with. */
const LABEL_INK = "#fdfdfb";

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

  // Two different colours are not enough. Chat watches this through an encoder
  // that keeps brightness detail and throws away colour detail at edges, so a
  // seam between two hues of the same lightness is the one that smears while
  // the wheel is turning. The palette is built on rungs 1.35x apart and comes
  // out at 1.3466 once the rungs are rounded to 8-bit hex; 1.3 is the floor it
  // may not drop through.
  it("keeps a lightness step across every seam, at any wheel size", () => {
    for (const count of COUNTS.filter((n) => n > 1)) {
      for (let index = 0; index < count; index++) {
        const next = (index + 1) % count;
        const [here, there] = [wedgeColour(index, count), wedgeColour(next, count)];
        expect(
          contrast(here, there),
          `count ${count}: wedge ${index} (${here}) and ${next} (${there}) are the same lightness`,
        ).toBeGreaterThan(1.3);
      }
    }
  });

  // The label sits on top of the wedge, over her camera, at whatever bitrate
  // YouTube gave her. 5:1 is the floor for every wedge, not an average -- and
  // the brightest wedge is *placed* by this floor, so it sits within a
  // rounding step of 5.00 rather than comfortably above it. That is the
  // constraint, not a near miss: the rungs above use up the whole range
  // between here and the darkest wedge, and buying headroom on this end costs
  // it on the seam between the top two rungs.
  it("stays dark enough for a white label on every wedge", () => {
    for (const count of COUNTS) {
      for (let index = 0; index < count; index++) {
        const wedge = wedgeColour(index, count);
        expect(
          contrast(LABEL_INK, wedge),
          `count ${count}: wedge ${index} (${wedge}) is too light for the label`,
        ).toBeGreaterThanOrEqual(5);
      }
    }
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
    expect(elapsedOf(1_000, 3_500)).toBe(2_500);
  });

  it("never goes backwards, however far ahead the caller's clock is", () => {
    expect(elapsedOf(10_000, 0)).toBe(0);
    expect(elapsedOf(10_000, 9_999)).toBe(0);
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
