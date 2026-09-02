import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_ACTIONS, CORE_ID } from "@saarathi/shared";
import type { FormPost, FormResponse } from "../../src/chat/youtube-oauth.js";
import type { JsonRequest } from "../../src/chat/youtube-writes.js";
import { YouTubeAdapter } from "../../src/chat/youtube.js";
import { MemoryStore, type StateStore } from "../../src/core/store.js";
import { harness, type Harness } from "../helpers/kernel.js";
import { testLogger } from "../helpers/logger.js";

/**
 * Her Google sign-in as it reaches a running kernel.
 *
 * The unit tests drive the adapter directly, which proves the flow. This tier
 * proves the two things only a kernel can: that the device code arrives in the
 * *core slice* as a patch -- because the interesting half of a sign-in happens
 * minutes after the action she invoked has returned, with nothing in flight to
 * hang it on -- and that a grant survives the restart she does when OBS reloads
 * or the tray is closed.
 *
 * It is here rather than in e2e for one reason: an e2e run boots the real
 * server, and the real server talks to the real Google. There is no way to
 * script a device flow through a child process, so the seam is injected here
 * instead, one tier down. What e2e does cover is the routing -- see
 * `signin.e2e.test.ts`.
 */

const CLIENT = { id: "client", secret: "shh" };

const CODE_ANSWER: FormResponse = {
  status: 200,
  body: {
    device_code: "dev-code",
    user_code: "ABCD-EFGH",
    verification_url: "https://www.google.com/device",
    expires_in: 600,
    interval: 5,
  },
};
const PENDING: FormResponse = { status: 428, body: { error: "authorization_pending" } };
const GRANTED: FormResponse = {
  status: 200,
  body: { access_token: "at-1", refresh_token: "rt-secret", expires_in: 3600 },
};
const REFRESHED: FormResponse = { status: 200, body: { access_token: "at-2", expires_in: 3600 } };

/** Google, scripted. Later calls repeat the last answer, as a poll would. */
function google(script: FormResponse[]) {
  let next = 0;
  const post: FormPost = async () => script[Math.min(next++, script.length - 1)]!;
  return post;
}

/** Enough of YouTube's write side to let a write land. */
const api: JsonRequest = async (input) =>
  input.method === "GET"
    ? { status: 200, body: { items: [{ liveStreamingDetails: { activeLiveChatId: "chat-1" } }] } }
    : { status: 200, body: {} };

let live: Harness | null = null;

async function boot(options: { post: FormPost; store?: StateStore }): Promise<Harness> {
  const store = options.store ?? new MemoryStore();
  const youtube = new YouTubeAdapter({
    store,
    log: testLogger(),
    client: CLIENT,
    post: options.post,
    request: api,
    // No channel, deliberately: an adapter with one opens a real reader
    // against YouTube, and nothing here needs chat to be connected -- signing
    // in is a thing she does before she goes live. It is also the state she is
    // actually in while she sets this up.
  });
  live = await harness({ chat: [youtube], store });
  await vi.advanceTimersByTimeAsync(0);
  return live;
}

const signIn = (h: Harness) => h.kernel.coreState().chat.youtube!.signIn!;
const corePatches = (h: Harness) => h.seen.patches.filter((p) => p.module === CORE_ID);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

