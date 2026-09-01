export const MODERATION_ID = "moderation";

/**
 * What a rule looks at.
 *
 * Seven kinds and no eighth without a reason, because every one of them is a
 * thing she has to understand on a card at arm's length. They split into two
 * families: the five that read one message on its own (`words`, `pattern`,
 * `links`, `caps`, `emoji`) and the one that needs a memory of what an author
 * has been doing (`flood`). `scams` is the bundled set nobody has to write --
 * the shapes a giveaway bot arrives in, kept in one rule she can switch off
 * rather than fifty she has to maintain.
 */
export type ModRuleKind = "scams" | "links" | "words" | "pattern" | "flood" | "caps" | "emoji";

/** How her card draws a rule's value, and therefore how the server reads it. */
export type ModRuleInput = "list" | "pattern" | "number" | "none";

export interface ModRuleInfo {
  /** What she reads on the card. */
  label: string;
  /** One line under it, in her words, saying what the rule catches. */
  hint: string;
  input: ModRuleInput;
  /** Label on the value box, for a kind that has one. What the number or the
   * list actually is, rather than the rule's name repeated over its own box. */
  field?: string;
  /** What a fresh install starts with, and what Reset puts back. */
  value: string;
  /** Whether a fresh install starts with it switched on. */
  on: boolean;
  /** Bounds for a `number` rule, so her card and the server agree on refusals. */
  min?: number;
  max?: number;
}

/**
 * One table, both ends, on the rule `GOAL_SOURCES` set.
 *
 * The server decides behaviour from it and her card renders its labels, so an
 * eighth kind is one entry here rather than a switch on each side that can
 * disagree with the other about what she just switched on.
 */
export const MOD_RULES: Record<ModRuleKind, ModRuleInfo> = {
  scams: {
    label: "Scam and giveaway bots",
    hint: "The usual shapes: fake giveaway wins, “message me on WhatsApp”, crypto pitches.",
    input: "none",
    value: "",
    on: true,
  },
  links: {
    label: "Links",
    hint: "Flags a link to anywhere not on this list. Leave it empty to flag every link.",
    input: "list",
    field: "Sites that are fine",
    value: "youtube.com, youtu.be",
    on: true,
  },
  words: {
    label: "Words she does not want",
    hint: "One word or phrase per line, or separated by commas. Not case sensitive.",
    input: "list",
    field: "Words and phrases",
    value: "",
    on: false,
  },
  pattern: {
    label: "A pattern",
    hint: "For when a list will not do it. Regular expression, and it has to be a simple one.",
    input: "pattern",
    field: "Pattern",
    value: "",
    on: false,
  },
  flood: {
    label: "Flooding",
    hint: "How many messages from one person in ten seconds is too many.",
    input: "number",
    field: "Messages in ten seconds",
    value: "6",
    on: true,
    min: 2,
    max: 30,
  },
  caps: {
    label: "SHOUTING",
    hint: "Percentage of a long message in capitals before it counts as shouting.",
    input: "number",
    field: "Percent in capitals",
    value: "70",
    on: true,
    min: 40,
    max: 100,
  },
  emoji: {
    label: "Emoji walls",
    hint: "How many emoji in one message is a wall.",
    input: "number",
    field: "Emoji in one message",
    value: "10",
    on: true,
    min: 3,
    max: 50,
  },
};

/** Every kind, in the order her card lists them. */
export const MOD_RULE_KINDS = Object.keys(MOD_RULES) as ModRuleKind[];

export interface ModRule {
  /**
   * The kind, and also the identity. There is exactly one rule per kind and
   * that is on purpose: two link rules disagreeing about the same message is a
   * queue she cannot reason about, and "which of my four word lists caught
   * this" is a question no card can answer at arm's length. A rule she is done
   * with is switched off, not deleted, so its value is still there when she
   * wants it back -- which is the reverse-state rule applied to a list.
   */
  kind: ModRuleKind;
  enabled: boolean;
  /** Read according to `MOD_RULES[kind].input`. Blank where the kind takes none. */
  value: string;
}

