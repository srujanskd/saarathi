import { describe, expect, it } from "vitest";
import { WRITES_ID } from "@saarathi/shared";
import { MemoryStore } from "../../src/core/store.js";
import {
  MODERATION_RESERVE,
  SAY_FLOOR,
  WRITE_CEILING,
  WriteMeter,
  composeReply,
  quotaDay,
} from "../../src/core/writes.js";
import { testLogger } from "../helpers/logger.js";

const at = (iso: string) => new Date(iso).getTime();

/** A meter on a clock a test moves, since the reset is a fact about the clock. */
function meter(now: () => number, store = new MemoryStore()) {
  return { meter: new WriteMeter(store, testLogger(), now), store };
}

describe("quotaDay", () => {
  it("rolls at midnight Pacific, which is where Google's day starts", () => {
    // 07:00Z is midnight in Los Angeles in September. One second earlier is
    // still yesterday's allowance, and she is asleep for both.
    expect(quotaDay(at("2026-09-01T06:59:59Z"))).toBe("2026-08-31");
    expect(quotaDay(at("2026-09-01T07:00:00Z"))).toBe("2026-09-01");
  });

  it("follows the offset over a daylight saving change without being told", () => {
    // The day the clocks go forward the boundary is 08:00Z; a fortnight later
    // it is 07:00Z. Nothing in the code knows that, which is exactly why the
    // day is formatted rather than worked out from an offset.
    expect(quotaDay(at("2026-03-08T07:59:00Z"))).toBe("2026-03-07");
    expect(quotaDay(at("2026-03-08T08:00:00Z"))).toBe("2026-03-08");
    expect(quotaDay(at("2026-03-20T06:59:00Z"))).toBe("2026-03-19");
    expect(quotaDay(at("2026-03-20T07:00:00Z"))).toBe("2026-03-20");
  });

  it("is not her midnight, which is the whole point", () => {
    // Mid-morning in India, and the quota has hours left on the previous day.
    expect(quotaDay(at("2026-09-01T04:30:00Z"))).toBe("2026-08-31");
  });
});

describe("composeReply", () => {
  it("merges everything waiting into one message", () => {
    expect(composeReply(["@a 12", "@b 30", "@c 4"])).toEqual({
      text: "@a 12 · @b 30 · @c 4",
      rest: [],
    });
  });

  it("spills what does not fit to the next window rather than dropping it", () => {
    const long = "x".repeat(9);
    // Three of these and their separators are exactly 33 characters. The
    // fourth cannot go, so it waits rather than vanishing.
    const { text, rest } = composeReply([long, long, long, long], 33);
    expect(text).toBe(`${long} · ${long} · ${long}`);
    expect(text.length).toBeLessThanOrEqual(33);
    expect(rest).toEqual([long]);
  });

  it("sends a single line that is too long anyway, truncated", () => {
    // Otherwise it spills forever and takes everything queued behind it with
    // it: a queue that can never drain is a bot that never speaks again.
    const { text, rest } = composeReply(["y".repeat(40), "@b 30"], 20);
    expect(text).toHaveLength(20);
    expect(text.endsWith("…")).toBe(true);
    expect(rest).toEqual(["@b 30"]);
  });

  it("says nothing when nothing is waiting", () => {
    expect(composeReply([])).toEqual({ text: "", rest: [] });
  });
});

