import { afterEach, describe, expect, it, vi } from "vitest";
import { WRITES_ID, type ChatLogState, type GameModuleDef } from "@saarathi/shared";
import type { ChatAdapter, ChatSink, ChatWrites } from "../../src/chat/adapter.js";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { MemoryStore } from "../../src/core/store.js";
import {
  MAX_PENDING_PER_KEY,
  MODERATION_RESERVE,
  REPLY_WINDOW_MS,
  SAY_FLOOR,
  WRITE_CEILING,
  quotaDay,
} from "../../src/core/writes.js";
import { chatlog } from "../../src/modules/chatlog/index.js";
import { wheel } from "../../src/modules/wheel/index.js";
import { harness, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

/**
 * A real adapter that can write, and keeps what it wrote.
 *
 * Not a stand-in, so it outranks mock chat -- which is the ranking under test in
 * one of these, and the reason every other one can read `wrote` and know that is
 * what chat would have seen.
 */
function platform(
  name = "youtube",
  canWrite = true,
  /** A live source with no grant still shuts the stand-in out. */
  connected = true,
) {
  const wrote: string[] = [];
  let fail = false;
  let sink: ChatSink | null = null;

  const writes: ChatWrites = {
    say: async (text) => {
      if (fail) throw new Error("403");
      wrote.push(text);
    },
    deleteMessage: async () => {},
    ban: async () => {},
  };

  const adapter: ChatAdapter & {
    wrote: string[];
    breaks: () => void;
    viewerSays: (text: string, author?: string) => void;
  } = {
    name,
    // Omitted rather than undefined for the adapter that cannot write: that is
    // the shape a platform with no grant has, and the whole capability check.
    ...(canWrite ? { writes } : {}),
    async start(next: ChatSink) {
      sink = next;
      next.status({
        state: connected ? "connected" : "disconnected",
        detail: connected ? "up" : "no live stream yet",
      });
    },
    async stop() {
      sink = null;
    },
    wrote,
    breaks: () => {
      fail = true;
    },
    viewerSays: (text, author = "TestViewer") =>
      sink?.event({
        type: "chat-message",
        source: name,
        author: { id: `${name}:${author}`, name: author },
        at: Date.now(),
        text,
      }),
  };
  return adapter;
}

/** A module that answers in chat, which is the informational tier. */
const chatty: GameModuleDef<Record<string, never>> = {
  id: "chatty",
  title: "Chatty",
  initialState: {},
  actions: {
    answer: {
      label: "Answer",
      needsArgs: true,
      run(input, ctx) {
        ctx.say(`@${input.args[0]} 12`, "chatty.answer");
      },
    },
    greet: {
      label: "Greet",
      needsArgs: true,
      run(input, ctx) {
        ctx.say(`@${input.args[0]} hi`, "chatty.greet");
      },
    },
  },
};

async function withWriter(over: { store?: MemoryStore; used?: number } = {}) {
  const store = over.store ?? new MemoryStore();
  if (over.used !== undefined) {
    store.write(WRITES_ID, { day: quotaDay(Date.now()), used: over.used });
  }
  const youtube = platform();
  // Mock chat first, exactly as main.ts registers it: which adapter writes must
  // not depend on the order they happen to be in.
  live = await harness({
    modules: [wheel, chatlog, chatty],
    chat: [new MockChatAdapter(), youtube],
    store,
  });
  await vi.advanceTimersByTimeAsync(0);
  return { youtube, store, h: live };
}

const window = () => vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS);

