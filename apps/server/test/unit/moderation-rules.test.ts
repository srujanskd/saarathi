import { describe, expect, it } from "vitest";
import {
  FLOOD_WINDOW_MS,
  MAX_FLAG_TEXT,
  MAX_PATTERN,
  MIN_SHOUT_LENGTH,
  MOD_RULES,
  MOD_RULE_KINDS,
  type Author,
  type ModRule,
  type ModRuleKind,
} from "@saarathi/shared";
import {
  capsRatio,
  compileRules,
  defaultRules,
  emojiCount,
  exempt,
  forgetIdle,
  hostsIn,
  inspect,
  makeRule,
  noteMessage,
  readRules,
  safePattern,
  splitList,
  trimText,
  type FloodHistory,
} from "../../src/modules/moderation/rules.js";

/** Her rules with one kind overridden, since most tests care about one. */
function rules(over: Partial<Record<ModRuleKind, Partial<ModRule>>> = {}) {
  return compileRules(
    defaultRules().map((rule) => ({ ...rule, ...(over[rule.kind] ?? {}) })),
  );
}

/** Only the named kind switched on, so a hit can only have come from it. */
function only(kind: ModRuleKind, value?: string) {
  return compileRules(
    defaultRules().map((rule) => ({
      ...rule,
      enabled: rule.kind === kind,
      ...(rule.kind === kind && value !== undefined ? { value } : {}),
    })),
  );
}

function look(text: string, compiled = rules(), recent = 1) {
  return inspect({ text, rules: compiled, recent });
}

function author(over: Partial<Author> = {}): Author {
  return { id: "u1", name: "Viewer", ...over };
}

describe("defaults", () => {
  it("starts with one rule per kind, off where the table says off", () => {
    const started = defaultRules();
    expect(started.map((rule) => rule.kind)).toEqual(MOD_RULE_KINDS);
    for (const rule of started) {
      expect(rule.enabled).toBe(MOD_RULES[rule.kind].on);
      expect(rule.value).toBe(MOD_RULES[rule.kind].value);
    }
  });

  it("keeps her values and fills in a kind this build has added", () => {
    // What her state file looks like after a build that did not have `emoji`.
    const saved = [
      { kind: "words", enabled: true, value: "bikes" },
      { kind: "caps", enabled: false, value: "55" },
    ];
    const read = readRules(saved);

    expect(read.find((rule) => rule.kind === "words")).toEqual({
      kind: "words",
      enabled: true,
      value: "bikes",
    });
    // Hers, not the default, including the fact that she switched it off.
    expect(read.find((rule) => rule.kind === "caps")).toEqual({
      kind: "caps",
      enabled: false,
      value: "55",
    });
    // And the new one arrives at its default rather than missing.
    expect(read.find((rule) => rule.kind === "emoji")?.value).toBe(MOD_RULES.emoji.value);
    expect(read).toHaveLength(MOD_RULE_KINDS.length);
  });

  it("drops a kind this build no longer knows and never duplicates one", () => {
    const read = readRules([
      { kind: "shadowban", enabled: true, value: "x" },
      { kind: "words", enabled: true, value: "first" },
      { kind: "words", enabled: false, value: "second" },
    ]);
    expect(read.map((rule) => rule.kind)).toEqual(MOD_RULE_KINDS);
    // The first one wins, so a hand-edited file cannot make the later entry
    // silently override what she saw at the top of her card.
    expect(read.find((rule) => rule.kind === "words")?.value).toBe("first");
  });

  it("starts from the defaults when there is nothing saved at all", () => {
    expect(readRules(undefined)).toEqual(defaultRules());
    expect(readRules("not a list")).toEqual(defaultRules());
  });
});

describe("saving a rule", () => {
  it("refuses a kind that does not exist", () => {
    expect(makeRule(["vibes", "on", ""])).toEqual({
      ok: false,
      reason: 'There is no "vibes" rule',
    });
  });

  it("takes a number inside its bounds and refuses one outside", () => {
    expect(makeRule(["caps", "on", "80"])).toEqual({
      ok: true,
      rule: { kind: "caps", enabled: true, value: "80" },
    });
    for (const bad of ["10", "120", "70.5", ""]) {
      expect(makeRule(["caps", "on", bad]).ok).toBe(false);
    }
  });

  it("refuses a threshold of nothing rather than reading it as zero", () => {
    // `Number("")` is 0, and a flood rule of 0 flags every message she gets.
    const saved = makeRule(["flood", "on", ""]);
    expect(saved).toEqual({ ok: false, reason: "Flooding needs a number" });
  });

  it("switches a rule off without asking for a valid value", () => {
    // Off is off. Refusing to switch something off because the box beside it
    // is empty is a rule she cannot turn off.
    expect(makeRule(["words", "off", ""])).toEqual({
      ok: true,
      rule: { kind: "words", enabled: false, value: "" },
    });
    expect(makeRule(["flood", "off", ""])).toEqual({
      ok: true,
      rule: { kind: "flood", enabled: false, value: "" },
    });
  });

  it("refuses a pattern that could hang the server", () => {
    const refused = makeRule(["pattern", "on", "(a+)+b"]);
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.reason).toContain("hang the server");
  });

  it("refuses a pattern that is too long, and one that is not a pattern", () => {
    expect(makeRule(["pattern", "on", "a".repeat(MAX_PATTERN + 1)]).ok).toBe(false);
    expect(makeRule(["pattern", "on", "([unclosed"]).ok).toBe(false);
  });

  it("takes a plain pattern", () => {
    expect(makeRule(["pattern", "on", "free\\s+iphone"])).toEqual({
      ok: true,
      rule: { kind: "pattern", enabled: true, value: "free\\s+iphone" },
    });
  });
});

