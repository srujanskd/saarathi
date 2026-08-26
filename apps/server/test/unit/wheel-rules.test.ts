import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHALLENGES,
  SPIN_DURATION_MS,
  type ActiveSpin,
  type WheelState,
} from "@saarathi/shared";
import { SETTLE_MS, planSpin, spinBlockedFor } from "../../src/modules/wheel/rules.js";

const state = (extra: Partial<WheelState> = {}): WheelState => ({
  challenges: [...DEFAULT_CHALLENGES],
  spin: null,
  queue: [],
  history: [],
  ...extra,
});

const activeSpin = (startedAt: number): ActiveSpin => ({
  index: 0,
  label: "20 squats",
  by: "Viewer",
  via: "chat",
  startedAt,
  durationMs: SPIN_DURATION_MS,
});

/** The instant a spin started at 0 stops blocking. */
const FREE_AT = SPIN_DURATION_MS + SETTLE_MS;

describe("spinBlockedFor", () => {
  it("is free with nothing on the wheel", () => {
    expect(spinBlockedFor(null, 0)).toBe(0);
  });

  it("counts the animation plus the settle window", () => {
    expect(spinBlockedFor(activeSpin(0), 0)).toBe(FREE_AT);
    expect(spinBlockedFor(activeSpin(0), SPIN_DURATION_MS)).toBe(SETTLE_MS);
    expect(spinBlockedFor(activeSpin(0), FREE_AT - 1)).toBe(1);
  });

  it("is free on the tick the settle window closes", () => {
    expect(spinBlockedFor(activeSpin(0), FREE_AT)).toBe(0);
  });

  it("never reports a negative wait for a long-finished spin", () => {
    expect(spinBlockedFor(activeSpin(0), 10 * FREE_AT)).toBe(0);
  });
});

describe("planSpin", () => {
  const input = { by: "Viewer", via: "chat" as const, now: 1_000, random: () => 0 };

  it("refuses an empty wheel", () => {
    const result = planSpin(state({ challenges: [] }), input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("nothing on the wheel");
  });

  it("refuses while a spin is still on screen", () => {
    const result = planSpin(state({ spin: activeSpin(1_000) }), { ...input, now: 1_001 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("still spinning");
  });

  it("refuses inside the settle window, after the animation has ended", () => {
    const busy = state({ spin: activeSpin(0) });
    expect(planSpin(busy, { ...input, now: SPIN_DURATION_MS + 1 }).ok).toBe(false);
    expect(planSpin(busy, { ...input, now: FREE_AT }).ok).toBe(true);
  });

  it("refuses her own trigger too, because two spins have no meaning on screen", () => {
    const busy = state({ spin: activeSpin(0) });
    for (const via of ["chat", "paid", "gains", "deck", "control", "auto"] as const) {
      expect(planSpin(busy, { ...input, via, now: 1 }).ok, via).toBe(false);
    }
  });

  it("has no cooldown of its own: back-to-back spins are allowed once the wheel is free", () => {
    const first = planSpin(state(), { ...input, now: 0 });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // A cooldown lives on the !spin binding, not here.
    expect(planSpin(state({ spin: first.spin }), { ...input, now: FREE_AT }).ok).toBe(true);
  });

  it("picks by the injected random and reports the matching label", () => {
    const challenges = ["a", "b", "c", "d"];
    for (const [roll, index] of [
      [0, 0],
      [0.24, 0],
      [0.25, 1],
      [0.5, 2],
      [0.999, 3],
    ] as const) {
      const result = planSpin(state({ challenges }), { ...input, random: () => roll });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.spin.index, `roll ${roll}`).toBe(index);
        expect(result.spin.label).toBe(challenges[index]);
      }
    }
  });

  it("cannot land off the end of the wheel when random returns its ceiling", () => {
    const challenges = ["a", "b"];
    const result = planSpin(state({ challenges }), { ...input, random: () => 0.9999999999 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spin.index).toBe(1);
      expect(result.spin.label).toBe("b");
    }
  });

  it("carries the trigger through, so the overlay can say who caused it", () => {
    const result = planSpin(state(), { by: "Big Tipper", via: "paid", now: 42, random: () => 0 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.spin).toMatchObject({
        by: "Big Tipper",
        via: "paid",
        startedAt: 42,
        durationMs: SPIN_DURATION_MS,
      });
    }
  });

  it("does not read the clock itself", () => {
    const result = planSpin(state(), { ...input, now: 12_345 });
    if (result.ok) expect(result.spin.startedAt).toBe(12_345);
  });
});
