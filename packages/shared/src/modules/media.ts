export const MEDIA_ID = "media";
export const MAX_MEDIA_ITEMS = 24;
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
export const MAX_MEDIA_DURATION_MS = 30_000;
export const DEFAULT_IMAGE_DURATION_MS = 5_000;

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
  itemId: string;
  startedAt: number;
  endsAt: number;
}

export interface MediaState {
  items: MediaItem[];
  active: MediaCue | null;
}
