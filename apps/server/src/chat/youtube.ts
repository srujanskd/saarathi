import type {
  Author,
  ChannelStats,
  ChatSignInView,
  ChatView,
  InvokeResult,
  Logger,
  Money,
  StreamEvent,
} from "@saarathi/shared";
import type { ChatType } from "youtube-chat-next";
import type { StateStore } from "../core/store.js";
import {
  WriteRefused,
  type ChatAdapter,
  type ChatSettings,
  type ChatSink,
  type ChatWrites,
} from "./adapter.js";
import { YouTubeGrant } from "./youtube-grant.js";
import {
  CLIENT_WHERE,
  SIGN_IN_LASTS,
  clientFrom,
  clientIdProblem,
  httpForm,
  type FormPost,
  type OAuthClient,
} from "./youtube-oauth.js";
import { collectStats, httpGet, type StatFetch } from "./youtube-stats.js";
import {
  activeChatId,
  banUser,
  deleteMessage,
  httpJson,
  insertMessage,
  type Api,
  type JsonRequest,
} from "./youtube-writes.js";

/** What she has set up, and all of what this adapter persists. */
interface Saved {
  channelId: string;
  /**
   * A YouTube Data API key, for the counts only -- chat is read over InnerTube
   * and costs no quota. Public-data path: no OAuth, no consent screen, no
   * billing account. Blank is ordinary, and means no counts.
   *
   * Plaintext in her state file, beside the OBS password and on the same
   * reasoning. What this key can do if it leaks is read data that is already
   * public and spend a quota that resets daily; it cannot post, delete, ban or
   * read anything private, and revoking it is one click in the console.
   * Encrypting it with a key stored next to it stops nobody, and the version
   * that would mean something -- Windows DPAPI through Electron's safeStorage
   * -- is unreachable from here on purpose: this process never imports
   * Electron, because it has to run on a VPS the day IRL mode happens. What
   * actually bounds the damage is that it never leaves the server, never
   * reaches a log, and is restricted to the YouTube Data API in the console.
   *
   * The OAuth credential beside it is a different question with a different
   * answer. See `YouTubeGrant`.
   */
  apiKey: string;
  /**
   * Her Google grant, and the only thing here that can change her channel.
   *
   * A refresh token, plaintext, on the same reasoning as the key above and with
   * one difference that matters: this one can post, delete and ban, so the
   * state file is written 0600 and AGENTS no longer says it makes good test
   * data. It never leaves the server -- the slice carries `granted` -- never
   * reaches a log, and she can revoke it from her Google account.
   *
   * Blank is ordinary and means the bot reads chat and writes nothing, which is
   * how every build before this one behaved and how a dev run, CI and a VPS
   * with no grant all still behave.
   */
  refreshToken: string;
  /**
   * Her own OAuth client, when she would rather not use the one this build
   * carries -- or when it carries none, which is the ordinary case.
   *
   * Hers wins, and the reason to offer it at all is quota: the daily allowance
   * belongs to the Google project the credential came from, so a shared one is
   * a pool every install draws on and hers is 10,000 units nobody else can
   * spend. That is the difference between the bot going quiet at 4pm because
   * somebody else was busy and it going quiet because she was.
   *
   * The id is echoed back to her page and the secret is not, on the same split
   * as her channel and her API key: an id is public -- Google prints it on the
   * consent screen -- and being able to see it is how she checks she pasted the
   * right one. The secret is write-only, so blank means "leave it alone".
   *
   * It is a much smaller credential than the refresh token beside it: it
   * identifies an app rather than granting anything, and it can do nothing at
   * all until somebody types a device code into their own Google account.
   */
  clientId: string;
  clientSecret: string;
}

/** Env values, which seed her settings only when she has saved nothing. */
export interface YouTubeSeed {
  channelId?: string;
  /**
   * One video, pinned by hand. The testing path and deliberately not on her
   * page: it names a single stream, so it outlives chat ending, where a video
   * learned from chat does not.
   */
  liveId?: string;
  apiKey?: string;
}

