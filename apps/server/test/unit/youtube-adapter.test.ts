import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus } from "@saarathi/shared";
import type { ChatSink } from "../../src/chat/adapter.js";
import type { StatFetch } from "../../src/chat/youtube-stats.js";
import { MemoryStore } from "../../src/core/store.js";
import { testLogger } from "../helpers/logger.js";

/**
 * The state the YouTube adapter keeps for itself: which video chat is on, and
 * what she has set up.
 *
 * Both need the chat library standing in for a live stream, which is why they
 * share a file. `videos.list` needs a video id, and the only place the adapter
 * ever learns one is chat's own `start` event -- so likes exist exactly while
 * chat is connected, and this file is what keeps that true.
 */

const chats = vi.hoisted(() => [] as FakeChat[]);

interface FakeChat {
  source: unknown;
  chatType: string | undefined;
  emit(name: string, arg?: unknown): void;
  stopped: boolean;
}

vi.mock("youtube-chat-next", () => {
  class LiveChat {
    private handlers = new Map<string, (arg?: unknown) => void>();
    stopped = false;
    constructor(
      public source: unknown,
      _interval?: number,
      public chatType?: string,
    ) {
      chats.push(this as unknown as FakeChat);
    }
    on(name: string, handler: (arg?: unknown) => void): void {
      this.handlers.set(name, handler);
    }
    async start(): Promise<boolean> {
      return true;
    }
    stop(): void {
      this.stopped = true;
    }
    emit(name: string, arg?: unknown): void {
      this.handlers.get(name)?.(arg);
    }
  }
  return { LiveChat };
});

const { YouTubeAdapter } = await import("../../src/chat/youtube.js");

const CHANNEL = "UCaaaaaaaaaaaaaaaaaaaaaa";
const KEY = "test-key";

/** The adapter over a store nothing else can see, with its fetch stubbed. */
function adapterWith(seed: Record<string, string>, get: StatFetch) {
  return new YouTubeAdapter({ store: new MemoryStore(), log: testLogger(), seed, get });
}

/** Answers whatever it is asked, and remembers the ids it was asked about. */
function fakeGet() {
  const ids: string[] = [];
  const get: StatFetch = async (url) => {
    const parsed = new URL(url);
    ids.push(`${parsed.pathname.split("/").pop()}:${parsed.searchParams.get("id")}`);
    return {
      status: 200,
      body: { items: [{ statistics: { subscriberCount: "940", likeCount: "97" } }] },
    };
  };
  return Object.assign(get, { ids });
}

function testSink(): ChatSink {
  return { event: () => {}, status: () => {}, changed: () => {} };
}

beforeEach(() => {
  chats.length = 0;
});

describe("the chat it reads", () => {
  it("asks for every message, not YouTube's filtered top chat", async () => {
    const adapter = adapterWith({ channelId: CHANNEL, apiKey: KEY }, fakeGet());
    await adapter.start(testSink());

    expect(chats[0]!.chatType).toBe("live");
  });
});

describe("the live video id", () => {
  it("has no likes before chat has found a stream", async () => {
    const get = fakeGet();
    const adapter = adapterWith({ channelId: CHANNEL, apiKey: KEY }, get);

    const stats = await adapter.stats();

    expect(stats.counts).toEqual({ subscribers: 940 });
    expect(stats.detail).toContain("No live stream yet");
    expect(get.ids).toEqual([`channels:${CHANNEL}`]);
  });

  it("counts likes on the video chat is reading", async () => {
    const get = fakeGet();
    const adapter = adapterWith({ channelId: CHANNEL, apiKey: KEY }, get);
    await adapter.start(testSink());
    chats[0]!.emit("start", "vid12345678");

    const stats = await adapter.stats();

    expect(stats.counts).toEqual({ subscribers: 940, likes: 97 });
    expect(get.ids).toContain("videos:vid12345678");
  });

  it("stops counting likes when she goes offline", async () => {
    // The likes belonged to that video. Keeping the id would render one
    // stream's likes on the next one's goal, hours later, off a stale number.
    const adapter = adapterWith({ channelId: CHANNEL, apiKey: KEY }, fakeGet());
    await adapter.start(testSink());
    chats[0]!.emit("start", "vid12345678");
    chats[0]!.emit("end");

    expect((await adapter.stats()).counts).toEqual({ subscribers: 940 });
  });

  it("stops counting likes when the adapter stops", async () => {
    const adapter = adapterWith({ channelId: CHANNEL, apiKey: KEY }, fakeGet());
    await adapter.start(testSink());
    chats[0]!.emit("start", "vid12345678");
    await adapter.stop();

    expect((await adapter.stats()).counts).toEqual({ subscribers: 940 });
  });

  it("keeps counting likes on a video she pinned by hand", async () => {
    // YT_LIVE_ID is the testing path, and it names one video on purpose. That
    // one survives chat ending, because she said which video she meant.
    const adapter = adapterWith({ liveId: "pinned12345", apiKey: KEY }, fakeGet());
    await adapter.start(testSink());
    chats[0]!.emit("start", "pinned12345");
    chats[0]!.emit("end");

    expect((await adapter.stats()).counts.likes).toBe(97);
  });

  it("follows chat to a second stream rather than holding the first id", async () => {
    const get = fakeGet();
    const adapter = adapterWith({ channelId: CHANNEL, apiKey: KEY }, get);
    await adapter.start(testSink());
    chats[0]!.emit("start", "first123456");
    await adapter.stats();

    chats[0]!.emit("end");
    chats[0]!.emit("start", "second12345");
    await adapter.stats();

    expect(get.ids.at(-1)).toBe("videos:second12345");
  });
});

