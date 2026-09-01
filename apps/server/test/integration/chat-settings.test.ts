import { afterEach, describe, expect, it } from "vitest";
import { CORE_ACTIONS, CORE_ID, type ChatView, type InvokeResult } from "@saarathi/shared";
import type { ChatAdapter } from "../../src/chat/adapter.js";
import { YouTubeAdapter } from "../../src/chat/youtube.js";
import { MemoryStore } from "../../src/core/store.js";
import { harness, type Harness } from "../helpers/kernel.js";
import { testLogger } from "../helpers/logger.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
});

const CHANNEL = "UCaaaaaaaaaaaaaaaaaaaaaa";
const KEY = "a-real-looking-key";

/** An adapter she can set up, without a platform behind it. */
function settable(name = "youtube") {
  let view: ChatView = { title: "YouTube", channelId: "", hasKey: false, hint: "somewhere" };
  let forgot = 0;

  const adapter: ChatAdapter & { forgot: () => number } = {
    name,
    async start(sink) {
      sink.status({ state: "disconnected", detail: "Nothing set up yet" });
    },
    async stop() {},
    settings: {
      view: () => view,
      save: async ({ channelId, apiKey }): Promise<InvokeResult> => {
        view = { ...view, channelId, hasKey: apiKey !== "" || view.hasKey };
        return { ok: true };
      },
      forgetKey: async (): Promise<InvokeResult> => {
        forgot += 1;
        view = { ...view, hasKey: false };
        return { ok: true };
      },
    },
    forgot: () => forgot,
  };
  return adapter;
}

const corePatches = (h: Harness) => h.seen.patches.filter((p) => p.module === CORE_ID);

describe("her chat settings", () => {
  it("reaches the adapter from her control page and republishes the slice", async () => {
    live = await harness({ chat: [settable()] });
    live.seen.clear();

    const result = await live.kernel.invoke(CORE_ACTIONS.chatSettings, {
      args: ["youtube", CHANNEL, KEY],
    });

    expect(result).toEqual({ ok: true });
    expect(live.kernel.coreState().chat.youtube).toMatchObject({
      channelId: CHANNEL,
      hasKey: true,
    });
    // Her phone is rendering the old fields until this lands.
    expect(corePatches(live).length).toBeGreaterThan(0);
  });

  it("republishes for Forget key too, which reconnects nothing", async () => {
    const youtube = settable();
    live = await harness({ chat: [youtube] });
    await live.kernel.invoke(CORE_ACTIONS.chatSettings, { args: ["youtube", CHANNEL, KEY] });
    live.seen.clear();

    await live.kernel.invoke(CORE_ACTIONS.chatForgetKey, { args: ["youtube"] });

    expect(youtube.forgot()).toBe(1);
    expect(live.kernel.coreState().chat.youtube!.hasKey).toBe(false);
    // Nothing about the connection changed, so this patch is the only thing
    // that will ever tell her page the key is gone.
    expect(corePatches(live).length).toBeGreaterThan(0);
  });

  it("refuses a name that is not an adapter rather than failing quietly", async () => {
    live = await harness({ chat: [settable()] });
    const result = await live.kernel.invoke(CORE_ACTIONS.chatForgetKey, { args: ["twitch"] });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("twitch") });
  });

  it("keeps the key off every socket, and remembers it across a restart", async () => {
    // The real adapter, with no channel: the key is saved and chat stays idle,
    // which is exactly the state she is in between setting the two fields.
    const store = new MemoryStore();
    const youtube = () => new YouTubeAdapter({ store, log: testLogger() });

    live = await harness({ chat: [youtube()], store });
    await live.kernel.invoke(CORE_ACTIONS.chatSettings, { args: ["youtube", "", KEY] });

    expect(live.kernel.coreState().chat.youtube!.hasKey).toBe(true);
    expect(JSON.stringify(live.kernel.snapshot())).not.toContain(KEY);

    await live.stop();
    live = await harness({ chat: [youtube()], store });

    // She is not setting this up a second time because OBS reloaded a source.
    expect(live.kernel.coreState().chat.youtube!.hasKey).toBe(true);
    expect(JSON.stringify(live.kernel.snapshot())).not.toContain(KEY);
  });
});
