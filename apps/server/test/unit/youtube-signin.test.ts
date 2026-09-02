import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatSink } from "../../src/chat/adapter.js";
import type { FormPost, FormResponse } from "../../src/chat/youtube-oauth.js";
import type { JsonRequest, JsonResponse } from "../../src/chat/youtube-writes.js";
import { MemoryStore, type StateStore } from "../../src/core/store.js";
import { testLogger } from "../helpers/logger.js";

/**
 * Her Google sign-in, the writes it buys, and the ways it goes away again.
 *
 * The adapter rather than the pure halves, because everything interesting here
 * is state that outlives a call: a poll that runs on the server while she types
 * a code somewhere else, an access token refreshed under a burst of writes, and
 * a capability that appears and disappears while nothing restarts.
 *
 * The chat library stands in for a live stream, the same way it does in
 * `youtube-adapter.test.ts`: two of the three writes are addressed to the chat
 * on the video she is live on, so there has to be one.
 */

const chats = vi.hoisted(() => [] as { emit(name: string, arg?: unknown): void }[]);

vi.mock("youtube-chat-next", () => {
  class LiveChat {
    private handlers = new Map<string, (arg?: unknown) => void>();
    constructor(
      public source: unknown,
      _interval?: number,
      public chatType?: string,
    ) {
      chats.push(this as never);
    }
    on(name: string, handler: (arg?: unknown) => void): void {
      this.handlers.set(name, handler);
    }
    async start(): Promise<boolean> {
      return true;
    }
    stop(): void {}
    emit(name: string, arg?: unknown): void {
      this.handlers.get(name)?.(arg);
    }
  }
  return { LiveChat };
});

const { YouTubeAdapter } = await import("../../src/chat/youtube.js");

const CLIENT = { id: "client", secret: "shh" };
const CHAT_ID = "Cg0KC2FiY2RlZmdoaWpr";
const VIDEO = "vid-1";

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
  body: { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 },
};
const REFRESHED: FormResponse = { status: 200, body: { access_token: "at-2", expires_in: 3600 } };
const REVOKED: FormResponse = { status: 400, body: { error: "invalid_grant" } };

/** Google, scripted. Later calls repeat the last answer, as a poll would. */
function google(script: FormResponse[]) {
  const asked: { url: string; form: Record<string, string> }[] = [];
  let next = 0;
  const post: FormPost = async (url, form) => {
    asked.push({ url, form });
    return script[Math.min(next++, script.length - 1)]!;
  };
  return { post, asked, get calls() { return asked.length; } };
}

/** Nothing should call this. A build with no credential makes no requests. */
const unreachable: FormPost = async () => {
  throw new Error("a build with no credential must not call Google");
};
/** YouTube's write side, scripted the same way. */
function api(script: JsonResponse[] = [{ status: 200, body: {} }]) {
  const asked: Parameters<JsonRequest>[0][] = [];
  let next = 0;
  const request: JsonRequest = async (input) => {
    asked.push(input);
    // The chat lookup is a GET and always answers with one, so a test only has
    // to script the writes it cares about.
    if (input.method === "GET") {
      return { status: 200, body: { items: [{ liveStreamingDetails: { activeLiveChatId: CHAT_ID } }] } };
    }
    return script[Math.min(next++, script.length - 1)]!;
  };
  return { request, asked, writes: () => asked.filter((one) => one.method !== "GET") };
}

interface Kit {
  adapter: InstanceType<typeof YouTubeAdapter>;
  store: StateStore;
  changes: number;
  /** Pretend chat connected on a video, which is where a chat id comes from. */
  goLive(): void;
}