describe("what the bot says reaches chat", () => {
  it("sends a refusal once the window closes, and shows it to her at once", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();

    // Nobody seeded a balance, so !spin is refused at the gate.
    h.chat("!spin");
    await vi.advanceTimersByTimeAsync(0);

    // Her control page has it already: the effect never waited on chat, which
    // is what makes this additive rather than a mode switch.
    expect(h.seen.said()).toHaveLength(1);
    expect(youtube.wrote).toEqual([]);

    await window();
    expect(youtube.wrote).toHaveLength(1);
    expect(youtube.wrote[0]).toContain("@TestViewer");
  });

  it("answers a burst of the same command in one message", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();

    for (const name of ["Ana", "Bo", "Cy"]) h.chat({ author: name, text: "!spin" });
    await vi.advanceTimersByTimeAsync(0);
    await window();

    // Three refusals, one write. This is the whole reason the window exists.
    expect(h.seen.said()).toHaveLength(3);
    expect(youtube.wrote).toHaveLength(1);
    for (const name of ["Ana", "Bo", "Cy"]) expect(youtube.wrote[0]).toContain(`@${name}`);
  });

  it("keeps replies about different things in different messages", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();

    h.chat("!spin");
    await live!.kernel.invoke("chatty.answer", { args: ["Ana"] });
    await vi.advanceTimersByTimeAsync(0);
    await window();

    // A refusal and an answer merged into one line is a line nobody reads.
    expect(youtube.wrote).toHaveLength(2);
    expect(youtube.wrote.some((line) => line === "@Ana 12")).toBe(true);
  });

  it("merges two module replies about the same command, not the whole module", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();

    await h.kernel.invoke("chatty.answer", { args: ["Ana"] });
    await h.kernel.invoke("chatty.answer", { args: ["Bo"] });
    await h.kernel.invoke("chatty.greet", { args: ["Cy"] });
    await vi.advanceTimersByTimeAsync(0);
    await window();

    const answers = youtube.wrote.find((line) => line.includes("@Ana"));
    expect(answers).toContain("@Bo");
    expect(answers).not.toContain("@Cy");
    expect(youtube.wrote.some((line) => line === "@Cy hi")).toBe(true);
  });

  it("restarts the window when another reply about the same thing arrives", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();

    h.chat({ author: "Ana", text: "!spin" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS - 1_000);
    expect(youtube.wrote).toEqual([]);

    h.chat({ author: "Bo", text: "!spin" });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS - 1_000);
    // A tumbling window would have sent Ana already. Trailing holds both.
    expect(youtube.wrote).toEqual([]);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(youtube.wrote).toHaveLength(1);
    expect(youtube.wrote[0]).toContain("@Ana");
    expect(youtube.wrote[0]).toContain("@Bo");
  });

  it("spills what did not fit into the next window instead of dropping it", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();

    // Enough refusals that one message cannot carry them: each is about fifty
    // characters, so a couple of hundred characters holds four of them.
    const names = Array.from({ length: 12 }, (_, i) => `Viewer${i}`);
    for (const name of names) h.chat({ author: name, text: "!spin" });
    await vi.advanceTimersByTimeAsync(0);

    await window();
    const first = youtube.wrote.length;
    expect(first).toBe(1);

    await window();
    expect(youtube.wrote.length).toBeGreaterThan(first);
    // Everyone who asked is named somewhere, eventually.
    await vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS * 12);
    const all = youtube.wrote.join(" ");
    for (const name of names) expect(all).toContain(`@${name}`);
  });

  it("stops queueing under a raid rather than dribbling out old news", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();

    // Far more refusals in one window than any number of windows should carry.
    const names = Array.from({ length: MAX_PENDING_PER_KEY * 3 }, (_, i) => `Raider${i}`);
    for (const name of names) h.chat({ author: name, text: "!spin" });
    await vi.advanceTimersByTimeAsync(0);

    // Long enough for anything still queued to have gone out.
    await vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS * 30);
    const all = youtube.wrote.join(" ");
    expect(all).toContain("@Raider0");
    expect(all).not.toContain(`@${names[names.length - 1]}`);
    // She saw every one of them, which is the surface that costs nothing.
    expect(h.seen.said()).toHaveLength(names.length);
  });

  it("writes through a real adapter rather than the stand-in beside it", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();
    const mock = h.kernel.snapshot().core.writes;
    expect(mock.adapter).toBe("youtube");

    h.chat("!spin");
    await vi.advanceTimersByTimeAsync(0);
    await window();

    // And the echo did not also land in her chat log, which is what a cached or
    // unranked choice would have done: one reply, said twice.
    const log = h.kernel.snapshot().modules.chatlog as ChatLogState;
    expect(log.events.filter((event) => event.author.name === "Saarathi")).toEqual([]);
    expect(youtube.wrote).toHaveLength(1);
  });

  it("falls back to mock chat, which is what makes this demoable", async () => {
    vi.useFakeTimers();
    live = await harness({ modules: [wheel, chatlog] });
    await vi.advanceTimersByTimeAsync(0);

    live.chat("!spin");
    await vi.advanceTimersByTimeAsync(0);
    await window();

    // The reply arrives as a message from her, in her chat log, exactly as one
    // sent over a real grant would.
    const log = live.kernel.snapshot().modules.chatlog as ChatLogState;
    const bot = log.events.filter((event) => event.author.name === "Saarathi");
    expect(bot).toHaveLength(1);
    expect(bot[0]!.text).toContain("@TestViewer");
    expect(live.kernel.snapshot().core.writes.adapter).toBe("mock");
  });

  it("does not let the stand-in write once a real adapter is live, even without a grant", async () => {
    vi.useFakeTimers();
    const silent = platform("youtube", false);
    live = await harness({
      modules: [wheel, chatlog],
      chat: [new MockChatAdapter(), silent],
    });
    await vi.advanceTimersByTimeAsync(0);

    live.chat("!spin");
    await vi.advanceTimersByTimeAsync(0);
    await window();

    const log = live.kernel.snapshot().modules.chatlog as ChatLogState;
    expect(log.events.filter((event) => event.author.name === "Saarathi")).toEqual([]);
    expect(live.kernel.snapshot().core.writes.adapter).toBeNull();
    expect(live.seen.said()).toHaveLength(1);
  });

  it("lets the stand-in write while the real adapter has not come up", async () => {
    vi.useFakeTimers();
    const idle = platform("youtube", false, false);
    live = await harness({
      modules: [wheel, chatlog],
      chat: [new MockChatAdapter(), idle],
    });
    await vi.advanceTimersByTimeAsync(0);

    live.chat("!spin");
    await vi.advanceTimersByTimeAsync(0);
    await window();

    const log = live.kernel.snapshot().modules.chatlog as ChatLogState;
    const bot = log.events.filter((event) => event.author.name === "Saarathi");
    expect(bot).toHaveLength(1);
    expect(live.kernel.snapshot().core.writes.adapter).toBe("mock");
  });

  it("still tells her, when nothing can write at all", async () => {
    vi.useFakeTimers();
    // An adapter with no writes at all: a VPS with no grant, and CI.
    const silent = platform("silent", false);
    live = await harness({ modules: [wheel, chatlog], chat: [silent] });
    await vi.advanceTimersByTimeAsync(0);

    silent.viewerSays("!spin");
    await vi.advanceTimersByTimeAsync(0);
    await window();

    expect(live.seen.said()).toHaveLength(1);
    expect(live.kernel.snapshot().core.writes.adapter).toBeNull();
  });

  it("carries on after a write fails, having counted it", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();
    youtube.breaks();

    h.chat("!spin");
    await vi.advanceTimersByTimeAsync(0);
    await window();

    // Counted, because a call that failed past our own network may well have
    // been charged, and the next one has to assume it was.
    expect(h.kernel.snapshot().core.writes.used).toBe(1);
    expect(h.seen.said()).toHaveLength(1);
  });
});

