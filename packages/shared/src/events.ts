/**
 * Normalized platform events.
 *
 * Nothing downstream of a chat adapter may branch on `source`. It is a label for
 * logs and the status page, not a decision input. If you find yourself writing
 * `if (ev.source === "youtube")` outside `apps/server/src/chat/`, the adapter is
 * missing a normalization it should be doing.
 */

export type EventType = "chat-message" | "chat-command" | "paid-event" | "new-member";

/** Who sent it, with the only flags any downstream rule is allowed to care about. */
export interface Author {
  /** Stable per-platform id where the adapter can supply one, else the name. */
  id: string;
  name: string;
  isStreamer?: boolean;
  isMod?: boolean;
  isMember?: boolean;
}

/** Money as the platform displayed it, plus a parsed value when we can get one. */
export interface Money {
  display: string;
  value?: number;
  currency?: string;
}

interface EventBase {
  /** Adapter that produced this: "youtube", "mock", "kofi". Display only. */
  source: string;
  author: Author;
  at: number;
  /**
   * The platform's own id for this message, where the adapter has one.
   *
   * The only handle a moderation action has: deleting a message means naming it
   * to the platform, and nothing downstream can reconstruct that from the text.
   * Optional because it is genuinely absent on some sources -- a tips webhook
   * has nothing to name, and YouTube's own library does not always give us one
   * -- and a missing id is a row she cannot act on rather than a bug. Mock
   * chat does hand them out, so that acting on one is demoable without a
   * stream. Opaque everywhere past the adapter: the shape of the id is the
   * adapter's, on the rule `ChannelStats.stream` follows.
   */
  messageId?: string;
}

export interface ChatMessageEvent extends EventBase {
  type: "chat-message";
  text: string;
}

export interface ChatCommandEvent extends EventBase {
  type: "chat-command";
  /** Lowercased, without the leading "!". */
  command: string;
  args: string[];
  text: string;
}

export interface PaidEvent extends EventBase {
  type: "paid-event";
  /** Where the money came from. Modules should treat every kind the same. */
  kind: "superchat" | "sticker" | "tip";
  amount: Money;
  text: string;
}

export interface NewMemberEvent extends EventBase {
  type: "new-member";
  tier?: string;
  text: string;
}

export type StreamEvent = ChatMessageEvent | ChatCommandEvent | PaidEvent | NewMemberEvent;

/** Narrow a StreamEvent by its `type` tag. */
export type EventOf<T extends EventType> = Extract<StreamEvent, { type: T }>;

export interface ConnectionStatus {
  state: "disconnected" | "connecting" | "connected" | "error";
  /** Written for her, not for us: "No live stream found, retrying every 60s". */
  detail: string;
}
