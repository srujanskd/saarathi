import { describe, expect, it } from "vitest";
import { CORE_ACTIONS, type ChatView, type InvokeResult } from "@saarathi/shared";
import {
  chatCommand,
  chatViews,
  type ChatAdapter,
  type ChatClientInput,
} from "../../src/chat/adapter.js";
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

/**
 * An adapter with the whole of `ChatSettings`, sign-in included.
 *
 * Separate from `settable` on purpose: the four sign-in methods are optional,
 * and what happens on an adapter that has not got them is a behaviour worth a
 * test of its own -- see the refusals below.
 */
function signable(name = "youtube") {
  const calls: { what: string; input?: ChatClientInput }[] = [];
  const adapter = {
    ...settable(name),
    calls,
  };
  Object.assign(adapter.settings!, {
    signIn: async (): Promise<InvokeResult> => {
      calls.push({ what: "signIn" });
      return { ok: true };
    },
    signOut: async (): Promise<InvokeResult> => {
      calls.push({ what: "signOut" });
      return { ok: true };
    },
    setClient: async (input: ChatClientInput): Promise<InvokeResult> => {
      calls.push({ what: "setClient", input });
      return { ok: true };
    },
    forgetClient: async (): Promise<InvokeResult> => {
      calls.push({ what: "forgetClient" });
      return { ok: true };
    },
  });
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

  /**
   * The four sign-in actions, which reach an adapter through this same seam.
   *
   * Here rather than only through the kernel because this is the wire contract
   * her control page, the HTTP invoke path and a deck button all encode: which
   * argument is the client id and which is the secret, and what an adapter with
   * no sign-in says instead of doing nothing.
   */
  describe("the sign-in actions", () => {
    it("routes each one to the adapter she named", async () => {
      const youtube = signable();
      const other = signable("twitch");
      const both = [other, youtube];

      await chatCommand(both, CORE_ACTIONS.chatSignIn, ["youtube"])!;
      await chatCommand(both, CORE_ACTIONS.chatSignOut, ["youtube"])!;
      await chatCommand(both, CORE_ACTIONS.chatForgetClient, ["youtube"])!;

      expect(youtube.calls.map((one) => one.what)).toEqual(["signIn", "signOut", "forgetClient"]);
      expect(other.calls).toEqual([]);
    });

    it("puts the client id and the secret in the boxes she pasted them into", async () => {
      // The argument order is the contract: swapped, she gets Google's
      // "invalid client", which names neither box.
      const youtube = signable();
      const result = await chatCommand(
        [youtube],
        CORE_ACTIONS.chatClient,
        ["youtube", " hers.apps.googleusercontent.com ", " GOCSPX-hers\n"],
      )!;

      expect(result).toEqual({ ok: true });
      expect(youtube.calls).toEqual([
        {
          what: "setClient",
          // Trimmed, because a phone's paste brings whitespace with it.
          input: {
            clientId: "hers.apps.googleusercontent.com",
            clientSecret: "GOCSPX-hers",
          },
        },
      ]);
    });

    it("passes a blank secret through, because blank means unchanged", async () => {
      const youtube = signable();
      await chatCommand([youtube], CORE_ACTIONS.chatClient, [
        "youtube",
        "hers.apps.googleusercontent.com",
      ])!;
      expect(youtube.calls[0]!.input).toEqual({
        clientId: "hers.apps.googleusercontent.com",
        clientSecret: "",
      });
    });

    it("refuses by name on an adapter that needs no sign-in", async () => {
      // A deck button she made on a build that had a sign-in, pressed on one
      // that does not. Silence would leave her pressing it again.
      const plain = settable();
      for (const action of [
        CORE_ACTIONS.chatSignIn,
        CORE_ACTIONS.chatSignOut,
        CORE_ACTIONS.chatClient,
        CORE_ACTIONS.chatForgetClient,
      ]) {
        const result = await chatCommand([plain], action, ["youtube"])!;
        expect(result).toEqual({ ok: false, reason: "youtube needs no sign-in" });
      }
    });

    it("answers for each of them rather than leaving one unrouted", () => {
      // A new action id that never reaches `CHAT_ACTIONS` would fall through
      // the registry as "no such action", which is a silence on her card.
      for (const action of [
        CORE_ACTIONS.chatSignIn,
        CORE_ACTIONS.chatSignOut,
        CORE_ACTIONS.chatClient,
        CORE_ACTIONS.chatForgetClient,
      ]) {
        expect(chatCommand([signable()], action, ["youtube"])).not.toBeNull();
      }
    });
  });
});

describe("chatViews", () => {
  it("leaves out the adapters with nothing to set up", () => {
    const views = chatViews([new MockChatAdapter(), settable()]);
    expect(Object.keys(views)).toEqual(["youtube"]);
  });
});