/**
 * One message a rule caught, waiting for her.
 *
 * It carries the text rather than a reference to it, because by the time she
 * looks the message may be gone from her chat log -- that keeps the last fifty
 * events and a bad stream will push this one out long before she taps.
 */
export interface ModFlag {
  /** Ours, not the platform's, so a queue survives an adapter that has no ids. */
  id: string;
  /** Server time it was caught. See `Snapshot.serverNow`. */
  at: number;
  authorId: string;
  authorName: string;
  /** Trimmed to `MAX_FLAG_TEXT`, because this whole list rides in every patch. */
  text: string;
  kind: ModRuleKind;
  /** One line saying what caught it, written for her: "Link to bit.ly". */
  reason: string;
  /**
   * The platform's own id for the message, when the adapter had one.
   *
   * The handle a delete needs, and the reason it is captured now rather than
   * when the write path exists: a queue of flags with no way to name the
   * message they came from is a queue that has to be rebuilt to be useful.
   * Null is normal -- mock chat has no ids, and neither will a tips webhook.
   */
  messageId: string | null;
}

export interface ModerationState {
  rules: ModRule[];
  /** Newest first, capped at `MAX_FLAGS`. */
  flags: ModFlag[];
  /**
   * When each author last spoke, inside the flood window and no longer.
   *
   * Server-only and not persisted: it is her chat's names, it grows with the
   * audience rather than with her settings, no page draws it, and it means
   * nothing thirty seconds later -- let alone after a restart.
   */
  floods: Record<string, number[]>;
  /**
   * How many messages this run has looked at, and how many it caught.
   *
   * Transient, and per run rather than per stream: it is the number that tells
   * her the layer is alive at all, and "nothing caught in 4,000 messages" is
   * the answer she wants when she is wondering whether it is working. A count
   * from last week would say nothing about tonight.
   */
  seen: number;
  caught: number;
}

/**
 * How many flags the queue holds.
 *
 * The list rides whole in every snapshot every subscribed client gets, and in
 * IRL mode one of those is her phone on mobile data. Fifty is also about the
 * point where a queue stops being a queue and becomes a log she will not read:
 * past that the honest thing is that a wave happened, which the counters say
 * better than fifty rows of it.
 */
export const MAX_FLAGS = 50;

/** How much of a flagged message is kept. A row on her phone, not the message. */
export const MAX_FLAG_TEXT = 180;

/**
 * The window a flood is measured over.
 *
 * A constant rather than a second thing she sets: the number she cares about is
 * "how many is too many", and asking her for a window as well doubles the
 * settings to describe the same intuition. Ten seconds is short enough that a
 * chatty regular does not trip it and long enough to catch a bot pasting.
 */
export const FLOOD_WINDOW_MS = 10_000;

/**
 * How long a message has to be before capitals count against it.
 *
 * "OK" and "YES" are not shouting. Without a floor the caps rule flags every
 * one of them in her chat, which is the failure mode that gets a moderation
 * layer switched off on the first night.
 *
 * Caps only, deliberately. It used to gate the emoji rule too, where it could
 * never fire: an emoji is two UTF-16 units, so three of them -- the smallest
 * wall she can ask for -- already pass twelve characters.
 */
export const MIN_SHOUT_LENGTH = 12;

/**
 * The longest pattern she may save, and the most of a message one is run
 * against.
 *
 * Both are about the same hazard from opposite ends. A regular expression she
 * writes is run against text her viewers write, so a pattern with nested
 * quantifiers and a message built to feed it is a server that stops answering
 * while she is live -- and JavaScript has no way to time a match out. What
 * bounds it is refusing the patterns that backtrack catastrophically
 * (`safePattern`) and never handing one an unbounded amount of text.
 */
export const MAX_PATTERN = 120;
export const MAX_PATTERN_INPUT = 300;
