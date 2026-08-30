import { describe, expect, it } from "vitest";
import { CORE_ACTIONS, type ChatView, type InvokeResult } from "@saarathi/shared";
import { chatCommand, chatViews, type ChatAdapter } from "../../src/chat/adapter.js";
import { channelIdFrom } from "../../src/chat/youtube.js";
import { MockChatAdapter } from "../../src/chat/mock.js";

const CHANNEL = "UCaaaaaaaaaaaaaaaaaaaaaa";

/** An adapter that records what her page asked it to do. */
function settable(name = "youtube") {
  const saves: { channelId: string; apiKey: string }[] = [];
  let forgot = 0;
  const view: ChatView = { title: "YouTube", channelId: "", hasKey: false, hint: "somewhere" };

  const adapter: ChatAdapter & { saves: typeof saves; forgot: () => number } = {
    name,
    async start() {},
    async stop() {},
    settings: {
      view: () => view,
      save: async (input): Promise<InvokeResult> => {
        saves.push(input);
        return { ok: true };
      },
      forgetKey: async (): Promise<InvokeResult> => {
        forgot += 1;
        return { ok: true };
      },
    },
    saves,
    forgot: () => forgot,
  };
  return adapter;
}

describe("channelIdFrom", () => {
  it("takes a channel id as it is", () => {
    expect(channelIdFrom(CHANNEL)).toEqual({ id: CHANNEL });
  });

  it("takes the URL she would actually paste out of the address bar", () => {
    expect(channelIdFrom(`https://www.youtube.com/channel/${CHANNEL}`)).toEqual({ id: CHANNEL });
    expect(channelIdFrom(`https://www.youtube.com/channel/${CHANNEL}/live`)).toEqual({
      id: CHANNEL,
    });
  });

  it("ignores the spaces a paste brings with it", () => {
    expect(channelIdFrom(`  ${CHANNEL}\n`)).toEqual({ id: CHANNEL });
  });

  it("names a handle for what it is, because that is what she will reach for", () => {
    // A handle looks more like an answer than the real one does, and neither
    // chat nor the counts can do anything with one.
    for (const input of ["@herhandle", "https://www.youtube.com/@herhandle"]) {
      const result = channelIdFrom(input);
      expect(result).toEqual({ reason: expect.stringContaining("handle") });
      expect(result).toEqual({ reason: expect.stringContaining("YouTube Studio") });
    }
  });

  it("refuses a video URL, which is a different id entirely", () => {
    expect(channelIdFrom("https://www.youtube.com/watch?v=vid12345678")).toEqual({
      reason: expect.stringContaining("channel id"),
    });
  });

  it("refuses an id of the wrong length rather than half-taking it", () => {
    expect(channelIdFrom("UCtooshort")).toEqual({ reason: expect.any(String) });
    expect(channelIdFrom(`${CHANNEL}extra`)).toEqual({ reason: expect.any(String) });
  });
});

describe("chatCommand", () => {
  it("leaves an action that is not one of its own alone", () => {
    expect(chatCommand([settable()], CORE_ACTIONS.obsScene, ["Workout"])).toBeNull();
    expect(chatCommand([settable()], "wheel.spin", [])).toBeNull();
  });

  it("routes her save to the adapter she named", async () => {
    const youtube = settable();
    const other = settable("twitch");

    const result = await chatCommand([other, youtube], CORE_ACTIONS.chatSettings, [
      "youtube",
      CHANNEL,
      "a-key",
    ])!;

    expect(result).toEqual({ ok: true });
    expect(youtube.saves).toEqual([{ channelId: CHANNEL, apiKey: "a-key" }]);
    expect(other.saves).toEqual([]);
  });

  it("routes Forget key the same way", async () => {
    const youtube = settable();
    await chatCommand([youtube], CORE_ACTIONS.chatForgetKey, ["youtube"])!;
    expect(youtube.forgot()).toBe(1);
  });

  it("passes a blank key through, because blank means unchanged", async () => {
    const youtube = settable();
    await chatCommand([youtube], CORE_ACTIONS.chatSettings, ["youtube", CHANNEL])!;
    expect(youtube.saves).toEqual([{ channelId: CHANNEL, apiKey: "" }]);
  });

  it("trims what her keyboard added to a pasted key", async () => {
    const youtube = settable();
    await chatCommand([youtube], CORE_ACTIONS.chatSettings, ["youtube", ` ${CHANNEL} `, " k "])!;
    expect(youtube.saves).toEqual([{ channelId: CHANNEL, apiKey: "k" }]);
  });

  it("refuses in her words for an adapter with nothing to set up", async () => {
    // Mock chat is registered beside the real one on every run, so this is a
    // name that exists and still cannot answer.
    const result = await chatCommand([new MockChatAdapter()], CORE_ACTIONS.chatSettings, [
      "mock",
      CHANNEL,
      "",
    ])!;
    expect(result).toEqual({ ok: false, reason: expect.stringContaining("mock") });
  });

  it("refuses a name that is no adapter at all", async () => {
    const result = await chatCommand([settable()], CORE_ACTIONS.chatForgetKey, ["twitch"])!;
    expect(result.ok).toBe(false);
  });
});

describe("chatViews", () => {
  it("leaves out the adapters with nothing to set up", () => {
    const views = chatViews([new MockChatAdapter(), settable()]);
    expect(Object.keys(views)).toEqual(["youtube"]);
  });
});
