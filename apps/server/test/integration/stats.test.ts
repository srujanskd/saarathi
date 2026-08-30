import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_ID, STATS_POLL_MS, type ChannelStats } from "@saarathi/shared";
import type { ChatAdapter, ChatSink } from "../../src/chat/adapter.js";
import { harness, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

/** An adapter whose answer to the poll the test decides, call by call. */
function countingAdapter(name = "youtube") {
  let answer: ChannelStats = { counts: { subscribers: 940, likes: 12 }, detail: "Reading" };
  let breaks: string | null = null;
  let calls = 0;

  const adapter: ChatAdapter & {
    calls: () => number;
    says: (next: ChannelStats) => void;
    breakIt: (why: string) => void;
  } = {
    name,
    async start(sink: ChatSink) {
      sink.status({ state: "connected", detail: "up" });
    },
    async stop() {},
    async stats() {
      calls += 1;
      if (breaks) throw new Error(breaks);
      return answer;
    },
    calls: () => calls,
    says: (next) => {
      answer = next;
    },
    breakIt: (why) => {
      breaks = why;
    },
  };
  return adapter;
}

/** The adapters that cannot answer: a tips webhook has no channel to count. */
function silentAdapter(name = "kofi"): ChatAdapter {
  return {
    name,
    async start() {},
    async stop() {},
  };
}

const corePatches = (h: Harness) => h.seen.patches.filter((p) => p.module === CORE_ID);

describe("the adapter stats poll", () => {
  it("has an answer before the first interval elapses", async () => {
    vi.useFakeTimers();
    const youtube = countingAdapter();
    live = await harness({ chat: [youtube] });
    await vi.advanceTimersByTimeAsync(0);

    // She restarts the server mid-stream; a goal bar that stays empty for a
    // minute afterwards looks broken, and she has no way to tell that it is not.
    expect(live.kernel.coreState().stats.youtube).toEqual({
      counts: { subscribers: 940, likes: 12 },
      detail: "Reading",
    });
  });

  it("leaves out an adapter that cannot count rather than reporting zeroes", async () => {
    vi.useFakeTimers();
    live = await harness({ chat: [countingAdapter(), silentAdapter()] });
    await vi.advanceTimersByTimeAsync(0);

    const { stats } = live.kernel.coreState();
    expect(Object.keys(stats)).toEqual(["youtube"]);
  });

  it("keeps asking on the interval", async () => {
    vi.useFakeTimers();
    const youtube = countingAdapter();
    live = await harness({ chat: [youtube] });
    await vi.advanceTimersByTimeAsync(0);
    expect(youtube.calls()).toBe(1);

    await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 3);
    expect(youtube.calls()).toBe(4);
  });

  it("sends nothing when the numbers have not moved", async () => {
    vi.useFakeTimers();
    live = await harness({ chat: [countingAdapter()] });
    await vi.advanceTimersByTimeAsync(0);
    live.seen.clear();

    await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 5);

    // Five polls, one unchanging channel, and her phone told about none of it.
    // A core patch carries the whole slice -- deck included -- and she may be
    // paying for it by the megabyte.
    expect(corePatches(live)).toEqual([]);
  });

  it("publishes the moment a count moves", async () => {
    vi.useFakeTimers();
    const youtube = countingAdapter();
    live = await harness({ chat: [youtube] });
    await vi.advanceTimersByTimeAsync(0);
    live.seen.clear();

    youtube.says({ counts: { subscribers: 940, likes: 13 }, detail: "Reading" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);

    expect(corePatches(live)).toHaveLength(1);
    expect(live.kernel.coreState().stats.youtube!.counts.likes).toBe(13);
  });

  it("keeps the numbers it had when a poll fails, and changes only the words", async () => {
    vi.useFakeTimers();
    const youtube = countingAdapter();
    live = await harness({ chat: [youtube] });
    await vi.advanceTimersByTimeAsync(0);

    youtube.breakIt("ETIMEDOUT");
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);

    // Her Wi-Fi dropped for a minute. Blanking the bar and filling it back in
    // reads as a bug in the goal; the count standing still with a note does not.
    const { counts, detail } = live.kernel.coreState().stats.youtube!;
    expect(counts).toEqual({ subscribers: 940, likes: 12 });
    expect(detail).toContain("youtube");
    expect(live.log.text()).toContain("ETIMEDOUT");
  });

  it("stops asking once the kernel stops", async () => {
    vi.useFakeTimers();
    const youtube = countingAdapter();
    live = await harness({ chat: [youtube] });
    await vi.advanceTimersByTimeAsync(0);

    await live.stop();
    live = null;
    const settled = youtube.calls();

    await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 3);
    expect(youtube.calls()).toBe(settled);
  });
});