describe("her settings", () => {
  it("waits, and says so, when she has not set a channel yet", async () => {
    // Registered unconditionally now, so this is the state a fresh install is
    // in. An adapter that were simply absent would say nothing at all.
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() });
    const statuses: ConnectionStatus[] = [];
    await adapter.start({ event: () => {}, status: (s) => statuses.push(s), changed: () => {} });

    expect(chats).toHaveLength(0);
    expect(statuses.at(-1)!.detail).toContain("No YouTube channel set yet");
  });

  it("starts reading the channel she saves, without a restart", async () => {
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() });
    await adapter.start(testSink());

    expect(await adapter.settings.save({ channelId: CHANNEL, apiKey: KEY })).toEqual({ ok: true });

    expect(chats).toHaveLength(1);
    expect(chats[0]!.source).toEqual({ channelId: CHANNEL });
  });

  it("takes the URL she would actually paste", async () => {
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() });
    await adapter.start(testSink());

    await adapter.settings.save({
      channelId: `https://www.youtube.com/channel/${CHANNEL}/live`,
      apiKey: "",
    });

    expect(adapter.settings.view().channelId).toBe(CHANNEL);
  });

  it("refuses a handle in words, and leaves the channel she had alone", async () => {
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() });
    await adapter.start(testSink());
    await adapter.settings.save({ channelId: CHANNEL, apiKey: "" });

    const result = await adapter.settings.save({ channelId: "@herhandle", apiKey: "" });

    expect(result).toEqual({ ok: false, reason: expect.stringContaining("handle") });
    // A typo must not cost her the channel that was working.
    expect(adapter.settings.view().channelId).toBe(CHANNEL);
  });

  it("goes idle when she clears the channel, which is the way out", async () => {
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() });
    const statuses: ConnectionStatus[] = [];
    await adapter.start({ event: () => {}, status: (s) => statuses.push(s), changed: () => {} });
    await adapter.settings.save({ channelId: CHANNEL, apiKey: "" });

    await adapter.settings.save({ channelId: "", apiKey: "" });

    expect(chats[0]!.stopped).toBe(true);
    expect(statuses.at(-1)!.detail).toContain("No YouTube channel set yet");
  });

  it("never puts the key in what a client is sent", async () => {
    // This slice reaches every connected page, and in IRL mode one of them is
    // her phone over somebody else's network.
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() });
    await adapter.settings.save({ channelId: CHANNEL, apiKey: KEY });

    const view = adapter.settings.view();
    expect(view.hasKey).toBe(true);
    expect(JSON.stringify(view)).not.toContain(KEY);
  });

  it("keeps the key she saved when she saves the channel again", async () => {
    // Blank means unchanged, because the field is never prefilled with it.
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() });
    await adapter.settings.save({ channelId: CHANNEL, apiKey: KEY });

    await adapter.settings.save({ channelId: CHANNEL, apiKey: "" });

    expect(adapter.settings.view().hasKey).toBe(true);
  });

  it("forgets the key when she asks, and says the counts are off", async () => {
    const get = fakeGet();
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger(), get });
    await adapter.settings.save({ channelId: CHANNEL, apiKey: KEY });

    expect(await adapter.settings.forgetKey()).toEqual({ ok: true });

    expect(adapter.settings.view().hasKey).toBe(false);
    const stats = await adapter.stats();
    expect(stats.counts).toEqual({});
    expect(stats.detail).toContain("API key");
    // Chat does not use the key, so nothing was torn down to forget it.
    expect(get.ids).toEqual([]);
  });

  it("survives a restart, because she is not setting this up twice", async () => {
    const store = new MemoryStore();
    const first = new YouTubeAdapter({ store, log: testLogger() });
    await first.settings.save({ channelId: CHANNEL, apiKey: KEY });

    const second = new YouTubeAdapter({ store, log: testLogger() });

    expect(second.settings.view()).toMatchObject({ channelId: CHANNEL, hasKey: true });
  });

  it("lets what she saved beat a leftover env seed", async () => {
    // YT_CHANNEL_ID is the testing switch. One left set from a session months
    // ago must not quietly take her stream back over.
    const store = new MemoryStore();
    const first = new YouTubeAdapter({ store, log: testLogger() });
    await first.settings.save({ channelId: CHANNEL, apiKey: "" });

    const second = new YouTubeAdapter({
      store,
      log: testLogger(),
      seed: { channelId: "UCbbbbbbbbbbbbbbbbbbbbbb" },
    });

    expect(second.settings.view().channelId).toBe(CHANNEL);
  });

  it("seeds from the env while she has saved nothing", async () => {
    const adapter = new YouTubeAdapter({
      store: new MemoryStore(),
      log: testLogger(),
      seed: { channelId: CHANNEL, apiKey: KEY },
    });

    expect(adapter.settings.view()).toMatchObject({ channelId: CHANNEL, hasKey: true });
  });

  it("tells her where to find the id rather than making the page know", async () => {
    const adapter = new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() });
    expect(adapter.settings.view().hint).toContain("YouTube Studio");
  });
});
