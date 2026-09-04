import {
  GAINS,
  MAX_BOARD_NAME,
  MAX_PER_MINUTE,
  STREAK_CAP,
  type BoardRow,
  type GainsAccount,
} from "@saarathi/shared";

/**
 * The gains rules: who is earning, what a streak is worth, and who is on the
 * board.
 *
 * Pure, and separate from the module for the reason `goals/rules.ts` is. The
 * three decisions worth being certain about before she is live are all here:
 * who counts as active, whether a viewer came back to consecutive streams or
 * missed one, and whether the board actually moved -- and none of them needs a
 * kernel, a clock or a ledger to be checked.
 */

export type Roster = Record<string, GainsAccount>;

/**
 * Everyone who has spoken recently enough to be paid this minute.
 *
 * "Recently" and not "is watching", deliberately. The chat reader sees people
 * who talk and nobody else, so this is the only honest definition available,
 * and pretending otherwise would pay a number nothing can support.
 */
export function earners(roster: Roster, now: number, windowMs: number): string[] {
  return Object.entries(roster)
    .filter(([, account]) => now - account.lastSeenAt < windowMs)
    .map(([id]) => id);
}

/** A viewer after they said something. Their first message creates them. */
export function noteSeen(account: GainsAccount | undefined, name: string, now: number): GainsAccount {
  return {
    name: name || account?.name || "",
    lastSeenAt: now,
    streak: account?.streak ?? 0,
    lastStreamKey: account?.lastStreamKey ?? null,
  };
}

/**
 * A viewer's streak on their first message of a stream.
 *
 * Three cases and they are the whole feature. Someone whose last stream was the
 * one immediately before this one is on a run, and it grows. Someone who missed
 * a stream starts over at one -- not zero, because they are here now. Someone
 * being seen for the first time ever is also on one, for the same reason.
 *
 * Called only when there *is* a stream token and it is not the one this account
 * was last seen in, so it is idempotent across a stream by construction: the
 * second message of the night finds `lastStreamKey` already equal and never
 * gets here. That is what stops a chatty viewer earning the bonus per line.
 */
export function rollStreak(
  account: GainsAccount,
  streamKey: string,
  priorStreamKey: string | null,
): GainsAccount {
  const consecutive =
    account.lastStreamKey !== null &&
    priorStreamKey !== null &&
    account.lastStreamKey === priorStreamKey;
  return {
    ...account,
    streak: consecutive ? account.streak + 1 : 1,
    lastStreamKey: streamKey,
  };
}

/**
 * What a streak pays when it rolls.
 *
 * A multiple of her own rate, so the one number on her card moves the economy
 * together and there is not a second constant to keep in step with the first.
 */
export function streakBonus(streak: number, perMinute: number): number {
  return Math.max(0, Math.min(streak, STREAK_CAP)) * perMinute;
}

/**
 * The roster, trimmed to the people who have spoken most recently.
 *
 * Persisted state may not grow forever. Least-recently-seen is the right end to
 * cut from: whoever falls off has not said anything in months, is not on the
 * board, and keeps their balance regardless -- that lives in the ledger, which
 * is keyed by viewer and not by whether we still remember their name.
 */
export function evict(roster: Roster, max: number): Roster {
  const ids = Object.keys(roster);
  if (ids.length <= max) return roster;
  const keep = ids
    .sort((a, b) => roster[b]!.lastSeenAt - roster[a]!.lastSeenAt)
    .slice(0, max);
  return Object.fromEntries(keep.map((id) => [id, roster[id]!]));
}

/**
 * A name that fits a row.
 *
 * Cut with an ellipsis rather than silently, because the overlay's own
 * `text-overflow` only fires when the row is too narrow -- a name cut here
 * arrives on her card and on the board looking like a shorter name somebody
 * actually chose, and she has no way to tell the two apart.
 */
function trimName(name: string): string {
  return name.length <= MAX_BOARD_NAME ? name : `${name.slice(0, MAX_BOARD_NAME - 1)}…`;
}

/**
 * The board: the richest few, in order.
 *
 * Balances come from the ledger rather than the roster, because the ledger is
 * the one place a balance is true -- the gate debits it on every paid command
 * without this module hearing about it. Nobody at zero is listed: a board of
 * people who have earned nothing is a list of names, not a ranking.
 */
export function buildBoard(
  roster: Roster,
  balanceOf: (id: string) => number,
  size: number,
): BoardRow[] {
  return Object.entries(roster)
    .map(([id, account]) => ({
      id,
      name: trimName(account.name),
      balance: balanceOf(id),
      streak: account.streak,
    }))
    .filter((row) => row.balance > 0)
    // Ties broken all the way down to the id, so two viewers on the same
    // balance do not swap places every minute on an overlay over her camera.
    .sort(
      (a, b) =>
        b.balance - a.balance || b.streak - a.streak || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    )
    .slice(0, size);
}

/**
 * Whether the board is the one already published.
 *
 * Mirrors `sameGoals`, for the same reason: the tick runs once a minute whether
 * or not anything moved, and a patch a minute that says what the last one said
 * is her phone's data plan in IRL mode.
 */
export function sameBoard(a: readonly BoardRow[], b: readonly BoardRow[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index]!;
    return (
      left.id === right.id &&
      left.name === right.name &&
      left.balance === right.balance &&
      left.streak === right.streak
    );
  });
}

export type Rate = { ok: true; perMinute: number } | { ok: false; reason: string };

/** The earn rate out of what her card sent, or one sentence saying what is
 * wrong with it. Zero is allowed and means the economy is off. */
export function makeRate(args: string[]): Rate {
  const typed = (args[0] ?? "").trim();
  // Explicitly, because `Number("")` is 0 and 0 is a legal rate: a cleared box
  // and a deliberate zero are different things, and only one of them means she
  // wants earning switched off.
  if (!typed) {
    return { ok: false, reason: `A rate is a whole number of ${GAINS.plural} a minute` };
  }
  const perMinute = Number(typed);
  if (!Number.isInteger(perMinute) || perMinute < 0) {
    return {
      ok: false,
      reason: `A rate is a whole number of ${GAINS.plural} a minute, zero or more`,
    };
  }
  if (perMinute > MAX_PER_MINUTE) {
    return { ok: false, reason: `${MAX_PER_MINUTE} a minute is as high as this goes` };
  }
  return { ok: true, perMinute };
}

export type Gift = { ok: true; id: string; amount: number } | { ok: false; reason: string };

/** A hand-out, or a hand-back. Her way in and her way out of one balance. */
export function makeGift(args: string[]): Gift {
  const id = (args[0] ?? "").trim();
  if (!id) return { ok: false, reason: "Pick someone first" };
  const amount = Number((args[1] ?? "").trim());
  if (!Number.isInteger(amount) || amount === 0) {
    return { ok: false, reason: "Give a whole number, or a negative one to take it back" };
  }
  return { ok: true, id, amount };
}