export interface YouTubeOptions {
  store: StateStore;
  log: Logger;
  seed?: YouTubeSeed;
  /** Injected so every branch of the counts is testable without a key. */
  get?: StatFetch;
  /** Injected so the sign-in is testable without a Google account. */
  post?: FormPost;
  /** Injected so the three writes are testable without a token. */
  request?: JsonRequest;
  /**
   * The credential this build carries, or null when it carries none.
   *
   * The fallback, not the source: hers wins whenever she has saved one. Passed
   * rather than read here so a test can hand over a fake one, and so the
   * composition root stays the only file that reads the environment.
   */
  client?: OAuthClient | null;
}

const RETRY_MS = 60_000;

/**
 * Every message, not YouTube's filtered "top" chat. The library defaults to
 * "top" -- the subset its UI hides the full feed behind a toggle -- so the
 * default meant we were reading a version of her chat with messages missing,
 * chosen by YouTube. Two things break on that and both are silent: a
 * moderation rule cannot flag a scam it was never shown, and gains under-pay
 * the viewers whose lines got filtered.
 */
const CHAT_TYPE: ChatType = "live";

/** A channel id is UC and 22 more, and nothing else is one. */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const CHANNEL_URL = /\/channel\/(UC[A-Za-z0-9_-]{22})/;
const HANDLE = /(^|\/)@[A-Za-z0-9._-]+/;

/**
 * The one sentence that answers "where do I get this". It is here rather than
 * on her page because it is a fact about YouTube, and `ChatView` carries it
 * out for the same reason `ChannelStats.detail` carries its own words.
 */
const WHERE = "In YouTube Studio: Settings \u2192 Channel \u2192 Advanced settings shows it, starting with UC.";

/**
 * Her channel id out of whatever she pasted, or what to tell her instead.
 *
 * She will paste a URL, because that is what a browser gives her when she is
 * looking at her own channel. A handle gets its own sentence: it is the thing
 * she is most likely to reach for and the one thing that looks most like an
 * answer, and neither chat nor the counts can do anything with one.
 */
export function channelIdFrom(input: string): { id: string } | { reason: string } {
  const text = input.trim();
  if (CHANNEL_ID.test(text)) return { id: text };

  const inUrl = CHANNEL_URL.exec(text);
  if (inUrl) return { id: inUrl[1]! };

  if (HANDLE.test(text)) {
    return { reason: `That is a handle, not a channel id. ${WHERE}` };
  }
  return { reason: `That does not look like a channel id. ${WHERE}` };
}

/**
 * YouTube live chat over youtube-chat-next: InnerTube, so no API quota and no
 * OAuth. The official API is only ever used for writing (bot replies, mod
 * actions), because polling chat through it burns the daily quota in an
 * afternoon.
 *
 * This is the one place `any` is tolerated, and only at the boundary -- every
 * item is converted to a normalized event before it leaves the file.
 */
export class YouTubeAdapter implements ChatAdapter {
  readonly name = "youtube";
  private chat: any = null;
  private sink: ChatSink | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  /**
   * The video she is live on, which `videos.list` needs and which nothing but
   * chat can tell us: YouTube's own `start` event carries it, and she runs on a
   * channel id rather than a video id, so there is nowhere else it comes from.
   * Null while chat is not connected, and likes are honestly absent for exactly
   * that long.
   */
  private videoId: string | null;
  /**
   * The id of the *chat* on that video, which is not the video id and is what
   * two of the three writes are addressed to.
   *
   * Learned from the official API and cached for the life of the broadcast,
   * because it costs a quota unit and cannot change while a video is live. It
   * goes when the video does, everywhere the video does: a chat id from last
   * night's stream is a write posted into a chat nobody is reading.
   */
  private liveChatId: string | null = null;
  /**
   * The lookup in flight, if there is one.
   *
   * Shared for the reason `YouTubeGrant.refreshing` is, and it is the same
   * burst: sweeping her queue is twenty writes at once, and on a cold cache
   * every one of them would otherwise ask YouTube which chat this is. Twenty
   * lookups is nineteen wasted quota units and a rate limit for pressing one
   * button -- the exact failure the shared refresh exists to avoid, one call
   * further down.
   *
   * Cleared when it settles, so a failed lookup is retried rather than
   * remembered: this is a de-duplicator for callers that arrive together, not
   * a second cache beside `liveChatId`.
   */
  private chatIdLookup: Promise<string> | null = null;
  private saved: Saved;
  private readonly seed: YouTubeSeed;
  private readonly get: StatFetch;
  private readonly request: JsonRequest;
  private readonly grant: YouTubeGrant;
  /** What this build carries, if anything. Never hers. See `Saved.clientId`. */
  private readonly builtIn: OAuthClient | null;

