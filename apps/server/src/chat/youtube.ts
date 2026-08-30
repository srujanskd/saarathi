import type { Author, ChannelStats, Money, StreamEvent } from "@saarathi/shared";
import type { ChatAdapter, ChatSink } from "./adapter.js";
import { collectStats, httpGet, type StatFetch } from "./youtube-stats.js";

export interface YouTubeConfig {
  channelId?: string;
  liveId?: string;
  /**
   * A YouTube Data API key, for the counts only -- chat is read over InnerTube
   * and costs no quota. Public-data path: no OAuth, no consent screen, no
   * billing account. Absent is ordinary, and means no counts.
   *
   * Never compiled in. This repo is public and so is the installer, so a key
   * baked into either is a key anyone can extract and spend.
   */
  apiKey?: string;
}

const RETRY_MS = 60_000;

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
  private stopped = false;
  /**
   * The video she is live on, which `videos.list` needs and which nothing but
   * chat can tell us: YouTube's own `start` event carries it, and she runs on a
   * channel id rather than a video id, so there is nowhere else it comes from.
   * Null while chat is not connected, and likes are honestly absent for exactly
   * that long.
   */
  private videoId: string | null;

  constructor(
    private readonly config: YouTubeConfig,
    /** Injected so every branch of the counts is testable without a key. */
    private readonly get: StatFetch = httpGet,
  ) {
    this.videoId = config.liveId ?? null;
  }

  async start(sink: ChatSink): Promise<void> {
    this.sink = sink;
    this.stopped = false;

    const { LiveChat } = await import("youtube-chat-next");
    const source = this.config.liveId
      ? { liveId: this.config.liveId }
      : { channelId: this.config.channelId! };
    this.chat = new LiveChat(source);

    this.chat.on("start", (liveId: string) => {
      this.videoId = liveId;
      sink.status({ state: "connected", detail: `Reading live chat (video ${liveId})` });
    });

    this.chat.on("end", () => {
      // She went offline. The likes belonged to that video and the next stream
      // starts its own count, so holding on to this id would render one stream's
      // likes on the next one's goal.
      this.videoId = this.config.liveId ?? null;
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

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.chat?.stop?.();
    this.chat = null;
    this.sink = null;
    this.videoId = this.config.liveId ?? null;
  }

  /**
   * The counts, for whoever polls. Two calls, one quota unit each, and neither
   * is required to succeed: the answer carries whichever numbers it got and a
   * sentence about the rest.
   */
  async stats(): Promise<ChannelStats> {
    return collectStats(
      { apiKey: this.config.apiKey, channelId: this.config.channelId, videoId: this.videoId },
      this.get,
    );
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
    if (this.stopped || !this.sink) return;
    this.sink.status({ state: "connecting", detail: "Looking for a live stream..." });
    const ok = await this.chat.start().catch(() => false);
    if (!ok) {
      this.sink.status({
        state: "disconnected",
        detail: `No live stream found. Checking again every ${RETRY_MS / 1000}s.`,
      });
      this.scheduleRetry();
    }
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

  const base = { source: "youtube", author, at: Date.now(), text };

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
