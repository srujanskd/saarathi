export const MEDIA_ID = "media";
export const MAX_MEDIA_ITEMS = 24;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_DURATION_MS = 30_000;
export const DEFAULT_IMAGE_DURATION_MS = 5_000;
/**
 * Paid messages waiting to be read. Bounded because the queue rides in every
 * snapshot and survives a restart, and generous because every row is somebody
 * who paid: a burst past this is skipped with a status line, never silently.
 */
export const MAX_PAID_QUEUE = 50;
/**
 * How long a paid message stays on screen at the least. Speech is usually
 * shorter than reading it is, and a silent one has nothing else to time it by.
 */
export const PAID_ALERT_MS = 6_000;

export const MEDIA_TYPES = {
  "audio/mpeg": { kind: "audio", extension: "mp3" },
  "audio/ogg": { kind: "audio", extension: "ogg" },
  "audio/wav": { kind: "audio", extension: "wav" },
  "image/gif": { kind: "image", extension: "gif" },
  "image/jpeg": { kind: "image", extension: "jpg" },
  "image/png": { kind: "image", extension: "png" },
  "image/webp": { kind: "image", extension: "webp" },
  "video/mp4": { kind: "video", extension: "mp4" },
  "video/webm": { kind: "video", extension: "webm" },
} as const;

export type MediaMime = keyof typeof MEDIA_TYPES;
export type MediaKind = (typeof MEDIA_TYPES)[MediaMime]["kind"];

export interface MediaItem {
  id: string;
  label: string;
  mime: MediaMime;
  kind: MediaKind;
  bytes: number;
  durationMs: number;
  volume: number;
  addedAt: number;
  /** Read capability for this file alone. Safe to put in its media URL. */
  assetKey: string;
}

export interface MediaCue {
  id: string;
  /** Null for a paid message shown without a voice. */
  itemId: string | null;
  /** The paid message on screen, when this cue is one. */
  paidId?: string;
  startedAt: number;
  endsAt: number;
}

/** One paid message, as it will be read: every field already bounded and cleaned. */
export interface PaidMessage {
  id: string;
  /** Server time it arrived. */
  at: number;
  name: string;
  amount: string;
  /** What may be shown and read: links already taken out. */
  text: string;
  /** Why the whole message was left out, for her card. Never on stream. */
  cut?: string;
  /** She let it through while checking messages first. */
  approved?: true;
}

export interface MediaState {
  items: MediaItem[];
  active: MediaCue | null;
  /** Only the preference survives a restart. Speech audio and status do not. */
  ttsEnabled: boolean;
  /**
   * Paid messages not yet read in full, oldest first; the head is the one being
   * read. Durable, because each is somebody who paid: a restart or a clip she
   * pressed mid-sentence reads it again rather than losing it.
   */
  paid: PaidMessage[];
  /**
   * Hold each paid message with words in it until she says Show it or Thanks
   * only. No list catches abuse in every language her chat writes in; she does.
   */
  checkFirst: boolean;
  ttsStatus: string;
  speech: MediaItem | null;
  speechProvider: "system" | "microsoft";
  speechRegion: string;
  hasSpeechKey: boolean;
}
