import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_MS,
  MAX_BOARD_NAME,
  MAX_PER_MINUTE,
  STREAK_CAP,
  type BoardRow,
  type GainsAccount,
} from "@saarathi/shared";
import {
  buildBoard,
  earners,
  evict,
  makeGift,
  makeRate,
  noteSeen,
  rollStreak,
  sameBoard,
  streakBonus,
  type Roster,
} from "../../src/modules/gains/rules.js";

function account(over: Partial<GainsAccount> = {}): GainsAccount {
  return { name: "Viewer", lastSeenAt: 0, streak: 1, lastStreamKey: null, ...over };
}

function roster(entries: Record<string, Partial<GainsAccount>>): Roster {
  return Object.fromEntries(
    Object.entries(entries).map(([id, over]) => [id, account({ name: id, ...over })]),
  );
}

describe("who is earning", () => {
  const now = 1_000_000;

  it("pays whoever spoke inside the window", () => {
    const list = roster({
      just: { lastSeenAt: now },
      recent: { lastSeenAt: now - ACTIVE_WINDOW_MS + 1 },
    });
    expect(earners(list, now, ACTIVE_WINDOW_MS).sort()).toEqual(["just", "recent"]);
  });

  it("stops paying at the edge of the window rather than one tick past it", () => {
    const list = roster({ edge: { lastSeenAt: now - ACTIVE_WINDOW_MS } });
    expect(earners(list, now, ACTIVE_WINDOW_MS)).toEqual([]);
  });

  it("does not pay someone who left an hour ago", () => {
    const list = roster({ gone: { lastSeenAt: now - 60 * 60_000 }, here: { lastSeenAt: now } });
    expect(earners(list, now, ACTIVE_WINDOW_MS)).toEqual(["here"]);
  });

  it("pays nobody out of an empty roster", () => {
    expect(earners({}, now, ACTIVE_WINDOW_MS)).toEqual([]);
  });
});

describe("noting a message", () => {
  it("creates a viewer on their first line, with no streak yet", () => {
    expect(noteSeen(undefined, "Asha", 500)).toEqual({
      name: "Asha",
      lastSeenAt: 500,
      streak: 0,
      lastStreamKey: null,
    });
  });

  it("moves the timestamp and keeps the streak", () => {
    const before = account({ name: "Asha", lastSeenAt: 100, streak: 4, lastStreamKey: "s1" });
    expect(noteSeen(before, "Asha", 900)).toEqual({
      name: "Asha",
      lastSeenAt: 900,
      streak: 4,
      lastStreamKey: "s1",
    });
  });

  it("takes the name chat is showing now, since she can change it", () => {
    expect(noteSeen(account({ name: "Old" }), "New", 1).name).toBe("New");
  });

  it("keeps the name it had when the platform gives none", () => {
    expect(noteSeen(account({ name: "Asha" }), "", 1).name).toBe("Asha");
  });
});

describe("streaks", () => {
  it("grows for a viewer whose last stream was the one before this", () => {
    const before = account({ streak: 3, lastStreamKey: "s1" });
    expect(rollStreak(before, "s2", "s1")).toMatchObject({ streak: 4, lastStreamKey: "s2" });
  });

  it("starts over for a viewer who missed a stream", () => {
    const before = account({ streak: 3, lastStreamKey: "s1" });
    expect(rollStreak(before, "s3", "s2")).toMatchObject({ streak: 1, lastStreamKey: "s3" });
  });

  it("starts at one for a viewer nobody has seen before", () => {
    const before = account({ streak: 0, lastStreamKey: null });
    expect(rollStreak(before, "s1", null)).toMatchObject({ streak: 1, lastStreamKey: "s1" });
  });

  it("starts over when this is the first stream the server ever saw", () => {
    // No prior stream to have turned up for, so a viewer who was here in some
    // stream before the restart cannot be credited with a run through it.
    const before = account({ streak: 5, lastStreamKey: "s1" });
    expect(rollStreak(before, "s2", null)).toMatchObject({ streak: 1 });
  });
});

describe("what a streak pays", () => {
  it("scales with her rate, so one number moves the economy", () => {
    expect(streakBonus(3, 10)).toBe(30);
    expect(streakBonus(3, 20)).toBe(60);
  });

  it("caps, because an uncapped run pays a regular the whole ledger", () => {
    expect(streakBonus(STREAK_CAP + 50, 10)).toBe(STREAK_CAP * 10);
  });

  it("pays nothing when she has turned earning off", () => {
    expect(streakBonus(5, 0)).toBe(0);
  });
});

