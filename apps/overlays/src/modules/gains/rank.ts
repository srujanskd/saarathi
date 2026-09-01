import { GAINS } from "@saarathi/shared";
import type { BoardRow } from "@saarathi/shared";

/**
 * How a board row reads.
 *
 * Arithmetic and formatting only. The server decided who is on the board and in
 * what order; this file decides what the row says, which is the part that has
 * to fit over her camera and be readable at arm's length from a treadmill.
 */

/**
 * What sits in front of the name.
 *
 * The top three get a medal and everyone else gets their number, because at 1vh
 * over a moving camera a colour difference is not a rank and a medal is.
 */
export function place(index: number): string {
  return ["🥇", "🥈", "🥉"][index] ?? `${index + 1}`;
}

/**
 * A balance, short enough for a row.
 *
 * Thousands are abbreviated because a five-figure balance beside a name pushes
 * the row off the overlay, and nobody reading a leaderboard over a workout
 * needs the last two digits. Under a thousand it is exact, which is where every
 * balance starts and most of them stay.
 */
export function balanceText(balance: number): string {
  if (balance < 1_000) return String(balance);
  const thousands = balance / 1_000;
  // One decimal up to 10k, none past it: "9.4k" and "37k" are both four
  // characters, and "37.2k" is the one that wraps.
  return `${thousands < 10 ? thousands.toFixed(1).replace(/\.0$/, "") : Math.round(thousands)}k`;
}

/**
 * The streak, or nothing.
 *
 * A streak of one is everybody's first stream and says nothing worth a badge;
 * it starts reading as an achievement at two.
 */
export function streakText(streak: number): string | null {
  return streak >= 2 ? `🔥${streak}` : null;
}

/** One line about a row, for the card, where there is room for words. */
export function rowSummary(row: BoardRow): string {
  const streak = row.streak >= 2 ? ` · ${row.streak} streams in a row` : "";
  return `${row.balance.toLocaleString()} ${GAINS.plural}${streak}`;
}
