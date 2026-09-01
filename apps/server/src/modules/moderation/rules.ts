import {
  FLOOD_WINDOW_MS,
  MAX_FLAG_TEXT,
  MAX_PATTERN,
  MAX_PATTERN_INPUT,
  MIN_SHOUT_LENGTH,
  MOD_RULES,
  MOD_RULE_KINDS,
  type Author,
  type ModRule,
  type ModRuleKind,
} from "@saarathi/shared";

/**
 * The moderation rules: what counts as worth her attention, and what does not.
 *
 * Pure, and separate from the module for the reason `goals/rules.ts` is. Every
 * decision in here is one she will disagree with on some particular message,
 * so every one of them has to be reachable from a test with no kernel, no clock
 * and no chat: the cost of a false positive is her switching the whole layer
 * off on the first night, and the cost of a false negative is a scam link
 * sitting in her chat while she is mid-set and facing away from the screen.
 */

/** What a fresh install starts with, straight off the shared table. */
export function defaultRules(): ModRule[] {
  return MOD_RULE_KINDS.map((kind) => ({
    kind,
    enabled: MOD_RULES[kind].on,
    value: MOD_RULES[kind].value,
  }));
}

/**
 * Her saved rules, reconciled with the kinds this build knows about.
 *
 * The same split `readSaved` makes in the tray, for the same reason: her state
 * outlives a build's list of anything. A kind that no longer exists is dropped
 * rather than carried as something nothing can evaluate, and a kind that has
 * appeared since she last saved arrives switched to its default -- off, for
 * everything that is off by default, because a build that quietly started
 * flagging a new class of message is a queue she did not ask for and cannot
 * explain.
 *
 * Her value survives both ways round. That is the whole point of doing this
 * rather than replacing the list when it does not match.
 */
export function readRules(saved: unknown): ModRule[] {
  const kept = new Map<ModRuleKind, ModRule>();
  if (Array.isArray(saved)) {
    for (const entry of saved as ModRule[]) {
      const kind = entry?.kind;
      if (!kind || !(kind in MOD_RULES) || kept.has(kind)) continue;
      kept.set(kind, {
        kind,
        enabled: Boolean(entry.enabled),
        value: typeof entry.value === "string" ? entry.value : MOD_RULES[kind].value,
      });
    }
  }
  return defaultRules().map((fallback) => kept.get(fallback.kind) ?? fallback);
}

export type RuleEdit = { ok: true; rule: ModRule } | { ok: false; reason: string };

/**
 * One rule out of what her card sent, or one sentence saying what is wrong.
 *
 * Validated here and refused before anything is written, on the rule her
 * channel id follows: a typo may not cost her the setting that was working.
 */
export function makeRule(args: string[]): RuleEdit {
  const kind = (args[0] ?? "").trim() as ModRuleKind;
  const info = MOD_RULES[kind];
  if (!info) return { ok: false, reason: `There is no "${kind}" rule` };

  const enabled = (args[1] ?? "").trim() !== "off";
  const value = (args[2] ?? "").trim();

  if (info.input === "number") {
    // Explicitly, because `Number("")` is 0 and 0 would read as a rule that
    // flags everything. A cleared box is not a threshold.
    if (!value) return { ok: false, reason: `${info.label} needs a number` };
    const n = Number(value);
    const min = info.min ?? 1;
    const max = info.max ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isInteger(n) || n < min || n > max) {
      return { ok: false, reason: `${info.label} takes a whole number from ${min} to ${max}` };
    }
  }

  if (info.input === "pattern" && value) {
    if (value.length > MAX_PATTERN) {
      return { ok: false, reason: `A pattern has to be under ${MAX_PATTERN} characters` };
    }
    if (!safePattern(value)) {
      return {
        ok: false,
        reason: "That pattern could hang the server on a long message. Keep it simple: no + or * after a bracket.",
      };
    }
    if (!compile(value)) return { ok: false, reason: "That is not a pattern I can read" };
  }

  return { ok: true, rule: { kind, enabled, value } };
}

/**
 * Whether a pattern of hers is safe to run against text her viewers write.
 *
 * This is the one place in the repo where input from two different people meets
 * in the same expression, and the failure is bad in a specific way: a pattern
 * like `(a+)+b` against a message of forty a's backtracks for longer than her
 * stream, and JavaScript gives no way to time a match out or to interrupt one.
 * There is no library fix that stays MIT and stays off native code, so what
 * bounds it is refusing the shape that does it.
 *
 * Unbounded quantifiers on a group are the shape: `*`, `+` and `{n,}`. `(abc)?`
 * and `(abc){2}` cannot blow up and stay allowed, because a rule she cannot
 * write is a rule she works around in a worse way.
 */
