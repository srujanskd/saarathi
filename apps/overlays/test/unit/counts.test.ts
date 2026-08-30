import { describe, expect, it } from "vitest";
import type { ChannelStats } from "@saarathi/shared";
import { countsLine } from "../../src/core/counts.js";

const stats = (counts: ChannelStats["counts"]): ChannelStats => ({ counts, detail: "ok" });

describe("countsLine", () => {
  it("reads both numbers when both are there", () => {
    expect(countsLine(stats({ subscribers: 940, likes: 97 }))).toBe("940 subscribers · 97 likes");
  });

  it("leaves out a count that is not available rather than showing a zero", () => {
    // No live stream, so there are no likes. A "0 likes" here is a goal bar
    // that reads empty and never says why.
    expect(countsLine(stats({ subscribers: 940 }))).toBe("940 subscribers");
    expect(countsLine(stats({ likes: 97 }))).toBe("97 likes");
  });

  it("says nothing at all when there is nothing yet", () => {
    expect(countsLine(stats({}))).toBe("");
    expect(countsLine(undefined)).toBe("");
  });

  it("keeps a real zero, which is where every stream's likes start", () => {
    expect(countsLine(stats({ likes: 0 }))).toBe("0 likes");
  });

  it("counts one of something in the singular", () => {
    expect(countsLine(stats({ subscribers: 1, likes: 1 }))).toBe("1 subscriber · 1 like");
  });

  it("groups a big number but never abbreviates it", () => {
    // YouTube has already rounded this to three significant figures. Rounding
    // it again into "38K" moves the bar by more than the real steps.
    expect(countsLine(stats({ subscribers: 37700 }))).toContain("37,700");
  });
});