describe("WriteMeter", () => {
  it("counts a write and remembers it across a restart", () => {
    const day = () => at("2026-09-01T18:00:00Z");
    const first = meter(day);
    first.meter.spend("say wheel.spin");
    first.meter.spend("delete abc");
    expect(first.meter.used).toBe(2);

    // The tray restarting mid-stream does not give her allowance back.
    const second = meter(day, first.store);
    expect(second.meter.used).toBe(2);
  });

  it("starts over on the next Pacific day, with nothing running at midnight", () => {
    let now = at("2026-09-01T18:00:00Z");
    const { meter: m } = meter(() => now);
    m.spend("say wheel.spin");
    expect(m.used).toBe(1);

    now = at("2026-09-02T07:00:01Z");
    expect(m.used).toBe(0);
  });

  it("drops a count that belongs to a day that has ended", () => {
    const store = new MemoryStore();
    store.write(WRITES_ID, { day: "2026-08-30", used: 199 });
    const { meter: m } = meter(() => at("2026-09-01T18:00:00Z"), store);
    expect(m.used).toBe(0);
  });

  it("ignores a count it cannot believe", () => {
    const store = new MemoryStore();
    store.write(WRITES_ID, { day: quotaDay(at("2026-09-01T18:00:00Z")), used: "loads" });
    const { meter: m } = meter(() => at("2026-09-01T18:00:00Z"), store);
    expect(m.used).toBe(0);
  });

  it("cuts refusals before the replies she asked for", () => {
    const { meter: m } = meter(() => at("2026-09-01T18:00:00Z"));
    spend(m, WRITE_CEILING - SAY_FLOOR.refusal);
    expect(m.allows("refusal")).toBe(false);
    expect(m.allows("info")).toBe(true);
  });

  it("keeps the moderation reserve back from both tiers", () => {
    const { meter: m } = meter(() => at("2026-09-01T18:00:00Z"));
    spend(m, WRITE_CEILING - MODERATION_RESERVE - 1);
    expect(m.allows("info")).toBe(true);

    m.spend("say points");
    expect(m.allows("info")).toBe(false);
    expect(m.allows("refusal")).toBe(false);
    // Exactly the reserve, untouched by anything the bot said.
    expect(m.remaining).toBe(MODERATION_RESERVE);
  });

  it("still counts a write past the ceiling, because moderation still tries", () => {
    const { meter: m } = meter(() => at("2026-09-01T18:00:00Z"));
    spend(m, WRITE_CEILING + 2);
    expect(m.used).toBe(WRITE_CEILING + 2);
    // Never negative: the number she reads is what is left, not a debt.
    expect(m.remaining).toBe(0);
  });

  it("names the adapter doing the writing, and says when nothing is", () => {
    const { meter: m } = meter(() => at("2026-09-01T18:00:00Z"));
    m.spend("say wheel.spin");
    expect(m.view("youtube")).toEqual({
      adapter: "youtube",
      used: 1,
      ceiling: WRITE_CEILING,
      reserve: MODERATION_RESERVE,
      outOfQuota: false,
    });
    expect(m.view(null).adapter).toBeNull();
  });

  it("stops every reply once the platform says the day is over", () => {
    // The state no local count can predict: the quota belongs to the whole
    // Google project, so it runs out while this counter still has room. One
    // more attempt after that is a write spent finding out what we know.
    const { meter: m } = meter(() => at("2026-09-01T18:00:00Z"));
    expect(m.allows("info")).toBe(true);

    m.outOfQuotaNow();

    expect(m.outOfQuota).toBe(true);
    expect(m.allows("info")).toBe(false);
    expect(m.allows("refusal")).toBe(false);
    // And her card says the day is over rather than showing the gap.
    expect(m.view("youtube")).toMatchObject({ used: 0, outOfQuota: true });
  });

  it("says it once for a burst that all refuses the same way", () => {
    const { meter: m, store } = meter(() => at("2026-09-01T18:00:00Z"));
    m.outOfQuotaNow();
    m.outOfQuotaNow();
    m.outOfQuotaNow();
    expect(store.read(WRITES_ID)).toMatchObject({ spent: true });
  });

  it("comes back from a restart still knowing the day is over", () => {
    // A restart at 4pm must not put the bot back to cheerfully trying, which
    // is the same reason the count itself is persisted.
    const store = new MemoryStore();
    const first = meter(() => at("2026-09-01T18:00:00Z"), store).meter;
    first.spend("say wheel.spin");
    first.outOfQuotaNow();

    const second = meter(() => at("2026-09-01T20:00:00Z"), store).meter;
    expect(second.used).toBe(1);
    expect(second.outOfQuota).toBe(true);
  });

  it("gets the allowance back at midnight Pacific, with nothing running", () => {
    const store = new MemoryStore();
    let clock = at("2026-09-01T18:00:00Z");
    const m = new WriteMeter(store, testLogger(), () => clock);
    m.spend("say wheel.spin");
    m.outOfQuotaNow();

    // Past Google's midnight, not hers.
    clock = at("2026-09-02T07:00:01Z");

    expect(m.outOfQuota).toBe(false);
    expect(m.used).toBe(0);
    expect(m.allows("info")).toBe(true);
  });

  it("does not believe an exhausted flag from a day that has ended", () => {
    const store = new MemoryStore();
    store.write(WRITES_ID, { day: "2026-08-30", used: 199, spent: true });
    const { meter: m } = meter(() => at("2026-09-01T18:00:00Z"), store);
    expect(m.outOfQuota).toBe(false);
  });
});

function spend(m: WriteMeter, times: number): void {
  for (let i = 0; i < times; i += 1) m.spend("test");
}