  constructor(private readonly options: YouTubeOptions) {
    this.seed = options.seed ?? {};
    this.get = options.get ?? httpGet;
    this.request = options.request ?? httpJson;
    this.saved = this.load();
    this.videoId = this.seed.liveId ?? null;
    this.builtIn = options.client ?? null;
    this.grant = new YouTubeGrant(
      {
        // Hers first, the build's second. Asked for on every use rather than
        // captured, so pasting a credential changes what the next sign-in uses
        // without anything being restarted.
        client: () => this.ownClient() ?? this.builtIn,
        post: options.post ?? httpForm,
        log: options.log,
        save: (refreshToken) => this.write({ ...this.saved, refreshToken }),
        // The sink is not here yet -- this runs before `start` -- so it is
        // reached through the field rather than captured.
        onChange: () => this.sink?.changed(),
      },
      this.saved.refreshToken,
    );
  }

  // --- lifecycle ------------------------------------------------------------

  /**
   * Registered unconditionally, unlike before: she sets her channel up from her
   * phone, so this has to exist before there is anything set up in it. With no
   * channel it says so and waits, which is a status she can act on rather than
   * an adapter that is silently not there.
   */
  async start(sink: ChatSink): Promise<void> {
    this.sink = sink;
    this.stopped = false;
    await this.open();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.close();
    // A poll waiting on a code she walked away from must not outlive the
    // adapter, and must not be what keeps the tray from shutting down.
    this.grant.stop();
    this.sink = null;
  }

  /**
   * The three writes, or nothing at all when she has not signed in.
   *
   * A getter rather than a field, which is the whole of how this capability
   * comes and goes underneath a running server: `ChatWriter` reads
   * `adapter.writes` at the moment of every write, so signing in makes the
   * queue's buttons appear and a revoked grant makes them go away, with nothing
   * restarted and nothing cached. Before she signs in this adapter is
   * indistinguishable from the one that shipped before there was a write path.
   */
  get writes(): ChatWrites | undefined {
    return this.grant.granted ? this.writeCalls : undefined;
  }

  /**
   * What those three calls actually are.
   *
   * Each takes a fresh token rather than holding one: `grant.token()` refreshes
   * when it is close to expiring and shares one refresh between callers, which
   * matters because the callers arrive in twenties when she sweeps her queue.
   */
  private readonly writeCalls: ChatWrites = {
    say: async (text) => {
      const api = await this.api();
      await insertMessage(await this.chatId(api), text, api);
    },
    // Addressed to the message, so it needs no chat id and works on one from a
    // broadcast that has already ended -- which is exactly the row still
    // sitting in her queue twenty minutes later.
    deleteMessage: async (messageId) => {
      await deleteMessage(messageId, await this.api());
    },
    ban: async (authorId) => {
      const api = await this.api();
      await banUser(await this.chatId(api), authorId, api);
    },
  };

  /**
   * A fresh token and the way to spend it.
   *
   * Fetched per write rather than held: `grant.token()` refreshes when it is
   * close to expiring and shares one refresh between callers, which matters
   * because the callers arrive in twenties when she sweeps her queue.
   */
  private async api(): Promise<Api> {
    return { token: await this.grant.token(), request: this.request };
  }

  /**
   * The counts, for whoever polls. Two calls, one quota unit each, and neither
   * is required to succeed: the answer carries whichever numbers it got and a
   * sentence about the rest.
   */
  async stats(): Promise<ChannelStats> {
    return collectStats(
      { apiKey: this.saved.apiKey, channelId: this.saved.channelId, videoId: this.videoId },
      this.get,
    );
  }

