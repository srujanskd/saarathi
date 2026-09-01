import type {
  Author,
  ChannelStats,
  ChatView,
  InvokeResult,
  Logger,
  Money,
  StreamEvent,
} from "@saarathi/shared";
import type { ChatType } from "youtube-chat-next";
import type { StateStore } from "../core/store.js";
import type { ChatAdapter, ChatSettings, ChatSink } from "./adapter.js";
import { collectStats, httpGet, type StatFetch } from "./youtube-stats.js";

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
   * The OAuth credential coming for moderation is a different question with a
   * different answer, and it gets asked again then.
   */
  apiKey: string;
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
  private saved: Saved;
  private readonly seed: YouTubeSeed;
  private readonly get: StatFetch;

  constructor(private readonly options: YouTubeOptions) {
    this.seed = options.seed ?? {};
    this.get = options.get ?? httpGet;
    this.saved = this.load();
    this.videoId = this.seed.liveId ?? null;
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
    this.sink = null;
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
  };

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
      sink.status({ state: "connected", detail: `Reading live chat (video ${liveId})` });
    });

    this.chat.on("end", () => {
      // She went offline. The likes belonged to that video and the next stream
      // starts its own count, so holding on to this id would render one stream's
      // likes on the next one's goal.
      this.videoId = this.seed.liveId ?? null;
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
      return { channelId: this.seed.channelId ?? "", apiKey: this.seed.apiKey ?? "" };
    }
    return {
      channelId: typeof saved.channelId === "string" ? saved.channelId : "",
      apiKey: typeof saved.apiKey === "string" ? saved.apiKey : "",
    };
  }

  private write(saved: Saved): void {
    this.saved = saved;
    // Its own namespace, not core's: the registry rewrites the whole `core`
    // namespace every time she switches a module on or off.
    this.options.store.write(this.name, { ...saved });
    this.options.log.info(
      `youtube: channel ${saved.channelId || "(none)"}, API key ${saved.apiKey ? "set" : "not set"}`,
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
