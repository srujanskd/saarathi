import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionStatus, StreamEvent } from "@saarathi/shared";
import type { ChatSink } from "../../src/chat/adapter.js";
import type { StatFetch } from "../../src/chat/youtube-stats.js";

/**
 * Where the like count comes from, which is the one part of it that is not in
 * `youtube-stats.ts`: `videos.list` needs a video id, and the only place the
 * adapter ever learns one is chat's own `start` event. So likes exist exactly
 * while chat is connected, and this file is what keeps that true.
 */

const chats = vi.hoisted(() => [] as FakeChat[]);

interface FakeChat {
  source: unknown;
  emit(name: string, arg?: unknown): void;
  stopped: boolean;
}

vi.mock("youtube-chat-next", () => {
  class LiveChat {
    private handlers = new Map<string, (arg?: unknown) => void>();
    stopped = false;
    constructor(public source: unknown) {
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

const CHANNEL = "UCchannel";
const KEY = "test-key";

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
  const noop = (_: StreamEvent | ConnectionStatus) => {};
  return { event: noop, status: noop };
}

beforeEach(() => {
  chats.length = 0;
});

describe("the live video id", () => {
  it("has no likes before chat has found a stream", async () => {
    const get = fakeGet();
    const adapter = new YouTubeAdapter({ channelId: CHANNEL, apiKey: KEY }, get);

    const stats = await adapter.stats();

    expect(stats.counts).toEqual({ subscribers: 940 });
    expect(stats.detail).toContain("No live stream yet");
    expect(get.ids).toEqual([`channels:${CHANNEL}`]);
  });

  it("counts likes on the video chat is reading", async () => {
    const get = fakeGet();
    const adapter = new YouTubeAdapter({ channelId: CHANNEL, apiKey: KEY }, get);
    await adapter.start(testSink());
    chats[0]!.emit("start", "vid12345678");

    const stats = await adapter.stats();

    expect(stats.counts).toEqual({ subscribers: 940, likes: 97 });
    expect(get.ids).toContain("videos:vid12345678");
  });

  it("stops counting likes when she goes offline", async () => {
    // The likes belonged to that video. Keeping the id would render one
    // stream's likes on the next one's goal, hours later, off a stale number.
    const adapter = new YouTubeAdapter({ channelId: CHANNEL, apiKey: KEY }, fakeGet());
    await adapter.start(testSink());
    chats[0]!.emit("start", "vid12345678");
    chats[0]!.emit("end");

    expect((await adapter.stats()).counts).toEqual({ subscribers: 940 });
  });

  it("stops counting likes when the adapter stops", async () => {
    const adapter = new YouTubeAdapter({ channelId: CHANNEL, apiKey: KEY }, fakeGet());
    await adapter.start(testSink());
    chats[0]!.emit("start", "vid12345678");
    await adapter.stop();

    expect((await adapter.stats()).counts).toEqual({ subscribers: 940 });
  });

  it("keeps counting likes on a video she pinned by hand", async () => {
    // YT_LIVE_ID is the testing path, and it names one video on purpose. That
    // one survives chat ending, because she said which video she meant.
    const adapter = new YouTubeAdapter({ liveId: "pinned12345", apiKey: KEY }, fakeGet());
    await adapter.start(testSink());
    chats[0]!.emit("start", "pinned12345");
    chats[0]!.emit("end");

    expect((await adapter.stats()).counts.likes).toBe(97);
  });

  it("follows chat to a second stream rather than holding the first id", async () => {
    const get = fakeGet();
    const adapter = new YouTubeAdapter({ channelId: CHANNEL, apiKey: KEY }, get);
    await adapter.start(testSink());
    chats[0]!.emit("start", "first123456");
    await adapter.stats();

    chats[0]!.emit("end");
    chats[0]!.emit("start", "second12345");
    await adapter.stats();

    expect(get.ids.at(-1)).toBe("videos:second12345");
  });
});