function build(options: {
  post: FormPost;
  request?: JsonRequest;
  store?: StateStore;
  client?: { id: string; secret: string } | null;
}): Kit {
  const store = options.store ?? new MemoryStore();
  const kit = {
    store,
    changes: 0,
  } as Kit;
  kit.adapter = new YouTubeAdapter({
    store,
    log: testLogger(),
    client: options.client === undefined ? CLIENT : options.client,
    post: options.post,
    request: options.request ?? api().request,
    seed: { channelId: "UCaaaaaaaaaaaaaaaaaaaaaa" },
  });
  const sink: ChatSink = {
    event: () => {},
    status: () => {},
    changed: () => {
      kit.changes += 1;
    },
  };
  void kit.adapter.start(sink);
  kit.goLive = () => chats.at(-1)?.emit("start", VIDEO);
  return kit;
}

const signInView = (kit: Kit) => kit.adapter.settings.view().signIn!;

beforeEach(() => {
  chats.length = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a build with no credential compiled in", () => {
  it("asks for one rather than failing a call that could not work", async () => {
    // Which is dev, CI, and every build where the credential was never filled
    // in. All of them behave exactly as they did with no write path at all,
    // and the way forward is her own credential rather than a new build.
    const kit = build({ post: unreachable, client: null });

    expect(await kit.adapter.settings.signIn!()).toEqual({
      ok: false,
      reason: "Add a Google client ID and secret first, so the bot has something to sign in with.",
    });
    expect(signInView(kit).granted).toBe(false);
    expect(signInView(kit).detail).toContain("cannot reply or moderate");
    // And the card is told it is the only way in, so it puts the fields in
    // front of her rather than behind a fold.
    expect(signInView(kit).builtIn).toBe(false);
    expect(kit.adapter.writes).toBeUndefined();
  });

  it("signs in on a credential of hers, which is the whole point of offering one", async () => {
    const g = google([CODE_ANSWER, GRANTED]);
    const kit = build({ post: g.post, client: null });

    expect(
      await kit.adapter.settings.setClient!({
        clientId: "hers.apps.googleusercontent.com",
        clientSecret: "GOCSPX-hers",
      }),
    ).toEqual({ ok: true });

    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(signInView(kit).granted).toBe(true);
    // Hers is what Google was asked with, which is the difference between her
    // own daily allowance and a pool every install shares.
    expect(g.asked[0]!.form.client_id).toBe("hers.apps.googleusercontent.com");
    expect(g.asked[1]!.form.client_secret).toBe("GOCSPX-hers");
  });
});

