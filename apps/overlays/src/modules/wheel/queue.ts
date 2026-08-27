/**
 * What the overlay says about spins that are paid for and waiting.
 *
 * Pure, and it takes the three primitives it needs rather than the queue
 * itself, for the same reason the spin effects take `startedAt` instead of the
 * spin: a patch replaces the whole wheel slice, so the array is a new object
 * every time the state moves at all.
 */

/** Long enough for a real name, short enough not to push a card across her
 * camera. The full name is on her control page. */
const NAME_LIMIT = 18;

export interface QueueNote {
  title: string;
  detail: string;
}

/**
 * `hasChallenges` is here because it is the one way the queue stalls: the
 * server drains it the moment the wheel is free, so a waiting spin normally
 * lasts the length of the spin in front of it. An empty challenge list stops
 * the drain indefinitely, and then someone has paid, nothing is happening, and
 * the overlay is the only place either of them would find out.
 */
export function queueNote(count: number, nextBy: string, hasChallenges: boolean): QueueNote | null {
  if (count < 1) return null;
  return {
    title: count === 1 ? "1 spin queued" : `${count} spins queued`,
    detail: hasChallenges ? `${shorten(nextBy)} is next` : "nothing on the wheel yet",
  };
}

function shorten(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length <= NAME_LIMIT) return trimmed;
  return `${trimmed.slice(0, NAME_LIMIT - 1).trimEnd()}…`;
}
