import { describe, expect, it } from "vitest";
import { hostsIn, scamIn, withoutLinks } from "../../src/core/screen.js";

describe("screening viewer text", () => {
  it("swaps exactly the links hostsIn finds, and nothing else", () => {
    const text = "go to bit.ly/free or https://www.evil.tk/x?y=1 and i did 12.5 reps...then more";
    expect(withoutLinks(text, "(link)")).toBe("go to (link) or (link) and i did 12.5 reps...then more");
    expect(hostsIn(withoutLinks(text, "(link)"))).toEqual([]);
  });

  it("names the scam shape in words she can read", () => {
    expect(scamIn("message me on telegram for coaching")).toBe("Asks people to message an account off-platform");
    expect(scamIn("Congratulations winner, claim your prize")).toBe("Fake giveaway win");
    expect(scamIn("one more set!")).toBeNull();
  });
});