  // --- her surfaces ---------------------------------------------------------

  readonly settings: ChatSettings = {
    view: (): ChatView => ({
      title: "YouTube",
      channelId: this.saved.channelId,
      // The key never travels. This is what the field and Forget key render on,
      // and it is everything a page needs to know about either.
      hasKey: this.saved.apiKey !== "",
      hint: WHERE,
      signIn: this.signInView(),
    }),

    save: async ({ channelId, apiKey }): Promise<InvokeResult> => {
      let id = "";
      if (channelId !== "") {
        const parsed = channelIdFrom(channelId);
        // Refused before anything is written, so a typo leaves her working
        // channel alone rather than replacing it with the typo.
        if ("reason" in parsed) return { ok: false, reason: parsed.reason };
        id = parsed.id;
      }

      this.write({
        ...this.saved,
        channelId: id,
        // Blank means "leave it alone", because it is never sent to a client to
        // prefill the field with. Forgetting it is its own button.
        apiKey: apiKey || this.saved.apiKey,
      });
      // Chat is already reading the old channel, or is idle for want of one.
      // Either way what it is doing is now wrong.
      await this.reopen();
      return { ok: true };
    },

    forgetKey: async (): Promise<InvokeResult> => {
      // Chat does not use the key, so nothing reconnects: the next poll simply
      // finds no key and says so.
      this.write({ ...this.saved, apiKey: "" });
      return { ok: true };
    },

    // Both of these are the grant's, in full. What a Google sign-in involves
    // is knowledge about this platform, which is why it lives behind the
    // settings seam rather than on a core surface -- a Twitch adapter that
    // grows one brings its own, and her card renders both the same way.
    signIn: () => this.grant.signIn(),
    signOut: () => this.grant.signOut(),

    setClient: async ({ clientId, clientSecret }): Promise<InvokeResult> => {
      // Refused before anything is written, so a mistake leaves the credential
      // she had alone rather than replacing it with the mistake. The same
      // courtesy `channelIdFrom` does for a channel, and needed for the same
      // reason: she is going to paste the API key in here at least once.
      const wrong = clientIdProblem(clientId);
      if (wrong) return { ok: false, reason: wrong };

      const secret = clientSecret || this.saved.clientSecret;
      if (secret === "") return { ok: false, reason: "Paste the client secret as well." };

      const before = this.ownClient();
      this.write({ ...this.saved, clientId: clientId.trim(), clientSecret: secret });

      // A refresh token belongs to the client it was issued to, so a different
      // credential makes hers worthless -- and leaving it in place would show
      // her a card that says she is signed in and a bot that refuses every
      // write with Google's words about an invalid client. Signing out is the
      // honest state and it costs her one button.
      const after = this.ownClient();
      if (this.grant.granted && before?.id !== after?.id) await this.grant.signOut();
      return { ok: true };
    },

    forgetClient: async (): Promise<InvokeResult> => {
      // The way back to whatever the build carries, which on a build that
      // carries nothing is the way back to no sign-in at all. Either way it is
      // the reverse of the button above, and a grant issued to a credential
      // she has just deleted is not one to keep.
      const had = this.ownClient() !== null;
      this.write({ ...this.saved, clientId: "", clientSecret: "" });
      if (had && this.grant.granted) await this.grant.signOut();
      return { ok: true };
    },
  };

  /**
   * The whole sign-in view, in one place.
   *
   * Half of it is the grant's -- whether there is one, what is pending, the
   * sentence about it -- and half is the credential's, which the grant
   * deliberately knows nothing about: it is handed a client and cannot tell
   * whether it was hers or the build's, and that ignorance is what lets
   * `GrantOptions.client` change underneath it. So the two halves are joined
   * here rather than in the middle of `view`, where reaching into the grant
   * for one and the saved fields for the other made the shape of
   * `ChatSignInView` a thing you had to read two files to see.
   *
   * Neither the refresh token nor the client secret travels, on the same rule
   * the API key follows: this slice reaches every client, and one of them is
   * her phone on somebody else's network.
   */
  private signInView(): ChatSignInView {
    return {
      ...this.grant.view(),
      clientId: this.saved.clientId,
      hasClientSecret: this.saved.clientSecret !== "",
      // Whether hers is an override or the only way in, which is the one thing
      // that changes how prominently her card asks for it.
      builtIn: this.builtIn !== null,
      clientHint: `${CLIENT_WHERE} ${SIGN_IN_LASTS}`,
    };
  }