describe("signing the bot in, from her control page", () => {
  it("puts the code she has to type in the slice, not in the answer", async () => {
    // Which is what makes it survivable: she reads it on her phone, unlocks a
    // laptop, and the page she left open is looking at the same sign-in. A
    // code that only came back on the invoke would be gone the moment that tab
    // reloaded.
    const h = await boot({ post: google([CODE_ANSWER, PENDING]) });
    h.seen.clear();

    const result = await h.kernel.invoke(CORE_ACTIONS.chatSignIn, { args: ["youtube"] });

    expect(result).toEqual({ ok: true });
    expect(signIn(h).pending).toMatchObject({
      code: "ABCD-EFGH",
      url: "https://www.google.com/device",
    });
    // Server time, because her phone's clock is routinely tens of seconds out.
    expect(signIn(h).pending!.expiresAt).toBeGreaterThan(h.kernel.snapshot().serverNow);
    expect(corePatches(h).length).toBeGreaterThan(0);
  });

  it("tells every page it worked, minutes after the action returned", async () => {
    // The patch under test is the one nothing asked for: the grant lands while
    // she is typing on another device, so there is no invoke to answer with
    // it. This is what `ChatSink.changed` is for.
    const h = await boot({ post: google([CODE_ANSWER, PENDING, GRANTED]) });
    await h.kernel.invoke(CORE_ACTIONS.chatSignIn, { args: ["youtube"] });
    h.seen.clear();

    expect(h.kernel.coreState().writes.adapter).toBeNull();

    // Two polls: still waiting, then Google says yes.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(signIn(h).granted).toBe(true);
    expect(signIn(h).pending).toBeUndefined();
    expect(corePatches(h).length).toBeGreaterThan(0);
    // And the capability appeared underneath a running kernel, with nothing
    // restarted: this is the moment her queue's buttons light up.
    expect(h.kernel.coreState().writes.adapter).toBe("youtube");
  });

  it("keeps the token off every socket", async () => {
    const h = await boot({ post: google([CODE_ANSWER, GRANTED]) });
    await h.kernel.invoke(CORE_ACTIONS.chatSignIn, { args: ["youtube"] });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(signIn(h).granted).toBe(true);
    // In IRL mode one of these clients is her phone on somebody else's
    // network. `granted` is everything the two buttons need.
    expect(JSON.stringify(h.kernel.snapshot())).not.toContain("rt-secret");
    expect(JSON.stringify(h.kernel.snapshot())).not.toContain(CLIENT.secret);
  });

  it("comes back signed in after a restart, with no code to type again", async () => {
    const store = new MemoryStore();
    const h = await boot({ post: google([CODE_ANSWER, GRANTED]), store });
    await h.kernel.invoke(CORE_ACTIONS.chatSignIn, { args: ["youtube"] });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signIn(h).granted).toBe(true);
    await live!.stop();

    // OBS reloaded a source, or she closed the tray. Neither is a reason to
    // ask her for a device code again -- and the pending sign-in is *not*
    // durable, because a code attached to a poll nobody is running is worse
    // than none.
    const again = await boot({ post: google([REFRESHED]), store });

    expect(signIn(again).granted).toBe(true);
    expect(signIn(again).pending).toBeUndefined();
    expect(again.kernel.coreState().writes.adapter).toBe("youtube");
    expect(JSON.stringify(again.kernel.snapshot())).not.toContain("rt-secret");
  });

  it("takes the capability away again when she signs out", async () => {
    // The reverse state, through the same seam her deck reaches: if there is a
    // way in there is a way out, and it has to be visible on her card.
    const h = await boot({ post: google([CODE_ANSWER, GRANTED]) });
    await h.kernel.invoke(CORE_ACTIONS.chatSignIn, { args: ["youtube"] });
    await vi.advanceTimersByTimeAsync(5_000);
    h.seen.clear();

    await h.kernel.invoke(CORE_ACTIONS.chatSignOut, { args: ["youtube"] });

    expect(signIn(h).granted).toBe(false);
    expect(h.kernel.coreState().writes.adapter).toBeNull();
    expect(corePatches(h).length).toBeGreaterThan(0);
  });

  it("refuses the four of them by name for an adapter with no sign-in", async () => {
    // Mock chat is registered beside the real adapter on every run, so this is
    // a name that exists and still cannot answer.
    live = await harness();
    for (const action of [
      CORE_ACTIONS.chatSignIn,
      CORE_ACTIONS.chatSignOut,
      CORE_ACTIONS.chatClient,
      CORE_ACTIONS.chatForgetClient,
    ]) {
      const result = await live.kernel.invoke(action, { args: ["mock"] });
      expect(result.ok).toBe(false);
    }
  });
});
