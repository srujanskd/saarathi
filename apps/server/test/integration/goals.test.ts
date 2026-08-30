import { afterEach, describe, expect, it, vi } from "vitest";
import { GOALS_ID, STATS_POLL_MS, type ChannelStats } from "@saarathi/shared";
import type { ChatAdapter, ChatSink } from "../../src/chat/adapter.js";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { MemoryStore } from "../../src/core/store.js";
import { goals } from "../../src/modules/goals/index.js";
import { goalsState, harness, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

/** An adapter whose counts and stream the test decides, poll by poll. */
function channel(name = "youtube") {
  let answer: ChannelStats = { counts: { subscribers: 940, likes: 12 }, detail: "Reading" };

  const adapter: ChatAdapter & { says: (next: ChannelStats) => void } = {
    name,
    async start(sink: ChatSink) {
      sink.status({ state: "connected", detail: "up" });
    },
    async stop() {},
    async stats() {
      return answer;
    },
    says: (next) => {
      answer = next;
    },
  };
  return adapter;
}

interface Started {
  youtube: ReturnType<typeof channel>;
  store: MemoryStore;
}

async function withGoals(over: Partial<Started> = {}): Promise<Started> {
  const youtube = over.youtube ?? channel();
  const store = over.store ?? new MemoryStore();
  // Mock chat first, exactly as `main.ts` registers it. Which adapter answers
  // a goal must not depend on the order they happen to be in.
  live = await harness({ modules: [goals], chat: [new MockChatAdapter(), youtube], store });
  await vi.advanceTimersByTimeAsync(0);
  return { youtube, store };
}

/** Her card, adding a goal, and the id the server gave it back. */
async function add(args: string[]): Promise<string> {
  const result = await live!.kernel.invoke(`${GOALS_ID}.add`, { args });
  expect(result).toEqual({ ok: true });
  const list = goalsState(live!.kernel).goals;
  return list[list.length - 1]!.id;
}

const only = () => goalsState(live!.kernel).goals[0]!;
const landings = () => live!.seen.effectsNamed("goal-complete");

describe("a goal on a polled count", () => {
  it("fills from the poll and lands exactly once", async () => {
    vi.useFakeTimers();
    const { youtube } = await withGoals();
    await add(["1,000 subs", "1000", "subscribers", "channel"]);
    expect(only().current).toBe(940);

    youtube.says({ counts: { subscribers: 1_000, likes: 12 }, detail: "Reading" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    expect(only().completedAt).not.toBeNull();
    expect(landings()).toHaveLength(1);

    // Four more minutes of it sitting there over the target.
    youtube.says({ counts: { subscribers: 1_010, likes: 12 }, detail: "Reading" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 4);
    expect(landings()).toHaveLength(1);
  });

  it("does not land again when the server restarts on top of it", async () => {
    vi.useFakeTimers();
    const { youtube, store } = await withGoals();
    await add(["1,000 subs", "1000", "subscribers", "channel"]);
    youtube.says({ counts: { subscribers: 1_000 }, detail: "Reading" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    expect(landings()).toHaveLength(1);

    // She reboots her PC mid-stream. The alert firing again on her stream is
    // the bug this whole stamp exists to stop.
    await live!.stop();
    await withGoals({ youtube, store });
    expect(landings()).toHaveLength(0);
    expect(only().completedAt).not.toBeNull();
  });

  it("starts a restart knowing nothing rather than showing last week's number", async () => {
    vi.useFakeTimers();
    const { store } = await withGoals();
    await add(["1,000 subs", "1000", "subscribers", "channel"]);
    expect(only().current).toBe(940);
    await live!.stop();

    // An adapter that cannot answer at all: the stale 940 has nothing to
    // overwrite it, and a bar that reads 940 with nothing behind it is wrong
    // in the one way she cannot see.
    live = await harness({ modules: [goals], chat: [], store });
    await vi.advanceTimersByTimeAsync(0);
    expect(only().current).toBeNull();
  });

  it("cuts to the scene she picked when it lands", async () => {
    vi.useFakeTimers();
    const { youtube } = await withGoals();
    live!.obs.arrive(["Workout", "Celebration"]);
    await add(["1,000 subs", "1000", "subscribers", "channel", "Celebration"]);

    youtube.says({ counts: { subscribers: 1_000 }, detail: "Reading" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    expect(live!.obs.scenes).toEqual(["Celebration"]);
  });

  it("reads the real channel rather than the stand-in beside it", async () => {
    vi.useFakeTimers();
    const { youtube } = await withGoals();
    youtube.says({ counts: { subscribers: 87 }, detail: "Reading" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    await add(["1,000 subs", "1000", "subscribers", "channel"]);

    // Mock chat is registered on every run and its numbers climb from 940 on
    // their own. If it ever wins this argument, her stream shows test data --
    // and 940 of 1,000 looks entirely plausible while it does.
    expect(only().current).toBe(87);
  });

  it("falls back to the stand-in when nothing real can answer", async () => {
    vi.useFakeTimers();
    const { youtube } = await withGoals();
    // No key, no live stream: the honest YouTube answer is no counts at all.
    youtube.says({ counts: {}, detail: "No key yet" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    await add(["1,000 subs", "1000", "subscribers", "channel"]);

    // Which is what makes the whole feature demonstrable without going live.
    expect(only().current).toBeGreaterThanOrEqual(940);
  });
});

describe("a goal on a stream", () => {
  it("starts again when the next stream starts, and can land again", async () => {
    vi.useFakeTimers();
    const { youtube } = await withGoals();
    youtube.says({ counts: { likes: 12 }, stream: "vid-1", detail: "Live" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    await add(["50 likes", "50", "likes", "stream"]);

    youtube.says({ counts: { likes: 50 }, stream: "vid-1", detail: "Live" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    expect(landings()).toHaveLength(1);

    // Tomorrow night, a different video.
    youtube.says({ counts: { likes: 3 }, stream: "vid-2", detail: "Live" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    expect(only().completedAt).toBeNull();
    expect(only().current).toBe(3);

    youtube.says({ counts: { likes: 60 }, stream: "vid-2", detail: "Live" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    expect(landings()).toHaveLength(2);
  });
});

describe("a goal on things that happen", () => {
  it("counts new members as chat sends them", async () => {
    vi.useFakeTimers();
    await withGoals();
    await add(["3 new members", "3", "members", "stream"]);

    for (const name of ["Ana", "Bo", "Cy"]) {
      live!.chat({ author: name, text: "joined", type: "member" });
    }
    await vi.advanceTimersByTimeAsync(0);

    expect(only().current).toBe(3);
    expect(landings()).toHaveLength(1);
  });

  it("counts tips without caring where the money came from", async () => {
    vi.useFakeTimers();
    await withGoals();
    await add(["2 tips", "2", "tips", "stream"]);

    live!.chat({ author: "Ana", text: "go on", type: "superchat", amount: "$5.00" });
    live!.chat({ author: "Bo", text: "yes", type: "superchat", amount: "$2.00" });
    await vi.advanceTimersByTimeAsync(0);
    expect(landings()).toHaveLength(1);
  });
});

describe("a goal she counts herself", () => {
  it("goes up on a press, and back down when she over-counted", async () => {
    vi.useFakeTimers();
    await withGoals();
    const id = await add(["50 push-ups", "50", "manual", "stream"]);

    await live!.kernel.invoke(`${GOALS_ID}.bump`, { args: [id], via: "deck" });
    await live!.kernel.invoke(`${GOALS_ID}.bump`, { args: [id, "10"], via: "deck" });
    expect(only().current).toBe(11);

    await live!.kernel.invoke(`${GOALS_ID}.bump`, { args: [id, "-1"], via: "control" });
    expect(only().current).toBe(10);
  });

  it("is not something a poll may write", async () => {
    vi.useFakeTimers();
    const { youtube } = await withGoals();
    const id = await add(["50 push-ups", "50", "manual", "stream"]);
    await live!.kernel.invoke(`${GOALS_ID}.bump`, { args: [id, "4"] });

    youtube.says({ counts: { subscribers: 9_999, likes: 9_999 }, detail: "Reading" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS);
    expect(only().current).toBe(4);
  });

  it("refuses to be counted by hand when it counts itself", async () => {
    vi.useFakeTimers();
    await withGoals();
    const id = await add(["1,000 subs", "1000", "subscribers", "channel"]);

    const result = await live!.kernel.invoke(`${GOALS_ID}.bump`, { args: [id] });
    expect(result.ok).toBe(false);
  });
});

describe("the ways out", () => {
  it("starts a landed goal again without firing the alert on the way", async () => {
    vi.useFakeTimers();
    await withGoals();
    const id = await add(["1 tip", "1", "tips", "stream"]);
    live!.chat({ author: "Ana", text: "go on", type: "superchat", amount: "$5.00" });
    await vi.advanceTimersByTimeAsync(0);
    expect(landings()).toHaveLength(1);

    await live!.kernel.invoke(`${GOALS_ID}.reset`, { args: [id] });
    expect(only().completedAt).toBeNull();
    expect(only().current).toBe(0);
    expect(landings()).toHaveLength(1);
  });

  it("removes a goal, and says so when it is already gone", async () => {
    vi.useFakeTimers();
    await withGoals();
    const id = await add(["1,000 subs", "1000", "subscribers", "channel"]);

    expect(await live!.kernel.invoke(`${GOALS_ID}.remove`, { args: [id] })).toEqual({ ok: true });
    expect(goalsState(live!.kernel).goals).toEqual([]);
    expect((await live!.kernel.invoke(`${GOALS_ID}.remove`, { args: [id] })).ok).toBe(false);
  });
});

describe("switching goals off", () => {
  it("stops the poll reaching them", async () => {
    vi.useFakeTimers();
    const { youtube } = await withGoals();
    await add(["1,000 subs", "1000", "subscribers", "channel"]);
    await live!.kernel.invoke("core.disable", { args: [GOALS_ID] });

    youtube.says({ counts: { subscribers: 1_000 }, detail: "Reading" });
    await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 2);

    // A module the core stopped is stopped: the stats subscription it opened
    // is the core's to close, exactly like its timers and its event handlers.
    expect(only().current).toBe(940);
    expect(landings()).toHaveLength(0);
  });
});

describe("what the poll costs her phone", () => {
  it("sends nothing when no goal moved", async () => {
    vi.useFakeTimers();
    await withGoals();
    await add(["1,000 subs", "1000", "subscribers", "channel"]);
    // Past the patch coalescing window, so the goal she just added has been
    // published and everything after this is the poll's doing.
    await vi.advanceTimersByTimeAsync(100);
    live!.seen.clear();

    await vi.advanceTimersByTimeAsync(STATS_POLL_MS * 5);
    expect(live!.seen.patches.filter((patch) => patch.module === GOALS_ID)).toEqual([]);
  });
});