  /** Her own credential, if she has saved a complete one. */
  private ownClient(): OAuthClient | null {
    return clientFrom(this.saved.clientId, this.saved.clientSecret);
  }

  /**
   * The chat id for the video she is live on, fetched once per broadcast.
   *
   * A write that needs one while she is offline is a write with nowhere to go,
   * and saying so is more useful than a 404 from Google: chat is read over
   * InnerTube, so this adapter knows she is not live long before the API would
   * tell us.
   */
  private async chatId(api: Api): Promise<string> {
    if (this.liveChatId) return this.liveChatId;
    const videoId = this.videoId;
    if (!videoId) throw new WriteRefused("She is not live right now, so there is no chat to write to.");

    this.chatIdLookup ??= activeChatId(videoId, api)
      .then((id) => {
        // Only if this is still the broadcast we asked about. A stream that
        // ended mid-lookup cleared the field, and writing the answer back would
        // put the bot's next line in last night's chat.
        if (this.videoId === videoId) this.liveChatId = id;
        return id;
      })
      .finally(() => {
        this.chatIdLookup = null;
      });
    return this.chatIdLookup;
  }

  /**
   * Drop everything about the chat on the broadcast that just ended.
   *
   * One method rather than two assignments at four call sites, because
   * forgetting the id and leaving a lookup in flight would let an answer about
   * last night's stream land as this one's.
   */
  private forgetChat(): void {
    this.liveChatId = null;
    this.chatIdLookup = null;
  }

  // --- connecting -----------------------------------------------------------

  /** One reader, if there is a channel to point it at. */
  private async open(): Promise<void> {
    if (this.stopped || !this.sink) return;

    const sink = this.sink;
    const source = this.seed.liveId
      ? { liveId: this.seed.liveId }
      : this.saved.channelId
        ? { channelId: this.saved.channelId }
        : null;

    if (!source) {
      sink.status({
        state: "disconnected",
        detail: "No YouTube channel set yet. Add hers on the control page.",
      });
      return;
    }

    const { LiveChat } = await import("youtube-chat-next");
    // Middle argument is the poll interval. The library's default is fine.
    this.chat = new LiveChat(source, undefined, CHAT_TYPE);

    this.chat.on("start", (liveId: string) => {
      this.videoId = liveId;
      // A new broadcast is a new chat. Keeping the old id here would post the
      // bot's next line into last night's stream.
      this.forgetChat();
      sink.status({ state: "connected", detail: `Reading live chat (video ${liveId})` });
    });

    this.chat.on("end", () => {
      // She went offline. The likes belonged to that video and the next stream
      // starts its own count, so holding on to this id would render one stream's
      // likes on the next one's goal.
      this.videoId = this.seed.liveId ?? null;
      this.forgetChat();
      sink.status({
        state: "disconnected",
        detail: "Live chat ended. Watching for her next stream.",
      });
      this.scheduleRetry();
    });

    this.chat.on("error", (err: unknown) => {
      sink.status({ state: "error", detail: String(err) });
    });

    this.chat.on("chat", (item: any) => {
      const event = normalize(item);
      if (event) sink.event(event);
    });

    await this.tryStart();
  }

  /** Drops the reader without ending the adapter, which `stop` does. */
  private close(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.chat?.stop?.();
    this.chat = null;
    this.videoId = this.seed.liveId ?? null;
    this.forgetChat();
  }

