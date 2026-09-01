import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACTIVE_WINDOW_MS,
  DEFAULT_PER_MINUTE,
  EARN_TICK_MS,
  GAINS_ID,
  LEDGER_ID,
  STREAK_CAP,
  type ChannelStats,
} from "@saarathi/shared";
import type { ChatAdapter, ChatSink } from "../../src/chat/adapter.js";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { MemoryStore } from "../../src/core/store.js";
import { gains } from "../../src/modules/gains/index.js";
import { gainsState, harness, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

/** An adapter whose stream token the test decides, the way `goals` does.
 * `undefined` is a real answer: YouTube reports counts before she goes live. */
function channel(stream: string | undefined) {
  const answer: ChannelStats = { counts: { subscribers: 940 }, stream, detail: "Reading" };
  const adapter: ChatAdapter = {
    name: "youtube",
    async start(sink: ChatSink) {
      sink.status({ state: "connected", detail: "up" });
    },
    async stop() {},
    async stats() {
      return answer;
    },
  };
  return adapter;
}

async function withGains(stream: string | undefined, store = new MemoryStore()): Promise<MemoryStore> {
  live = await harness({
    modules: [gains],
    chat: [new MockChatAdapter(), channel(stream)],
    store,
  });
  // The first poll, so the module knows which stream is running before anyone
  // says anything.
  await vi.advanceTimersByTimeAsync(0);
  return store;
}

const board = () => gainsState(live!.kernel).board;
/**
 * Past the coalescing window, so a patch the last tick queued has landed before
 * a test clears what it has seen. Without it "no patch arrived" is satisfied by
 * one that arrived a moment late, which is how this file first passed against a
 * registry that published everything.
 */
const drain = () => vi.advanceTimersByTimeAsync(1_000);
const balance = (name: string) =>
  (live!.store.read(LEDGER_ID)?.balances as Record<string, number>)?.[`mock:${name}`] ?? 0;

describe("earning gains for turning up", () => {
  it("pays everyone who spoke, once a minute", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    live!.chat({ author: "Bo", text: "hi" });

    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    // The minute, plus the bonus each of them got for their first stream.
    const first = DEFAULT_PER_MINUTE + DEFAULT_PER_MINUTE;
    expect(balance("Asha")).toBe(first);
    expect(balance("Bo")).toBe(first);

    await vi.advanceTimersByTimeAsync(EARN_TICK_MS * 3);
    expect(balance("Asha")).toBe(first + DEFAULT_PER_MINUTE * 3);
  });

  it("stops paying someone who has gone quiet, and starts again when they talk", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });

    await vi.advanceTimersByTimeAsync(ACTIVE_WINDOW_MS + EARN_TICK_MS);
    const gone = balance("Asha");

    await vi.advanceTimersByTimeAsync(EARN_TICK_MS * 5);
    expect(balance("Asha")).toBe(gone);

    live!.chat({ author: "Asha", text: "back" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    expect(balance("Asha")).toBe(gone + DEFAULT_PER_MINUTE);
  });

  it("pays a viewer who only ever types commands", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "!spin" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    expect(balance("Asha")).toBeGreaterThan(0);
  });

  it("pays nobody once she turns the rate down to zero", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    await live!.kernel.invoke(`${GAINS_ID}.rate`, { args: ["0"] });

    const before = balance("Asha");
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS * 5);
    expect(balance("Asha")).toBe(before);
  });
});

describe("the board", () => {
  it("ranks the people who have earned, richest first", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS * 3);
    live!.chat({ author: "Bo", text: "hi" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);

    expect(board().map((row) => row.name)).toEqual(["Asha", "Bo"]);
    expect(board()[0]!.balance).toBeGreaterThan(board()[1]!.balance);
  });

  it("never sends her chat's roster to a client", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);

    const slice = live!.kernel.snapshot().modules[GAINS_ID] as Record<string, unknown>;
    expect(Object.keys(slice).sort()).toEqual(["board", "perMinute"]);
    for (const patch of live!.seen.patches.filter((p) => p.module === GAINS_ID)) {
      expect(Object.keys(patch.state as object)).not.toContain("roster");
    }
  });

  it("says nothing to her phone when someone simply chats", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    await drain();
    live!.seen.clear();

    // A message moves a timestamp nobody is shown. Her phone is on mobile data
    // in IRL mode and chat talks a lot.
    for (let i = 0; i < 20; i += 1) live!.chat({ author: "Asha", text: `line ${i}` });
    // Past the coalescing window and well short of the next minute, so this is
    // "nothing to send" rather than "not sent yet".
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS / 2);
    expect(live!.seen.patches.filter((p) => p.module === GAINS_ID)).toEqual([]);

    // And the minute after does arrive, so the silence above is the rule and
    // not a tap that stopped working.
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    expect(live!.seen.patches.filter((p) => p.module === GAINS_ID)).toHaveLength(1);
  });

  it("says nothing on a minute that paid nobody", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    // Long enough that she has fallen out of the active window, and the ticks
    // that ran on the way through have already been published.
    await vi.advanceTimersByTimeAsync(ACTIVE_WINDOW_MS + EARN_TICK_MS);
    await drain();
    live!.seen.clear();

    await vi.advanceTimersByTimeAsync(EARN_TICK_MS * 5);
    expect(live!.seen.patches.filter((p) => p.module === GAINS_ID)).toEqual([]);
  });
});

