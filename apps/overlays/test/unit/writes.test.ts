import { describe, expect, it } from "vitest";
import type { ChatWritesView } from "@saarathi/shared";
import { writesLine } from "../../src/core/writes.js";

const meter = (over: Partial<ChatWritesView> = {}): ChatWritesView => ({
  adapter: "youtube",
  used: 12,
  ceiling: 200,
  reserve: 50,
  ...over,
});

describe("writesLine", () => {
  it("reads as writes, never as units", () => {
    // Units are the thing nothing can measure. Writes are the thing we count.
    const line = writesLine(meter(), "youtube");
    expect(line).toBe("12 of 200 writes today · 50 kept back for moderation");
  });

  it("says nothing on the card of an adapter that is not the one writing", () => {
    // One meter, one card. This is what keeps it off the other platform's card
    // without this file knowing either platform's name.
    expect(writesLine(meter(), "twitch")).toBe("");
    expect(writesLine(meter({ adapter: null }), "youtube")).toBe("");
  });

  it("says the bot has gone quiet once only the reserve is left", () => {
    // Rendering "150 of 200" here would show her room that replies cannot use.
    expect(writesLine(meter({ used: 150 }), "youtube")).toBe(
      "150 of 200 writes today · only moderation can write now",
    );
  });

  it("still says so when moderation has spent past the ceiling", () => {
    expect(writesLine(meter({ used: 214 }), "youtube")).toContain("only moderation");
  });

  it("groups a number she would otherwise have to count digits in", () => {
    expect(writesLine(meter({ used: 1_100, ceiling: 2_000 }), "youtube")).toContain("1,100 of 2,000");
  });
});
