import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_ACTIONS } from "@saarathi/shared";
import { harness, type Harness } from "../helpers/kernel.js";
import { MemoryStore } from "../../src/core/store.js";
import { testLogger } from "../helpers/logger.js";
import { gains } from "../../src/modules/gains/index.js";

const readers = vi.hoisted(() => [] as {
  source: unknown;
  stopped: boolean;
  emit(name: string, value: unknown): void;
}[]);

vi.mock("youtube-chat-next", () => ({
  LiveChat: class {
    stopped = false;
    handlers = new Map<string, (value: unknown) => void>();
    constructor(public source: unknown) { readers.push(this); }
    on(name: string, handler: (value: unknown) => void) { this.handlers.set(name, handler); }
    async start() { return true; }
    stop() { this.stopped = true; }
    emit(name: string, value: unknown) { this.handlers.get(name)?.(value); }
  },
}));

const { YouTubeAdapter } = await import("../../src/chat/youtube.js");
let live: Harness | null = null;
afterEach(async () => { await live?.stop(); live = null; readers.length = 0; });
const CHANNEL = "UCaaaaaaaaaaaaaaaaaaaaaa";
const VIDEO = "abcdefghijk";
const URL = `https://www.youtube.com/watch?v=${VIDEO}`;

describe("choosing an unlisted stream", () => {
  it("uses the pasted video, dispatches commands, and remembers the choice on restart", async () => {
    const store = new MemoryStore();
    const adapter = () => new YouTubeAdapter({ store, log: testLogger() });
    live = await harness({ store, chat: [adapter()], modules: [gains] });
    expect(await live.kernel.invoke(CORE_ACTIONS.chatSettings, {
      args: ["youtube", CHANNEL, "", URL],
    })).toEqual({ ok: true });
    expect(readers.at(-1)!.source).toEqual({ liveId: VIDEO });

    readers.at(-1)!.emit("chat", {
      author: { name: "Viewer", channelId: "viewer-id" }, message: [{ text: "!points" }],
    });
    await vi.waitFor(() => expect(live!.seen.said().some((line) => line.includes("@Viewer"))).toBe(true));
    expect(live.kernel.coreState().chat.youtube).toMatchObject({ stream: { url: URL } });
    await live.stop();
    live = await harness({ store, chat: [adapter()], modules: [gains] });
    expect(readers.at(-1)!.source).toEqual({ liveId: VIDEO });
    expect(live.kernel.coreState().chat.youtube).toMatchObject({ stream: { url: URL } });

    expect(await live.kernel.invoke(CORE_ACTIONS.chatSettings, {
      args: ["youtube", CHANNEL, "", ""],
    })).toEqual({ ok: true });
    expect(readers.at(-2)!.stopped).toBe(true);
    expect(readers.at(-1)!.source).toEqual({ channelId: CHANNEL });
  });

  it("refuses an invalid link before replacing the working source", async () => {
    live = await harness({ chat: [new YouTubeAdapter({ store: new MemoryStore(), log: testLogger() })] });
    await live.kernel.invoke(CORE_ACTIONS.chatSettings, { args: ["youtube", CHANNEL, "", URL] });
    const result = await live.kernel.invoke(CORE_ACTIONS.chatSettings, {
      args: ["youtube", CHANNEL, "", "https://example.com/watch?v=abcdefghijk"],
    });
    expect(result.ok).toBe(false);
    expect(readers).toHaveLength(1);
    expect(live.kernel.coreState().chat.youtube).toMatchObject({ stream: { url: URL } });
  });
});