describe("eviction", () => {
  it("leaves a roster under the cap alone, object and all", () => {
    const list = roster({ a: {}, b: {} });
    expect(evict(list, 10)).toBe(list);
  });

  it("keeps the most recently seen and drops the rest", () => {
    const list = roster({
      old: { lastSeenAt: 1 },
      newer: { lastSeenAt: 5 },
      newest: { lastSeenAt: 9 },
    });
    expect(Object.keys(evict(list, 2)).sort()).toEqual(["newer", "newest"]);
  });

  it("cuts to exactly the cap", () => {
    const list = roster(Object.fromEntries([...Array(30)].map((_, i) => [`u${i}`, { lastSeenAt: i }])));
    expect(Object.keys(evict(list, 7))).toHaveLength(7);
  });
});

describe("the board", () => {
  const balances: Record<string, number> = { rich: 900, mid: 500, poor: 10, broke: 0 };
  const balanceOf = (id: string) => balances[id] ?? 0;

  it("ranks by balance, richest first", () => {
    const board = buildBoard(roster({ poor: {}, rich: {}, mid: {} }), balanceOf, 10);
    expect(board.map((row) => row.id)).toEqual(["rich", "mid", "poor"]);
  });

  it("leaves out anyone who has earned nothing", () => {
    const board = buildBoard(roster({ broke: {}, poor: {} }), balanceOf, 10);
    expect(board.map((row) => row.id)).toEqual(["poor"]);
  });

  it("holds only as many rows as fit over her camera", () => {
    const many = roster(Object.fromEntries([...Array(20)].map((_, i) => [`u${i}`, {}])));
    expect(buildBoard(many, () => 5, 10)).toHaveLength(10);
  });

  it("breaks a tie the same way every time, so rows do not swap every minute", () => {
    const tied = roster({ b: { streak: 2 }, a: { streak: 2 }, c: { streak: 9 } });
    const board = buildBoard(tied, () => 100, 10);
    expect(board.map((row) => row.id)).toEqual(["c", "a", "b"]);
  });

  it("carries the streak and the name chat knows them by", () => {
    const board = buildBoard(roster({ rich: { name: "Asha", streak: 4 } }), balanceOf, 10);
    expect(board[0]).toEqual({ id: "rich", name: "Asha", balance: 900, streak: 4 });
  });

  it("trims a name that would push the row off the overlay", () => {
    const long = "x".repeat(MAX_BOARD_NAME + 20);
    const board = buildBoard(roster({ rich: { name: long } }), balanceOf, 10);
    expect(board[0]!.name).toHaveLength(MAX_BOARD_NAME);
  });
});

describe("sameBoard", () => {
  const row = (over: Partial<BoardRow> = {}): BoardRow => ({
    id: "a",
    name: "Asha",
    balance: 100,
    streak: 1,
    ...over,
  });

  it("is true for a board nothing moved in", () => {
    expect(sameBoard([row()], [row()])).toBe(true);
    expect(sameBoard([], [])).toBe(true);
  });

  it("notices a balance moving", () => {
    expect(sameBoard([row()], [row({ balance: 101 })])).toBe(false);
  });

  it("notices a streak rolling", () => {
    expect(sameBoard([row()], [row({ streak: 2 })])).toBe(false);
  });

  it("notices a rename", () => {
    expect(sameBoard([row()], [row({ name: "Asha B" })])).toBe(false);
  });

  it("notices two viewers swapping places on the same balances", () => {
    const a = row({ id: "a" });
    const b = row({ id: "b" });
    expect(sameBoard([a, b], [b, a])).toBe(false);
  });

  it("notices someone joining or leaving the board", () => {
    expect(sameBoard([row()], [row(), row({ id: "b" })])).toBe(false);
  });
});

describe("the rate she types", () => {
  it("takes a whole number", () => {
    expect(makeRate(["25"])).toEqual({ ok: true, perMinute: 25 });
  });

  it("takes zero, which is earning switched off", () => {
    expect(makeRate(["0"])).toEqual({ ok: true, perMinute: 0 });
  });

  it("refuses a negative, a fraction and a word, in her words", () => {
    for (const bad of ["-5", "2.5", "lots", ""]) {
      const result = makeRate([bad]);
      expect(result.ok, bad).toBe(false);
    }
  });

  it("refuses a stray zero rather than handing chat the whole economy", () => {
    const result = makeRate([String(MAX_PER_MINUTE + 1)]);
    expect(result).toEqual({ ok: false, reason: expect.stringContaining(String(MAX_PER_MINUTE)) });
  });
});

describe("what she hands out by hand", () => {
  it("takes a viewer and an amount", () => {
    expect(makeGift(["u1", "50"])).toEqual({ ok: true, id: "u1", amount: 50 });
  });

  it("takes a negative, which is the way back out", () => {
    expect(makeGift(["u1", "-50"])).toEqual({ ok: true, id: "u1", amount: -50 });
  });

  it("refuses a gift of nothing and a gift to nobody", () => {
    expect(makeGift(["u1", "0"]).ok).toBe(false);
    expect(makeGift(["", "50"]).ok).toBe(false);
  });
});
