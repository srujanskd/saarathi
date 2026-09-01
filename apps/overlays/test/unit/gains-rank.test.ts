import { describe, expect, it } from "vitest";
import { balanceText, place, rowSummary, streakText } from "../../src/modules/gains/rank.js";

describe("place", () => {
  it("gives the top three a medal, because a colour is not a rank at 1vh", () => {
    expect([place(0), place(1), place(2)]).toEqual(["🥇", "🥈", "🥉"]);
  });

  it("numbers the rest from four", () => {
    expect(place(3)).toBe("4");
    expect(place(9)).toBe("10");
  });
});

describe("balanceText", () => {
  it("is exact under a thousand, which is where every balance starts", () => {
    expect(balanceText(0)).toBe("0");
    expect(balanceText(940)).toBe("940");
    expect(balanceText(999)).toBe("999");
  });

  it("abbreviates a balance that would push the row off the overlay", () => {
    expect(balanceText(1_000)).toBe("1k");
    expect(balanceText(9_400)).toBe("9.4k");
  });

  it("drops the decimal past ten thousand, where it is the character that wraps", () => {
    expect(balanceText(37_200)).toBe("37k");
    expect(balanceText(1_240_000)).toBe("1240k");
  });

  it("never leaves a trailing .0", () => {
    expect(balanceText(2_000)).toBe("2k");
  });
});

describe("streakText", () => {
  it("says nothing about a first stream, which is not an achievement", () => {
    expect(streakText(0)).toBeNull();
    expect(streakText(1)).toBeNull();
  });

  it("badges a run from two", () => {
    expect(streakText(2)).toBe("🔥2");
    expect(streakText(14)).toBe("🔥14");
  });
});

describe("rowSummary", () => {
  const row = { id: "u1", name: "Asha", balance: 1_240, streak: 1 };

  it("groups the balance, since her card has room for the real number", () => {
    expect(rowSummary(row)).toBe("1,240 gains");
  });

  it("mentions a run of streams and not a first one", () => {
    expect(rowSummary({ ...row, streak: 4 })).toContain("4 streams in a row");
    expect(rowSummary(row)).not.toContain("in a row");
  });
});
