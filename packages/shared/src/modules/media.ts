import { PAID_TIERS } from "../events.js";

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
/** And this much longer per size above the smallest: a bigger one is worth more of the screen. */
export const PAID_ALERT_TIER_MS = 1_000;

/**
 * Roughly where each of the platform's rungs starts, in her currency. For her
 * to recognise a rung by, on her card and in a preview: nothing is ranked by
 * it, the rung itself already came off the platform. Typed to `PAID_TIERS`, so
 * a longer ladder fails to build here instead of previewing a blank amount.
 */
export const PAID_TIER_SAMPLES = ["₹40", "₹80", "₹160", "₹400", "₹800", "₹2,000", "₹5,000"] as const satisfies
  readonly string[] & { length: typeof PAID_TIERS };

/**
 * One of her paid-alert levels. Her levels split the platform's rungs into as
 * many groups as she wants, up to one each: a level runs from its own `from`
 * up to the rung before the next level's, so every rung lands on exactly one
 * and none can be left out. The first always starts at 1, and a paid event
 * with no rung lands there too.
 */
export interface AlertLevel {
  /** The smallest rung on this level, 1 to `PAID_TIERS`. */
  from: number;
  /** A library clip played before the alert, then the alert and its speech. */
  introId?: string;
}

/**
 * How a paid alert looks. Hers to pick from the card, because only she knows
 * what sits well over her camera and her scene.
 */
export const ALERT_THEMES = {
  card: { label: "Card" },
  bold: { label: "Bold" },
  minimal: { label: "Minimal" },
} as const;
export type AlertTheme = keyof typeof ALERT_THEMES;

/** Where it lands. Six, laid out on her card the way they sit on the screen. */
export const ALERT_POSITIONS = {
  "top-left": { label: "Top left" },
  top: { label: "Top" },
  "top-right": { label: "Top right" },
  "bottom-left": { label: "Bottom left" },
  bottom: { label: "Bottom" },
  "bottom-right": { label: "Bottom right" },
} as const;
export type AlertPosition = keyof typeof ALERT_POSITIONS;

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
  /**
   * A made-up paid message she asked to see while placing the alert. Carried
   * on the cue rather than queued, because it is nobody's money: nothing reads
   * it aloud, saves it or thanks anyone for it.
   */
  sample?: PaidMessage;
  /**
   * Set while this cue is a level's intro clip, to the paid message (or the
   * sample) it comes before. No alert is drawn over an intro: the alert is the
   * cue that follows it.
   */
  introFor?: string;
  /** Her level the alert is on, 1 to the number she has, for her card. */
  level?: number;
  /**
   * How big the alert is drawn, 1 to `PAID_TIERS`: her levels spread over the
   * sizes the overlay has, so her top level always gets the biggest. Worked
   * out when the cue starts, so a reload mid-alert draws the same one.
   */
  size?: number;
  startedAt: number;
  endsAt: number;
}

/**
 * The voices a paid message can be read in, named for a character rather than
 * a gender. Whatever picks one is guessing from a username, and it is told not
 * to guess a gender: a wrong one is said out loud on her stream.
 */
export const SPEECH_VOICES = {
  announcer: { label: "Announcer", description: "deep, slow and grand" },
  buddy: { label: "Buddy", description: "friendly, relaxed and quick" },
  warm: { label: "Warm", description: "gentle and kind" },
  bright: { label: "Bright", description: "lively and upbeat" },
} as const;
export type SpeechVoiceId = keyof typeof SPEECH_VOICES;

/**
 * How one message is delivered, on top of the voice. Speed and pitch only:
 * neither Kannada neural voice nor the built-in ones have real emotion styles.
 */
export const SPEECH_MOODS = {
  neutral: { label: "Neutral" },
  excited: { label: "Excited" },
  calm: { label: "Calm" },
  heartfelt: { label: "Heartfelt" },
} as const;
export type SpeechMood = keyof typeof SPEECH_MOODS;

export interface SpeechStyle {
  voice: SpeechVoiceId;
  mood: SpeechMood;
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
  /** 1 to `PAID_TIERS`, from the event. Absent is the smallest. */
  tier?: number;
  /** Why the whole message was left out, for her card. Never on stream. */
  cut?: string;
  /** She let it through while checking messages first. */
  approved?: true;
  /**
   * How it was chosen to sound. Saved with the message, so a read cut off by a
   * clip or a restart sounds the same the second time. Absent means the
   * default voice.
   */
  style?: SpeechStyle;
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
  /** Ask Claude Code on the server to pick each message's voice and mood. */
  pickVoices: boolean;
  /** What the voice picker last did, in a sentence. Not persisted. */
  pickerStatus: string;
  /** How many viewers have a remembered voice. The list itself stays on the server. */
  rememberedVoices: number;
  alertTheme: AlertTheme;
  alertPosition: AlertPosition;
  /** Her levels, smallest first. One per rung until she groups them. */
  alertLevels: AlertLevel[];
}