export function safePattern(source: string): boolean {
  return !/\)\s*(?:[*+]|\{\s*\d*\s*,\s*\}?)/.test(source);
}

function compile(source: string): RegExp | null {
  try {
    return new RegExp(source, "iu");
  } catch {
    // `u` refuses escapes that plain mode tolerates, and hers is likelier to be
    // a stray backslash than a deliberate one. Second chance without it, so a
    // pattern that works everywhere else works here.
    try {
      return new RegExp(source, "i");
    } catch {
      return null;
    }
  }
}

/** A list she typed, by commas or by lines, with the empties dropped. */
export function splitList(value: string): string[] {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * The shapes a scam arrives in, and the words to describe each one to her.
 *
 * Bundled rather than left to her word list, because the whole point of this
 * one is that she does not have to know what this month's giveaway bot says.
 * Two signals where one would over-fire: "invest" on its own is a fitness
 * streamer's chat talking about a gym membership, and "cash" on its own is
 * nothing at all -- so the weak ones only count next to a second signal.
 *
 * Every entry names itself, because "a scam rule caught it" is not something
 * she can check, and this queue only works if she can see why in one line.
 */
const SCAMS: { reason: string; test: RegExp }[] = [
  {
    reason: "Asks people to message an account off-platform",
    test: /\b(?:whats\W?app|telegram|t\.me|wa\.me|signal)\b/i,
  },
  {
    reason: "Fake giveaway win",
    test: /\b(?:you(?:'ve| have)? won|claim (?:your|the) (?:prize|reward)|selected winner|congratulations winner)\b/i,
  },
  {
    reason: "Investment pitch",
    test: /\b(?:forex|crypto|bitcoin|binary option|trading signal)\b.{0,60}\b(?:profit|earn|invest|double|guaranteed|dm)\b/i,
  },
  {
    reason: "Pretends to be her",
    test: /\b(?:i am the real|this is the real|my official|second channel).{0,30}\b(?:channel|account)\b/i,
  },
  {
    reason: "Points at a profile instead of saying anything",
    test: /\b(?:check|see|look at) my (?:profile|bio|about|picture|pfp)\b/i,
  },
];

/** Where a link points, lowercased, for every link in the message. */
export function hostsIn(text: string): string[] {
  const hosts: string[] = [];
  // Bare domains as well as full URLs: a scam does not write the scheme, and
  // "bit.ly/x" is the whole message half the time.
  const links = text.matchAll(
    /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/\S*)?/gi,
  );
  for (const match of links) {
    const host = match[1]?.toLowerCase();
    // A sentence ending in ".so" or a decimal is not a link. Requiring a
    // plausible public suffix costs a "localhost:4400" nobody types in chat.
    if (host && /\.[a-z]{2,}$/.test(host) && !/^\d+(?:\.\d+)+$/.test(host)) hosts.push(host);
  }
  return hosts;
}

/** Whether a host is the allowed one, or something under it. */
function allowed(host: string, allowlist: string[]): boolean {
  return allowlist.some((entry) => host === entry || host.endsWith(`.${entry}`));
}

/** Capitals as a share of the cased letters, which is the only honest
 * denominator: a message in a script with no case is never shouting. */
export function capsRatio(text: string): number {
  const cased = text.match(/\p{Lu}|\p{Ll}/gu) ?? [];
  if (cased.length === 0) return 0;
  const upper = cased.filter((letter) => letter === letter.toUpperCase()).length;
  return Math.round((upper / cased.length) * 100);
}

export function emojiCount(text: string): number {
  return (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
}

/**
 * Her rules, ready to run.
 *
 * Compiled once when she saves rather than once per message: a pattern is
 * recompiled on every line otherwise, and her chat's busiest minute is exactly
 * when that is worst. It is also where an unusable pattern stops -- a rule that
 * would not compile is dropped here and the rest of the layer carries on,
 * because one bad regex may not take moderation down mid-stream.
 */
export interface Compiled {
  scams: boolean;
  links: { on: boolean; allowlist: string[] };
  words: string[];
  pattern: RegExp | null;
  flood: number;
  caps: number;
  emoji: number;
}

export function compileRules(rules: readonly ModRule[]): Compiled {
  const on = (kind: ModRuleKind): ModRule | undefined =>
    rules.find((rule) => rule.kind === kind && rule.enabled);

  const patternRule = on("pattern");
  const linksRule = on("links");
  const number = (kind: ModRuleKind): number => {
    const rule = on(kind);
    return rule ? Number(rule.value) : 0;
  };

  return {
    scams: Boolean(on("scams")),
    links: {
      on: Boolean(linksRule),
      allowlist: linksRule ? splitList(linksRule.value) : [],
    },
    words: splitList(on("words")?.value ?? ""),
    pattern: patternRule?.value ? compile(patternRule.value) : null,
    flood: number("flood"),
    caps: number("caps"),
    emoji: number("emoji"),
  };
}

export interface Hit {
  kind: ModRuleKind;
  reason: string;
}

/**
 * Nobody she trusts is ever flagged.
 *
 * Her own messages and her moderators' are exempt, and not as a courtesy: a mod
 * pasting the link to her Discord to twelve people in a row trips flooding and
 * links at once, and a queue that fills up with her own team is a queue she
 * stops opening. Members are not exempt -- membership is something bought, and
 * a bought account is exactly what a determined scammer uses.
 */
export function exempt(author: Author): boolean {
  return Boolean(author.isStreamer || author.isMod);
}

/**
 * When each author last spoke, for as long as it matters.
 *
 * The one part of the layer with a memory, and it is a value in and a value out
 * rather than something mutated in place: module state is only ever written
 * through `setState`, so this hands back the next history the way the gains
 * roster does, and a test can give it three timestamps and ask what the fourth
 * message looks like.
 */
export type FloodHistory = Record<string, number[]>;

export function noteMessage(
  history: FloodHistory,
  authorId: string,
  at: number,
): { history: FloodHistory; recent: number } {
  const seen = [...(history[authorId] ?? []).filter((was) => at - was < FLOOD_WINDOW_MS), at];
  return { history: { ...history, [authorId]: seen }, recent: seen.length };
}

/**
 * Authors who have gone quiet, forgotten.
 *
 * Called on a timer rather than on every message, and it is not tidiness: this
 * is keyed by viewer, which makes it the one thing here that grows with her
 * audience rather than with her settings, and an eight hour stream would
 * otherwise hold every name that ever spoke. Returns the same object when
 * nothing aged out, so a quiet tick costs no patch and no write.
 */
export function forgetIdle(history: FloodHistory, now: number): FloodHistory {
  const live = Object.entries(history).filter(([, seen]) =>
    seen.some((at) => now - at < FLOOD_WINDOW_MS),
  );
  if (live.length === Object.keys(history).length) return history;
  return Object.fromEntries(live);
}

/**
 * The first rule that catches this message, or nothing.
 *
 * First rather than all of them, in the order she reads them on her card. A
 * flagged message is one row in her queue and one decision -- delete it or
 * leave it -- and "flooding, and shouting, and a link" is three rows about one
 * message that all resolve together. Which rule caught it is the sentence she
 * needs to judge the call, not a complete account of everything wrong with it.
 */
export function inspect(params: {
  text: string;
  rules: Compiled;
  /** This author's message count in the flood window, from `noteMessage`. */
  recent: number;
}): Hit | null {
  const { text, rules, recent } = params;
  const lowered = text.toLowerCase();

  if (rules.scams) {
    for (const scam of SCAMS) {
      if (scam.test.test(text)) return { kind: "scams", reason: scam.reason };
    }
  }

  if (rules.links.on) {
    for (const host of hostsIn(text)) {
      if (!allowed(host, rules.links.allowlist)) {
        return { kind: "links", reason: `Link to ${host}` };
      }
    }
  }

  for (const word of rules.words) {
    if (lowered.includes(word)) return { kind: "words", reason: `Said “${word}”` };
  }

  // Bounded, and this is the reason: the pattern is hers and the text is her
  // viewers', so the only thing standing between a slow pattern and her live
  // stream is how much of the message it ever sees. See `MAX_PATTERN_INPUT`.
  if (rules.pattern?.test(text.slice(0, MAX_PATTERN_INPUT))) {
    return { kind: "pattern", reason: "Matched her pattern" };
  }

  if (rules.flood && recent >= rules.flood) {
    return { kind: "flood", reason: `${recent} messages in ten seconds` };
  }

  // The length floor is the caps rule's alone. It was on both, which read well
  // and did nothing: an emoji is two UTF-16 units, so any message with three of
  // them already clears twelve characters, and three is the lowest wall she can
  // ask for. A floor that cannot fire is a floor that misleads whoever reads it
  // next.
  if (rules.caps && text.length >= MIN_SHOUT_LENGTH) {
    const ratio = capsRatio(text);
    if (ratio >= rules.caps) return { kind: "caps", reason: `${ratio}% capitals` };
  }

  if (rules.emoji) {
    const count = emojiCount(text);
    if (count >= rules.emoji) return { kind: "emoji", reason: `${count} emoji` };
  }

  return null;
}

/** A flagged message cut to a row on her phone. */
export function trimText(text: string): string {
  return text.length <= MAX_FLAG_TEXT ? text : `${text.slice(0, MAX_FLAG_TEXT - 1)}…`;
}
