import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SPIN_DURATION_MS } from "@saarathi/shared";
import { harness, wheelState, type Harness } from "../helpers/kernel.js";

/**
 * She can save a new challenge list at any time, including while the wheel is
 * still turning -- "Save challenges" is on the control page and the deck, and
 * nothing stops her pressing it mid-spin.
 *
 * `spin.index` only means anything against the list it was drawn from, so a
 * spin that did not carry its own wheel would have an overlay recompute the
 * wedges from the new list and land the pointer on something that is not
 * `spin.label`. Freezing the list client-side does not fix it either: an
 * overlay that reloads after the edit was never there to freeze the old one.
 */
let live: Harness | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

const settled = () => vi.advanceTimersByTimeAsync(0);

describe("saving challenges while the wheel is turning", () => {
  it("leaves the spin pointing at the wheel it was drawn from", async () => {
    const h = (live = await harness());

    await h.kernel.invoke("wheel.setChallenges", { args: ["a", "b", "c", "d"] });
    await settled();

    const start = await h.kernel.invoke("wheel.spin");
    expect(start.ok).toBe(true);

    const spin = wheelState(h.kernel).spin!;
    expect(spin.wheel).toEqual(["a", "b", "c", "d"]);

    // Halfway through the animation, she saves a shorter list.
    await vi.advanceTimersByTimeAsync(SPIN_DURATION_MS / 2);
    await h.kernel.invoke("wheel.setChallenges", { args: ["x", "y"] });
    await settled();

    const after = wheelState(h.kernel);
    expect(after.challenges).toEqual(["x", "y"]);

    // The live spin is untouched: same wheel, same index, and the label still
    // agrees with the wedge that index names. Without `spin.wheel`, an overlay
    // would draw two wedges and put the pointer on one of them.
    expect(after.spin!.wheel).toEqual(["a", "b", "c", "d"]);
    expect(after.spin!.index).toBe(spin.index);
    expect(after.spin!.wheel[after.spin!.index]).toBe(after.spin!.label);
  });

  it("draws the next spin from the new list", async () => {
    const h = (live = await harness());

    await h.kernel.invoke("wheel.setChallenges", { args: ["a", "b"] });
    await settled();
    await h.kernel.invoke("wheel.spin");

    // Past the animation and the settle window, so the wheel is free again.
    await vi.advanceTimersByTimeAsync(SPIN_DURATION_MS * 2);
    await h.kernel.invoke("wheel.setChallenges", { args: ["x", "y", "z"] });
    await settled();

    const second = await h.kernel.invoke("wheel.spin");
    expect(second.ok).toBe(true);
    expect(wheelState(h.kernel).spin!.wheel).toEqual(["x", "y", "z"]);
  });
});
