import { describe, expect, it } from "vitest";
import { SPIN_DURATION_MS, type ActiveSpin } from "@saarathi/shared";
import { phaseKicker, queueSummary, spinCaption } from "../../src/modules/wheel/caption.js";

const spin = (over: Partial<ActiveSpin> = {}): ActiveSpin => ({
  index: 0,
  label: "20 squats",
  by: "anita",
  via: "chat",
  startedAt: 1_000,
  durationMs: SPIN_DURATION_MS,
  wheel: ["20 squats"],
  ...over,
});

describe("what her phone says about the wheel", () => {
  it("is idle before anything has happened", () => {
    expect(spinCaption(null, 0)).toEqual({
      phase: "idle",
      label: "Nothing on the wheel yet",
      by: "",
    });
  });

  it("names the challenge while it is still turning", () => {
    expect(spinCaption(spin(), 1_000 + SPIN_DURATION_MS - 1)).toMatchObject({
      phase: "spinning",
      label: "20 squats",
      by: "anita",
      remainingSec: 1,
    });
  });

  it("counts whole seconds left, because a phone is read at arm's length", () => {
    expect(spinCaption(spin(), 1_000).remainingSec).toBe(Math.ceil(SPIN_DURATION_MS / 1000));
  });

  it("keeps the challenge up after it lands, because she still has to do it", () => {
    expect(spinCaption(spin(), 1_000 + SPIN_DURATION_MS)).toMatchObject({
      phase: "landed",
      label: "20 squats",
    });
  });

  it("puts the phase in a kicker so the big text can stay the challenge", () => {
    expect(phaseKicker(spinCaption(null, 0))).toBe("Ready");
    expect(phaseKicker(spinCaption(spin(), 1_000 + SPIN_DURATION_MS))).toBe("Do this");
    expect(phaseKicker(spinCaption(spin(), 1_000))).toBe(
      `Spinning, ${Math.ceil(SPIN_DURATION_MS / 1000)}s left`,
    );
  });
});

describe("the queue on her phone", () => {
  it("says nothing when nobody is waiting", () => {
    expect(queueSummary([], true)).toBeNull();
  });

  it("uses the full name, unlike the overlay card on her camera", () => {
    expect(queueSummary([{ by: "a very long viewer name", via: "paid", at: 1 }], true)).toBe(
      "a very long viewer name is next",
    );
  });

  it("counts when more than one person is waiting", () => {
    expect(
      queueSummary(
        [
          { by: "anita", via: "paid", at: 1 },
          { by: "priya", via: "paid", at: 2 },
        ],
        true,
      ),
    ).toBe("2 waiting, anita is next");
  });

  it("explains the stall when there is nothing to spin", () => {
    expect(queueSummary([{ by: "anita", via: "paid", at: 1 }], false)).toBe(
      "1 spin waiting, nothing on the wheel yet",
    );
  });
});
