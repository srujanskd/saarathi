import { describe, expect, it } from "vitest";
import { LOCKDOWN_MS } from "@saarathi/shared";
import { lockdownLeft, purgeLine } from "../../src/modules/moderation/lockdown.js";

const NOW = 1_760_000_000_000;

describe("lockdownLeft", () => {
  it("is blank when lockdown was never on", () => {
    expect(lockdownLeft(null, NOW)).toBe("");
  });

  it("is blank the moment it has run out, not a fraction after", () => {
    // Blank is what her card branches on, so this comparison is the one place
    // that decides whether lockdown is on at all.
    expect(lockdownLeft(NOW, NOW)).toBe("");
    expect(lockdownLeft(NOW - 1, NOW)).toBe("");
    expect(lockdownLeft(NOW + 1, NOW)).not.toBe("");
  });

  it("counts a full window in minutes", () => {
    expect(lockdownLeft(NOW + LOCKDOWN_MS, NOW)).toBe("5m left");
  });

  it("rounds minutes down, so it never claims more time than she has", () => {
    // Four minutes and one second is "4m left". Rounding the other way says
    // 5m with four on the clock, which is the version where she stops watching
    // chat a minute early.
    expect(lockdownLeft(NOW + 241_000, NOW)).toBe("4m left");
    expect(lockdownLeft(NOW + 119_000, NOW)).toBe("1m left");
    expect(lockdownLeft(NOW + 60_000, NOW)).toBe("1m left");
  });

  it("switches to seconds for the last minute", () => {
    expect(lockdownLeft(NOW + 59_000, NOW)).toBe("59s left");
    expect(lockdownLeft(NOW + 1_500, NOW)).toBe("2s left");
    // Rounds up here, so it never reads "0s left" while it is still on.
    expect(lockdownLeft(NOW + 1, NOW)).toBe("1s left");
  });

  it("reads the server's clock, not the phone's", () => {
    // The argument is `serverNow`, and a phone routinely disagrees with the
    // server by tens of seconds. Passing a client clock here is what makes a
    // five minute lockdown render as over.
    const skewed = NOW - 40_000;
    expect(lockdownLeft(NOW + 20_000, skewed)).toBe("1m left");
  });
});

describe("purgeLine", () => {
  it("says nothing before she has swept anything", () => {
    expect(purgeLine(null)).toBe("");
  });

  it("counts what it took down", () => {
    expect(purgeLine({ at: NOW, removed: 7, left: 0 })).toBe("Took down 7 messages");
    expect(purgeLine({ at: NOW, removed: 1, left: 0 })).toBe("Took down 1 message");
  });

  it("says why the rows still on screen are still on screen", () => {
    // Otherwise a sweep that worked and a button that did nothing look the
    // same: the rows it removed are gone and the rest look untouched.
    expect(purgeLine({ at: NOW, removed: 7, left: 2 })).toBe(
      "Took down 7 messages · 2 left that came with no message to take down",
    );
  });

  it("explains a sweep that could take nothing down", () => {
    // The demo case, and the one where "0 removed" on its own reads as broken
    // software rather than as a fact about her platform.
    expect(purgeLine({ at: NOW, removed: 0, left: 3 })).toBe(
      "3 left that came with no message to take down",
    );
  });

  it("has something to say even for a sweep with nothing to report", () => {
    expect(purgeLine({ at: NOW, removed: 0, left: 0 })).toBe("Nothing to take down");
  });
});
