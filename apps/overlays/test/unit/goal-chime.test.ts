import { describe, expect, it } from "vitest";
import { CHIME, chimeSeconds } from "../../src/modules/goals/chime.js";

describe("the goal chime", () => {
  it("is over fast, because it plays while she is mid set", () => {
    // Anything that rings is something she mutes once and never unmutes.
    expect(chimeSeconds()).toBeLessThan(1);
  });

  it("goes up, so it reads as an arrival rather than a warning", () => {
    const [first, second] = CHIME;
    expect(second!.hertz).toBeGreaterThan(first!.hertz);
    expect(second!.startsAt).toBeGreaterThan(first!.startsAt);
  });

  it("is measured from the moment it starts, so nothing plays before it", () => {
    expect(CHIME.every((voice) => voice.startsAt >= 0 && voice.seconds > 0)).toBe(true);
  });
});
