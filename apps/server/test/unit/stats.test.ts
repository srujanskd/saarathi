import { describe, expect, it } from "vitest";
import type { ChannelStats } from "@saarathi/shared";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { sameStats } from "../../src/core/stats.js";

const source = (counts: ChannelStats["counts"], detail = "ok"): Record<string, ChannelStats> => ({
  youtube: { counts, detail },
});

describe("sameStats", () => {
  it("calls two identical polls the same, so most polls send nothing", () => {
    expect(sameStats(source({ subscribers: 940, likes: 12 }), source({ subscribers: 940, likes: 12 }))).toBe(true);
  });

  it("notices a like arriving", () => {
    expect(sameStats(source({ likes: 12 }), source({ likes: 13 }))).toBe(false);
  });

  it("notices a like going away, because likes go down", () => {
    expect(sameStats(source({ likes: 13 }), source({ likes: 12 }))).toBe(false);
  });

  it("does not confuse a missing count with a count of zero", () => {
    expect(sameStats(source({}), source({ likes: 0 }))).toBe(false);
    expect(sameStats(source({ likes: 0 }), source({}))).toBe(false);
  });

  it("treats a count that is missing in both as unchanged", () => {
    expect(sameStats(source({ likes: 5 }), source({ likes: 5 }))).toBe(true);
  });

  it("notices the words changing while the numbers hold still", () => {
    // She hides her subscriber count mid-stream: same absent number, and a
    // different thing to tell her about it.
    expect(sameStats(source({ likes: 5 }, "Reading"), source({ likes: 5 }, "Hidden"))).toBe(false);
  });

  it("notices an adapter arriving or going away", () => {
    expect(sameStats({}, source({ likes: 1 }))).toBe(false);
    expect(sameStats(source({ likes: 1 }), {})).toBe(false);
  });

  it("notices one adapter being swapped for another with the same numbers", () => {
    const mock: Record<string, ChannelStats> = { mock: { counts: { likes: 1 }, detail: "ok" } };
    expect(sameStats(source({ likes: 1 }), mock)).toBe(false);
  });
});

describe("MockChatAdapter stats", () => {
  it("climbs, so a goal can be watched filling up with no live stream", async () => {
    const adapter = new MockChatAdapter();
    const first = await adapter.stats();
    const second = await adapter.stats();

    expect(second.counts.likes!).toBeGreaterThan(first.counts.likes!);
  });

  it("climbs per call, so a test that advances the clock gets one answer", async () => {
    const a = new MockChatAdapter();
    const b = new MockChatAdapter();
    await a.stats();
    await b.stats();
    expect(await a.stats()).toEqual(await b.stats());
  });

  it("starts her under 1,000, where YouTube still reports an exact figure", async () => {
    const adapter = new MockChatAdapter();
    expect((await adapter.stats()).counts.subscribers!).toBeLessThan(1000);
  });

  it("moves subscribers slower than likes, the way the real pair does", async () => {
    const adapter = new MockChatAdapter();
    const first = await adapter.stats();
    let last = first;
    for (let i = 0; i < 4; i++) last = await adapter.stats();

    expect(last.counts.likes! - first.counts.likes!).toBe(4);
    expect(last.counts.subscribers! - first.counts.subscribers!).toBeLessThan(4);
  });
});