  private async reopen(): Promise<void> {
    this.close();
    await this.open();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.tryStart();
    }, RETRY_MS);
    this.retryTimer.unref?.();
  }

  private async tryStart(): Promise<void> {
    if (this.stopped || !this.sink || !this.chat) return;
    this.sink.status({ state: "connecting", detail: "Looking for a live stream..." });
    const ok = await this.chat.start().catch(() => false);
    // She may have saved a different channel while that was in flight, which
    // closed this reader. Reporting on it would talk about a channel she has
    // already replaced.
    if (!ok && !this.stopped && this.sink && this.chat) {
      this.sink.status({
        state: "disconnected",
        detail: `No live stream found. Checking again every ${RETRY_MS / 1000}s.`,
      });
      this.scheduleRetry();
    }
  }

  // --- plumbing -------------------------------------------------------------

  /**
   * Her settings, or the env as a seed. The env wins only while she has saved
   * nothing: once she has set a channel from her phone, hers is the answer, so
   * a YT_CHANNEL_ID left over from a testing session cannot quietly take her
   * stream back over.
   */
  private load(): Saved {
    const saved = this.options.store.read(this.name);
    if (!saved) {
      // No seed for the grant, deliberately: a refresh token in an env var is a
      // credential in a shell history, and unlike a channel id there is no
      // testing story it unlocks -- signing in is two taps.
      return {
        channelId: this.seed.channelId ?? "",
        apiKey: this.seed.apiKey ?? "",
        refreshToken: "",
        clientId: "",
        clientSecret: "",
      };
    }
    return {
      channelId: typeof saved.channelId === "string" ? saved.channelId : "",
      apiKey: typeof saved.apiKey === "string" ? saved.apiKey : "",
      refreshToken: typeof saved.refreshToken === "string" ? saved.refreshToken : "",
      clientId: typeof saved.clientId === "string" ? saved.clientId : "",
      clientSecret: typeof saved.clientSecret === "string" ? saved.clientSecret : "",
    };
  }

  private write(saved: Saved): void {
    this.saved = saved;
    // Its own namespace, not core's: the registry rewrites the whole `core`
    // namespace every time she switches a module on or off.
    this.options.store.write(this.name, { ...saved });
    // Never the key, never the token, never the client secret -- only whether
    // there is one. This line is the reason all three are described rather
    // than printed. The client id is public and printed, because when a
    // sign-in fails it is the one of the four worth reading back.
    this.options.log.info(
      `youtube: channel ${saved.channelId || "(none)"}, API key ${
        saved.apiKey ? "set" : "not set"
      }, client ${saved.clientId || "(built in)"}, sign-in ${
        saved.refreshToken ? "granted" : "none"
      }`,
    );
  }
}

/**
 * Exported for tests: adapter normalization is where the platform-specific bugs
 * live, and the alternative is standing up a fake InnerTube client to reach it.
 */
export function normalize(item: any): StreamEvent | null {
  const text: string = (item?.message ?? [])
    .map((run: any) => ("text" in run ? run.text : (run.emojiText ?? "")))
    .join("")
    .trim();

  const author: Author = {
    id: item?.author?.channelId ?? item?.author?.name ?? "unknown",
    name: item?.author?.name ?? "unknown",
    isStreamer: Boolean(item?.isOwner),
    isMod: Boolean(item?.isModerator),
    isMember: Boolean(item?.isMembership || item?.author?.badge),
  };

  const base = {
    source: "youtube",
    author,
    at: Date.now(),
    text,
    // YouTube's own id for the message, which is the handle a delete needs.
    // Absent rather than empty when the library did not give us one: a row in
    // her queue that cannot be acted on has to look like one.
    ...(typeof item?.id === "string" && item.id ? { messageId: item.id } : {}),
  };

  if (item?.superchat) {
    return {
      ...base,
      type: "paid-event",
      kind: item.superchat.sticker ? "sticker" : "superchat",
      amount: parseAmount(item.superchat.amount),
    };
  }
  if (item?.isMembership) return { ...base, type: "new-member" };
  if (text) return { ...base, type: "chat-message" };
  return null;
}

/** Keep what YouTube displayed, and pull a number out of it when we can. */
export function parseAmount(display: unknown): Money {
  const shown = typeof display === "string" ? display : "";
  const digits = shown.replace(/[^\d.]/g, "");
  const value = digits ? Number(digits) : Number.NaN;
  return {
    display: shown || "a tip",
    ...(Number.isFinite(value) ? { value } : {}),
  };
}