describe("a credential of her own", () => {
  const HERS = {
    clientId: "hers.apps.googleusercontent.com",
    clientSecret: "GOCSPX-hers",
  };

  it("wins over the one the build carries", async () => {
    const g = google([CODE_ANSWER, PENDING]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.setClient!(HERS);
    await kit.adapter.settings.signIn!();

    expect(g.asked[0]!.form.client_id).toBe(HERS.clientId);
  });

  it("goes back to the built-in one when she forgets hers", async () => {
    const g = google([CODE_ANSWER, PENDING]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.setClient!(HERS);
    await kit.adapter.settings.forgetClient!();

    await kit.adapter.settings.signIn!();
    expect(g.asked[0]!.form.client_id).toBe(CLIENT.id);
    expect(signInView(kit).clientId).toBe("");
    expect(signInView(kit).hasClientSecret).toBe(false);
  });

  it("echoes the id back and never the secret", async () => {
    // The id is public -- Google prints it on the consent screen -- and reading
    // it back is how she checks which of the two boxes she pasted where. The
    // secret is write-only, like every other secret on this card.
    const kit = build({ post: unreachable });
    await kit.adapter.settings.setClient!(HERS);

    const view = kit.adapter.settings.view();
    expect(view.signIn!.clientId).toBe(HERS.clientId);
    expect(view.signIn!.hasClientSecret).toBe(true);
    expect(JSON.stringify(view)).not.toContain("GOCSPX-hers");
  });

  it("keeps the stored secret when she saves with the box left blank", async () => {
    const g = google([CODE_ANSWER, PENDING]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.setClient!(HERS);

    // Blank means "leave it alone", because it is never sent back to prefill
    // the box with. Otherwise editing the id would silently wipe the secret.
    expect(
      await kit.adapter.settings.setClient!({
        clientId: "other.apps.googleusercontent.com",
        clientSecret: "",
      }),
    ).toEqual({ ok: true });

    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(g.asked[0]!.form.client_id).toBe("other.apps.googleusercontent.com");
    // The token exchange is the call that carries the secret, so this is the
    // one that proves the stored half survived a save of the other half.
    expect(g.asked[1]!.form.client_secret).toBe(HERS.clientSecret);
  });

  it("refuses the API key in the client ID box, which is the likely mistake", async () => {
    // The two live one card apart and both look like a long opaque string. The
    // failure without this check is Google's words about an invalid client,
    // which name neither box.
    const kit = build({ post: unreachable });
    expect(
      await kit.adapter.settings.setClient!({ clientId: "AIzaSyFake", clientSecret: "s" }),
    ).toEqual({
      ok: false,
      reason: "That is a YouTube API key, not an OAuth client ID. The key goes in the box above.",
    });
    // Refused before anything is written, so a mistake does not replace the
    // credential she had.
    expect(signInView(kit).clientId).toBe("");
  });

  it("says when the two boxes are the other way round", async () => {
    const kit = build({ post: unreachable });
    expect(
      await kit.adapter.settings.setClient!({ clientId: "GOCSPX-secret", clientSecret: "s" }),
    ).toEqual({
      ok: false,
      reason: "That is the client secret, not the client ID. They are the other way round.",
    });
  });

  it("refuses half a credential rather than storing one that can only fail", async () => {
    const kit = build({ post: unreachable });
    expect(await kit.adapter.settings.setClient!({ clientId: "", clientSecret: "s" })).toEqual({
      ok: false,
      reason: "Paste the client ID as well as the secret.",
    });
    expect(await kit.adapter.settings.setClient!({ ...HERS, clientSecret: "" })).toEqual({
      ok: false,
      reason: "Paste the client secret as well.",
    });
  });

  it("signs her out when the credential changes underneath a grant", async () => {
    const g = google([CODE_ANSWER, GRANTED]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kit.adapter.writes).toBeDefined();

    await kit.adapter.settings.setClient!(HERS);

    // A refresh token belongs to the client it was issued to. Leaving it in
    // place would show her a card saying she is signed in and a bot refusing
    // every write with Google's words about an invalid client.
    expect(kit.adapter.writes).toBeUndefined();
    expect(signInView(kit).granted).toBe(false);
    expect(kit.store.read("youtube")!.refreshToken).toBe("");
  });

  it("leaves a working grant alone when she saves the same credential again", async () => {
    const g = google([CODE_ANSWER, GRANTED]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.setClient!(HERS);
    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);

    // Re-saving to correct a typo in nothing at all must not cost her the
    // sign-in she just did.
    await kit.adapter.settings.setClient!({ clientId: HERS.clientId, clientSecret: "" });
    expect(kit.adapter.writes).toBeDefined();
  });

  it("takes the grant with it when she forgets the credential it was issued to", async () => {
    const g = google([CODE_ANSWER, GRANTED]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.setClient!(HERS);
    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);

    await kit.adapter.settings.forgetClient!();
    expect(kit.adapter.writes).toBeUndefined();
  });
});

describe("signing in", () => {
  it("answers at once with a code, rather than waiting for her", async () => {
    // She has to read this off a phone and type it into a browser, which takes
    // a minute or five. An action that did not return until she had done it
    // would be a spinner on her phone for five minutes.
    const g = google([CODE_ANSWER, PENDING]);
    const kit = build({ post: g.post });

    expect(await kit.adapter.settings.signIn!()).toEqual({ ok: true });

    const view = signInView(kit);
    expect(view.granted).toBe(false);
    expect(view.pending).toMatchObject({
      code: "ABCD-EFGH",
      url: "https://www.google.com/device",
    });
    expect(view.detail).toContain("Waiting for her to type the code");
    // The code is in the slice, so a page that reconnects rejoins this sign-in
    // instead of starting a rival one.
    expect(kit.changes).toBe(1);
    // And still nothing can write until Google says yes.
    expect(kit.adapter.writes).toBeUndefined();
  });

  it("keeps polling while she is still typing, then grows the capability", async () => {
    const g = google([CODE_ANSWER, PENDING, PENDING, GRANTED]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(signInView(kit).pending).toBeDefined();
    expect(kit.adapter.writes).toBeUndefined();

    await vi.advanceTimersByTimeAsync(10_000);

    const view = signInView(kit);
    expect(view.granted).toBe(true);
    expect(view.pending).toBeUndefined();
    expect(view.detail).toContain("The bot can reply in chat and take messages down");
    // The capability appeared with nothing restarted, which is the whole shape
    // of this feature.
    expect(kit.adapter.writes).toBeDefined();
    // And the refresh token is on disk, so the next boot is already signed in.
    expect(kit.store.read("youtube")!.refreshToken).toBe("rt-1");
  });

  it("never puts the token in the slice, only whether there is one", async () => {
    const g = google([CODE_ANSWER, GRANTED]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);

    // This slice reaches every client, and in IRL mode one of them is her
    // phone over somebody else's network.
    expect(JSON.stringify(kit.adapter.settings.view())).not.toContain("rt-1");
    expect(JSON.stringify(kit.adapter.settings.view())).not.toContain("at-1");
  });

  it("waits longer when Google says slow down, without treating it as a refusal", async () => {
    const g = google([CODE_ANSWER, { status: 403, body: { error: "slow_down" } }, GRANTED]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(signInView(kit).pending).toBeDefined();

    // Five seconds would have been the old interval; it is ten now.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signInView(kit).granted).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(signInView(kit).granted).toBe(true);
  });

  it("gives up on the code she never typed, and says why", async () => {
    const g = google([CODE_ANSWER, PENDING]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();

    // The code is good for ten minutes here. Nothing has to be running at the
    // moment it lapses: the next poll notices the clock has passed it.
    await vi.advanceTimersByTimeAsync(11 * 60_000);

    const view = signInView(kit);
    expect(view.pending).toBeUndefined();
    expect(view.granted).toBe(false);
    expect(view.detail).toBe("That code ran out. Start the sign-in again.");
  });

  it("leaves nothing behind when she turns the sign-in down", async () => {
    const g = google([CODE_ANSWER, { status: 403, body: { error: "access_denied" } }]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(signInView(kit).detail).toBe("Sign-in was turned down. Nothing has changed.");
    expect(kit.adapter.writes).toBeUndefined();
    // Nothing was written at all, which is the honest shape of "nothing has
    // changed": there was no grant to clear.
    expect(kit.store.read("youtube")?.refreshToken ?? "").toBe("");
  });

  it("replaces a pending code when she starts again", async () => {
    const g = google([CODE_ANSWER, CODE_ANSWER, PENDING]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();
    await kit.adapter.settings.signIn!();

    // The old poll is dropped rather than left running against a code she has
    // decided not to use.
    const before = g.calls;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(g.calls).toBe(before + 1);
  });
});

describe("signing out", () => {
  it("is the way out of a grant, and takes the capability with it", async () => {
    const g = google([CODE_ANSWER, GRANTED]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(kit.adapter.writes).toBeDefined();

    expect(await kit.adapter.settings.signOut!()).toEqual({ ok: true });
    expect(kit.adapter.writes).toBeUndefined();
    expect(kit.store.read("youtube")!.refreshToken).toBe("");
    expect(signInView(kit).granted).toBe(false);
  });

  it("ignores a grant that arrives after she cancelled", async () => {
    // The poll she cancelled may already be in flight, and Google may be
    // about to say yes. Signing her back in because of a request she called
    // off is the one outcome here that would look like a bug with teeth.
    let release = (_answer: FormResponse) => {};
    const held = new Promise<FormResponse>((resolve) => {
      release = resolve;
    });
    let call = 0;
    const post: FormPost = async () => {
      call += 1;
      return call === 1 ? CODE_ANSWER : held;
    };

    const kit = build({ post });
    await kit.adapter.settings.signIn!();
    // The second call is now waiting on `held`.
    await vi.advanceTimersByTimeAsync(5_000);

    await kit.adapter.settings.signOut!();
    release(GRANTED);
    await vi.advanceTimersByTimeAsync(0);

    expect(signInView(kit).granted).toBe(false);
    expect(kit.adapter.writes).toBeUndefined();
    expect(kit.store.read("youtube")!.refreshToken).toBe("");
  });

  it("also cancels a sign-in she started by accident", async () => {
    const g = google([CODE_ANSWER, PENDING]);
    const kit = build({ post: g.post });
    await kit.adapter.settings.signIn!();

    await kit.adapter.settings.signOut!();
    expect(signInView(kit).pending).toBeUndefined();

    // And the poll stops, rather than granting minutes later against a
    // sign-in she cancelled.
    const before = g.calls;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(g.calls).toBe(before);
  });
});

describe("what a grant is still worth after a restart", () => {
  it("comes back signed in, from the store alone", async () => {
    const store = new MemoryStore();
    const first = build({ post: google([CODE_ANSWER, GRANTED]).post, store });
    await first.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);
    await first.adapter.stop();

    // No code to type again: the refresh token is the durable half, and the
    // access token it buys is worth one call on the way up.
    const again = build({ post: google([REFRESHED]).post, store });
    expect(again.adapter.writes).toBeDefined();
    expect(signInView(again).granted).toBe(true);
  });
});

describe("the writes themselves", () => {
  async function signedIn(over: { request?: JsonRequest; post?: FormPost } = {}) {
    const store = new MemoryStore();
    store.write("youtube", {
      channelId: "UCaaaaaaaaaaaaaaaaaaaaaa",
      apiKey: "",
      refreshToken: "rt-1",
    });
    const kit = build({
      post: over.post ?? google([REFRESHED]).post,
      request: over.request,
      store,
    });
    // `start` opens the reader across a dynamic import, so the fake chat does
    // not exist until the microtasks have run.
    await vi.advanceTimersByTimeAsync(0);
    kit.goLive();
    return kit;
  }

  it("finds the chat once per broadcast and writes to it after that", async () => {
    const yt = api();
    const kit = await signedIn({ request: yt.request });

    await kit.adapter.writes!.say("first");
    await kit.adapter.writes!.say("second");

    // One lookup, two posts. It costs a quota unit and cannot change while a
    // video is live, so paying for it twice is paying for nothing.
    expect(yt.asked.filter((one) => one.method === "GET")).toHaveLength(1);
    expect(yt.writes()).toHaveLength(2);
    expect(yt.writes()[0]!.body).toMatchObject({
      snippet: { liveChatId: CHAT_ID, textMessageDetails: { messageText: "first" } },
    });
  });

  it("takes a message down without needing the chat at all", async () => {
    const yt = api();
    const kit = await signedIn({ request: yt.request });

    await kit.adapter.writes!.deleteMessage("msg-1");

    // Which is why a row still in her queue after the broadcast ended can
    // still be acted on.
    expect(yt.asked.filter((one) => one.method === "GET")).toHaveLength(0);
    expect(yt.asked[0]!.method).toBe("DELETE");
  });

  it("refreshes once for a burst of writes, not once each", async () => {
    // Her sweeping the queue is twenty writes in a row, and twenty
    // simultaneous refreshes of one token is a way to get rate limited for
    // pressing one button.
    const g = google([REFRESHED]);
    const kit = await signedIn({ post: g.post });

    await Promise.all([
      kit.adapter.writes!.deleteMessage("a"),
      kit.adapter.writes!.deleteMessage("b"),
      kit.adapter.writes!.deleteMessage("c"),
    ]);

    expect(g.calls).toBe(1);
  });

  it("reuses the access token until it is nearly expired", async () => {
    const g = google([REFRESHED]);
    const kit = await signedIn({ post: g.post });

    await kit.adapter.writes!.deleteMessage("a");
    expect(g.calls).toBe(1);

    // Well inside the hour.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await kit.adapter.writes!.deleteMessage("b");
    expect(g.calls).toBe(1);

    // Fifty seconds of life left, so this is still a valid token and it is
    // refreshed anyway: `REFRESH_MARGIN_MS` is what stops a token expiring
    // between being handed out and being used, and the only way to see it is
    // to ask inside the margin rather than past the expiry.
    await vi.advanceTimersByTimeAsync(29 * 60_000 + 10_000);
    await kit.adapter.writes!.deleteMessage("c");
    expect(g.calls).toBe(2);
  });

  it("says she is not live rather than asking YouTube about no video", async () => {
    const yt = api();
    const store = new MemoryStore();
    store.write("youtube", { channelId: "", apiKey: "", refreshToken: "rt-1" });
    const kit = build({ post: google([REFRESHED]).post, request: yt.request, store });

    await expect(kit.adapter.writes!.say("hello")).rejects.toThrow(
      "She is not live right now, so there is no chat to write to.",
    );
    expect(yt.asked).toHaveLength(0);
  });

  it("forgets the chat when the broadcast ends", async () => {
    const yt = api();
    const kit = await signedIn({ request: yt.request });
    await kit.adapter.writes!.say("during");

    chats.at(-1)!.emit("end");
    // A chat id from last night's stream is a line posted where nobody is
    // reading, so it goes when the video does.
    await expect(kit.adapter.writes!.say("after")).rejects.toThrow("not live right now");
  });

  it("loses the grant on a revoked token, and nothing queues behind it", async () => {
    const kit = await signedIn({ post: google([REVOKED]).post });

    await expect(kit.adapter.writes!.deleteMessage("a")).rejects.toThrow(
      "Her Google sign-in is no longer valid. Sign in again to let the bot write.",
    );

    // The capability is gone, so her queue reverts to the sentence it showed
    // before there was a write path, and re-consent is one button.
    expect(kit.adapter.writes).toBeUndefined();
    expect(kit.store.read("youtube")!.refreshToken).toBe("");
    expect(kit.changes).toBeGreaterThan(0);
  });

  it("keeps the grant through a refusal that is not about the grant", async () => {
    const kit = await signedIn({
      post: google([{ status: 429, body: { error: "rate_limit_exceeded" } }]).post,
    });

    await expect(kit.adapter.writes!.deleteMessage("a")).rejects.toThrow();
    // Pressing the button again is worth trying. Typing a code again is not.
    expect(kit.adapter.writes).toBeDefined();
    expect(kit.store.read("youtube")!.refreshToken).toBe("rt-1");
  });

  it("keeps her channel and her key when the grant is saved over them", async () => {
    // One namespace, three fields, and a save that dropped two of them would
    // silently un-set the channel chat is reading.
    const store = new MemoryStore();
    const kit = build({ post: google([CODE_ANSWER, GRANTED]).post, store });
    await kit.adapter.settings.save({ channelId: "UCbbbbbbbbbbbbbbbbbbbbbb", apiKey: "k" });
    await kit.adapter.settings.signIn!();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(kit.store.read("youtube")).toEqual({
      channelId: "UCbbbbbbbbbbbbbbbbbbbbbb",
      apiKey: "k",
      refreshToken: "rt-1",
      clientId: "",
      clientSecret: "",
    });
  });
});
