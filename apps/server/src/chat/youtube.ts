import type { Author, Money, StreamEvent } from "@saarathi/shared";
import type { ChatAdapter, ChatSink } from "./adapter.js";

export interface YouTubeConfig {
  channelId?: string;
  liveId?: string;
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

  constructor(private readonly config: YouTubeConfig) {}

  async start(sink: ChatSink): Promise<void> {
    this.sink = sink;
    this.stopped = false;

    const { LiveChat } = await import("youtube-chat-next");
    const source = this.config.liveId
      ? { liveId: this.config.liveId }
      : { channelId: this.config.channelId! };
    this.chat = new LiveChat(source);

    this.chat.on("start", (liveId: string) => {
      sink.status({ state: "connected", detail: `Reading live chat (video ${liveId})` });
    });

    this.chat.on("end", () => {
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