describe("pattern safety", () => {
  it("refuses an unbounded quantifier on a group", () => {
    for (const bad of ["(a+)+", "(ab)*c", "(x|y){2,}", "(a)+", "(a){3,}"]) {
      expect(safePattern(bad)).toBe(false);
    }
  });

  it("allows the bounded ones, because a rule she cannot write is worse", () => {
    for (const fine of ["(abc)?", "(abc){2}", "(abc){2,3}", "a+b", "[a-z]*x", "(cat|dog)"]) {
      expect(safePattern(fine)).toBe(true);
    }
  });
});

describe("what a message says", () => {
  it("finds a host in a bare domain as well as a full URL", () => {
    expect(hostsIn("go to bit.ly/free now")).toEqual(["bit.ly"]);
    expect(hostsIn("https://www.Example.COM/x?y=1")).toEqual(["example.com"]);
    expect(hostsIn("both youtu.be/abc and evil.tk")).toEqual(["youtu.be", "evil.tk"]);
  });

  it("does not read a sentence or a number as a link", () => {
    expect(hostsIn("i did 12.5 reps...then more")).toEqual([]);
    expect(hostsIn("no links here at all")).toEqual([]);
  });

  it("measures capitals against the cased letters only", () => {
    expect(capsRatio("SHOUTING AT YOU")).toBe(100);
    expect(capsRatio("quiet as anything")).toBe(0);
    // A script with no case is never shouting, whatever the punctuation.
    expect(capsRatio("!!! 12345 !!!")).toBe(0);
  });

  it("counts emoji, not characters", () => {
    expect(emojiCount("💪💪💪 lets go")).toBe(3);
    expect(emojiCount("no emoji here")).toBe(0);
  });

  it("splits a list she typed either way, and drops the gaps", () => {
    expect(splitList("One, two\n THREE ,,\n")).toEqual(["one", "two", "three"]);
    expect(splitList("")).toEqual([]);
  });
});

describe("who is exempt", () => {
  it("never flags her or her mods, and does flag a member", () => {
    expect(exempt(author({ isStreamer: true }))).toBe(true);
    expect(exempt(author({ isMod: true }))).toBe(true);
    // Membership is bought, and a bought account is what a scammer uses.
    expect(exempt(author({ isMember: true }))).toBe(false);
    expect(exempt(author())).toBe(false);
  });
});

