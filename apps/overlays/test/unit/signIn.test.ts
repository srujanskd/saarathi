import { describe, expect, it } from "vitest";
import { codeExpiry } from "../../src/core/signIn.js";

const NOW = 1_760_000_000_000;
const at = (ms: number) => ({ code: "ABCD-EFGH", url: "https://x.test", expiresAt: NOW + ms });

describe("codeExpiry", () => {
  it("says nothing when no sign-in is waiting", () => {
    expect(codeExpiry(undefined, NOW)).toBe("");
  });

  it("counts the minutes down, rounding down", () => {
    // Never claims more time than the code has: she is walking to a laptop.
    expect(codeExpiry(at(600_000), NOW)).toBe("10 minutes left to type it");
    expect(codeExpiry(at(119_000), NOW)).toBe("1 minute left to type it");
  });

  it("switches to seconds for the last minute", () => {
    expect(codeExpiry(at(59_000), NOW)).toBe("59s left to type it");
    expect(codeExpiry(at(1), NOW)).toBe("1s left to type it");
  });

  it("says it has run out rather than counting backwards", () => {
    expect(codeExpiry(at(0), NOW)).toBe("That code has run out");
    expect(codeExpiry(at(-90_000), NOW)).toBe("That code has run out");
  });

  it("reads the server's clock, not the phone's", () => {
    // `expiresAt` is server time and this page may be on a phone forty seconds
    // out. Passing a client `Date.now()` here is the bug this argument exists
    // to prevent.
    expect(codeExpiry(at(120_000), NOW - 60_000)).toBe("3 minutes left to type it");
  });
});