describe("the budget, as chat spends it", () => {
  it("cuts refusals first and keeps answering what she was asked", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter({ used: WRITE_CEILING - SAY_FLOOR.refusal });

    h.chat("!spin");
    await live!.kernel.invoke("chatty.answer", { args: ["Ana"] });
    await vi.advanceTimersByTimeAsync(0);
    await window();

    expect(youtube.wrote).toEqual(["@Ana 12"]);
    // She still sees the refusal, because that surface costs nothing.
    expect(h.seen.said()).toHaveLength(2);
  });

  it("goes quiet at the reserve, and leaves it whole for moderation", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter({ used: WRITE_CEILING - MODERATION_RESERVE });

    h.chat("!spin");
    await live!.kernel.invoke("chatty.answer", { args: ["Ana"] });
    await vi.advanceTimersByTimeAsync(0);
    await window();

    expect(youtube.wrote).toEqual([]);
    expect(h.kernel.snapshot().core.writes.used).toBe(WRITE_CEILING - MODERATION_RESERVE);
  });

  it("counts what it spent across a restart she did not think about", async () => {
    vi.useFakeTimers();
    const first = await withWriter();
    first.h.chat("!spin");
    await vi.advanceTimersByTimeAsync(0);
    await window();
    expect(first.h.kernel.snapshot().core.writes.used).toBe(1);

    await live!.stop();
    const second = await withWriter({ store: first.store });
    expect(second.h.kernel.snapshot().core.writes.used).toBe(1);
  });

  it("drops what was waiting when the server stops rather than saying it later", async () => {
    vi.useFakeTimers();
    const { youtube, h } = await withWriter();
    h.chat("!spin");
    await vi.advanceTimersByTimeAsync(0);

    await h.stop();
    live = null;
    await vi.advanceTimersByTimeAsync(REPLY_WINDOW_MS * 2);

    // A refusal that arrives after the stream ended is worse than one that
    // never arrives.
    expect(youtube.wrote).toEqual([]);
  });
});