describe("catching things", () => {
  it("catches the scam shapes, and names which one", () => {
    expect(look("dm me on whatsapp for the plan")).toMatchObject({ kind: "scams" });
    expect(look("congratulations winner, claim your prize")).toMatchObject({ kind: "scams" });
    expect(look("check my profile for free coaching")).toMatchObject({
      kind: "scams",
      reason: "Points at a profile instead of saying anything",
    });
  });

  it("needs two signals before it calls something an investment pitch", () => {
    // "invest" alone is a fitness chat talking about a gym membership.
    expect(look("i should invest in better shoes", only("scams"))).toBeNull();
    expect(look("crypto trading, guaranteed profit", only("scams"))).toMatchObject({
      kind: "scams",
      reason: "Investment pitch",
    });
  });

  it("flags a link off the allowlist and leaves one on it alone", () => {
    const compiled = only("links", "youtube.com, youtu.be");
    expect(look("watch youtu.be/abc123", compiled)).toBeNull();
    expect(look("see www.youtube.com/watch?v=1", compiled)).toBeNull();
    // A subdomain of an allowed host is allowed; a lookalike is not.
    expect(look("music.youtube.com/x", compiled)).toBeNull();
    expect(look("go to youtube.com.evil.tk/x", compiled)).toMatchObject({
      kind: "links",
      reason: "Link to youtube.com.evil.tk",
    });
    expect(look("bit.ly/free-stuff", compiled)).toMatchObject({ kind: "links" });
  });

  it("flags every link when the allowlist is empty", () => {
    expect(look("youtu.be/abc", only("links", ""))).toMatchObject({ kind: "links" });
  });

  it("matches her word list anywhere, in any case", () => {
    const compiled = only("words", "Sponsor,  giveaway ");
    expect(look("this is a GIVEAWAY", compiled)).toMatchObject({
      kind: "words",
      reason: "Said “giveaway”",
    });
    expect(look("nothing to see", compiled)).toBeNull();
  });

  it("runs her pattern, and only against a bounded amount of text", () => {
    const compiled = only("pattern", "free\\s+iphone");
    expect(look("FREE   iPhone here", compiled)).toMatchObject({ kind: "pattern" });
    // Past the input bound the pattern never sees it. That is the trade the
    // bound exists for: a slow pattern cannot be fed an unbounded message.
    expect(look(`${"a".repeat(400)} free iphone`, compiled)).toBeNull();
  });

  it("flags a flood at the threshold, not before", () => {
    const compiled = only("flood", "6");
    expect(look("hi", compiled, 5)).toBeNull();
    expect(look("hi", compiled, 6)).toMatchObject({
      kind: "flood",
      reason: "6 messages in ten seconds",
    });
  });

  it("leaves a short shout alone, however capital it is", () => {
    // "YES" is not shouting, and this is the rule that decides whether she
    // keeps the whole layer switched on after the first night.
    expect(look("YES", only("caps"))).toBeNull();
    expect(capsRatio("YES")).toBe(100);
    expect("YES".length).toBeLessThan(MIN_SHOUT_LENGTH);
  });

  it("leaves an emoji burst under her threshold alone", () => {
    // Nine, against a wall of ten. The length floor is deliberately not in
    // play here: three emoji would already clear it.
    expect(look("💪".repeat(9), only("emoji"))).toBeNull();
    expect(look("💪".repeat(10), only("emoji"))).toMatchObject({ kind: "emoji" });
  });

  it("flags a long shout and a long emoji wall", () => {
    expect(look("STOP DOING THAT RIGHT NOW", only("caps"))).toMatchObject({ kind: "caps" });
    expect(look(`lets go ${"💪".repeat(10)}`, only("emoji"))).toMatchObject({
      kind: "emoji",
      reason: "10 emoji",
    });
  });

  it("says nothing about an ordinary message", () => {
    expect(look("nice set! how many reps was that?")).toBeNull();
  });

  it("reports one rule per message, the first in her order", () => {
    // Shouting a scam link is one row in her queue and one decision, not three.
    const hit = look("WHATSAPP ME AT bit.ly/x 💪💪💪💪💪💪💪💪💪💪", rules(), 99);
    expect(hit).toMatchObject({ kind: "scams" });
  });

  it("catches nothing at all when every rule is off", () => {
    const off = compileRules(defaultRules().map((rule) => ({ ...rule, enabled: false })));
    expect(look("whatsapp me at bit.ly/x SHOUTING LOUDLY", off, 99)).toBeNull();
  });
});

describe("the flood memory", () => {
  it("counts inside the window and forgets what is older", () => {
    let history: FloodHistory = {};
    let recent = 0;
    for (const at of [0, 1_000, 2_000]) {
      ({ history, recent } = noteMessage(history, "u1", at));
    }
    expect(recent).toBe(3);

    // Past the window, the earlier three are gone and this is message one.
    expect(noteMessage(history, "u1", FLOOD_WINDOW_MS + 2_500).recent).toBe(1);
  });

  it("counts each author separately", () => {
    let history: FloodHistory = {};
    ({ history } = noteMessage(history, "u1", 0));
    ({ history } = noteMessage(history, "u1", 100));
    const { recent } = noteMessage(history, "u2", 200);
    expect(recent).toBe(1);
  });

  it("returns the same object when nobody has gone quiet", () => {
    // Identity, because that is what the module's change gate reads: a tick
    // that allocates a new history writes state and patches for nothing.
    const { history } = noteMessage({}, "u1", 1_000);
    expect(forgetIdle(history, 2_000)).toBe(history);
  });

  it("forgets an author who has stopped talking", () => {
    const noted = noteMessage({}, "u1", 0);
    expect(forgetIdle(noted.history, FLOOD_WINDOW_MS + 1)).toEqual({});
  });
});

describe("what her queue holds", () => {
  it("keeps a short message whole and cuts a long one visibly", () => {
    expect(trimText("short")).toBe("short");
    const long = trimText("x".repeat(MAX_FLAG_TEXT + 50));
    expect(long).toHaveLength(MAX_FLAG_TEXT);
    expect(long.endsWith("…")).toBe(true);
  });
});