describe("streaks", () => {
  it("pays a first-stream bonus once, however much someone talks", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    for (let i = 0; i < 5; i += 1) live!.chat({ author: "Asha", text: `line ${i}` });

    // The bonus for a streak of one, and nothing else -- no minute has passed.
    expect(balance("Asha")).toBe(DEFAULT_PER_MINUTE);
    expect(board()[0]!.streak).toBe(1);
  });

  it("grows across consecutive streams, over a restart in between", async () => {
    vi.useFakeTimers();
    const store = await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    expect(board()[0]!.streak).toBe(1);
    const earned = balance("Asha");

    // She shuts the PC down between streams, which is the normal case: a streak
    // that had to be present for the boundary would be no streak at all.
    await live!.stop();
    await withGains("s2", store);
    live!.chat({ author: "Asha", text: "back" });

    expect(board()[0]!.streak).toBe(2);
    expect(balance("Asha")).toBe(earned + DEFAULT_PER_MINUTE * 2);
  });

  it("starts over for someone who missed a stream", async () => {
    vi.useFakeTimers();
    const store = await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    live!.chat({ author: "Bo", text: "hi" });

    await live!.stop();
    await withGains("s2", store);
    live!.chat({ author: "Asha", text: "still here" });

    await live!.stop();
    await withGains("s3", store);
    live!.chat({ author: "Asha", text: "three in a row" });
    live!.chat({ author: "Bo", text: "sorry, missed one" });

    const rows = Object.fromEntries(board().map((row) => [row.name, row.streak]));
    expect(rows).toEqual({ Asha: 3, Bo: 1 });
  });

  it("does not roll a streak when the adapter is not on a stream", async () => {
    vi.useFakeTimers();
    // Counts but no stream token, which is what YouTube answers before she goes
    // live. Not a boundary, so nobody's run through it is broken or credited.
    await withGains(undefined);
    live!.chat({ author: "Asha", text: "hello" });

    expect(board()).toEqual([]);
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    expect(board()).toEqual([
      { id: "mock:Asha", name: "Asha", balance: DEFAULT_PER_MINUTE, streak: 0 },
    ]);
  });

  it("caps what a long run pays", async () => {
    vi.useFakeTimers();
    let store = new MemoryStore();
    for (let stream = 1; stream <= STREAK_CAP + 3; stream += 1) {
      store = await withGains(`s${stream}`, store);
      live!.chat({ author: "Asha", text: "here again" });
      await live!.stop();
    }
    await withGains("last", store);
    live!.chat({ author: "Asha", text: "here again" });

    const runs = STREAK_CAP + 4;
    // Every stream up to the cap paid its own number; every one past it paid
    // the cap. Nothing else has happened, so this is the whole balance.
    const capped = (runs - STREAK_CAP) * STREAK_CAP * DEFAULT_PER_MINUTE;
    const climbing = ((STREAK_CAP * (STREAK_CAP + 1)) / 2) * DEFAULT_PER_MINUTE;
    expect(balance("Asha")).toBe(climbing + capped);
    expect(board()[0]!.streak).toBe(runs);
  });
});

describe("her hands on it", () => {
  it("gives, and takes back, and refuses to take more than they have", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    const id = board()[0]!.id;

    expect(await live!.kernel.invoke(`${GAINS_ID}.give`, { args: [id, "500"] })).toEqual({
      ok: true,
    });
    expect(balance("Asha")).toBe(DEFAULT_PER_MINUTE + 500);

    expect(await live!.kernel.invoke(`${GAINS_ID}.give`, { args: [id, "-500"] })).toEqual({
      ok: true,
    });
    expect(balance("Asha")).toBe(DEFAULT_PER_MINUTE);

    const tooMuch = await live!.kernel.invoke(`${GAINS_ID}.give`, { args: [id, "-9999"] });
    expect(tooMuch.ok).toBe(false);
    expect(balance("Asha")).toBe(DEFAULT_PER_MINUTE);
  });

  it("refuses a gift to somebody who was never here", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    const result = await live!.kernel.invoke(`${GAINS_ID}.give`, { args: ["nobody", "50"] });
    expect(result.ok).toBe(false);
  });

  it("clears the board and everything on it", async () => {
    vi.useFakeTimers();
    await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS * 3);
    expect(board()).toHaveLength(1);

    expect(await live!.kernel.invoke(`${GAINS_ID}.clear`, { args: [] })).toEqual({ ok: true });
    expect(board()).toEqual([]);
    expect(balance("Asha")).toBe(0);
  });

  it("clears balances without taking everyone's streak with them", async () => {
    vi.useFakeTimers();
    const store = await withGains("s1");
    live!.chat({ author: "Asha", text: "hello" });

    await live!.stop();
    await withGains("s2", store);
    live!.chat({ author: "Asha", text: "back" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    expect(board()[0]!.streak).toBe(2);

    await live!.kernel.invoke(`${GAINS_ID}.clear`, { args: [] });
    expect(balance("Asha")).toBe(0);
    expect(board()).toEqual([]);

    // The roster is server-only, so the streak is proved the way chat would see
    // it: the next stream continues the run rather than starting one. She is
    // resetting an economy that got away from her, not six weeks of turning up
    // -- and nothing here could hand that back.
    await live!.stop();
    await withGains("s3", store);
    live!.chat({ author: "Asha", text: "three in a row" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    expect(board()[0]!.streak).toBe(3);
  });

  it("keeps her rate over a restart", async () => {
    vi.useFakeTimers();
    const store = await withGains("s1");
    await live!.kernel.invoke(`${GAINS_ID}.rate`, { args: ["45"] });

    await live!.stop();
    await withGains("s2", store);
    expect(gainsState(live!.kernel).perMinute).toBe(45);

    live!.chat({ author: "Asha", text: "hello" });
    await vi.advanceTimersByTimeAsync(EARN_TICK_MS);
    expect(balance("Asha")).toBe(45 + 45);
  });
});
