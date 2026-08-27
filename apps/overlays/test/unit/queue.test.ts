import { describe, expect, it } from "vitest";
import { queueNote } from "../../src/modules/wheel/queue.js";

describe("what the overlay says about waiting spins", () => {
  it("says nothing when nobody is waiting", () => {
    expect(queueNote(0, "", true)).toBeNull();
  });

  it("counts one spin without pluralising it", () => {
    expect(queueNote(1, "anita", true)?.title).toBe("1 spin queued");
  });

  it("counts the rest", () => {
    expect(queueNote(4, "anita", true)?.title).toBe("4 spins queued");
  });

  it("names whoever is next, so the person who paid can see themselves", () => {
    expect(queueNote(3, "anita", true)?.detail).toBe("anita is next");
  });

  // The one way the queue stalls: the server drains it the moment the wheel is
  // free, so anything longer than a spin means there is nothing to spin.
  it("explains the stall instead of naming a name that is going nowhere", () => {
    expect(queueNote(2, "anita", false)?.detail).toBe("nothing on the wheel yet");
  });

  it("cuts a name that would push the card across her camera", () => {
    const detail = queueNote(1, "a".repeat(40), true)!.detail;
    expect(detail).toBe(`${"a".repeat(17)}… is next`);
  });

  it("leaves a name that fits alone", () => {
    const name = "a".repeat(18);
    expect(queueNote(1, name, true)?.detail).toBe(`${name} is next`);
  });

  it("trims a name padded out to look longer than it is", () => {
    expect(queueNote(1, "  anita  ", true)?.detail).toBe("anita is next");
  });
});
