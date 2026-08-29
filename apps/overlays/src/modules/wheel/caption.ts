import { MAX_CHALLENGES, type ActiveSpin } from "@saarathi/shared";

export type SpinPhase = "idle" | "spinning" | "landed";

export interface SpinCaption {
  phase: SpinPhase;
  label: string;
  by: string;
  /** Whole seconds left on the turn. Only set while spinning. */
  remainingSec?: number;
}

/**
 * What her control page should say about the wheel right now.
 *
 * The overlay hides the result after a hold so it does not sit on her camera.
 * This page does not: the last challenge stays up until she clears it or a
 * new spin replaces it, because she still has to do the thing.
 */
export function spinCaption(spin: ActiveSpin | null, now: number): SpinCaption {
  if (!spin) return { phase: "idle", label: "Nothing on the wheel yet", by: "" };
  const remaining = spin.startedAt + spin.durationMs - now;
  if (remaining > 0) {
    return {
      phase: "spinning",
      label: spin.label,
      by: spin.by,
      remainingSec: Math.ceil(remaining / 1000),
    };
  }
  return { phase: "landed", label: spin.label, by: spin.by };
}

/** The small line above the challenge, so the big text can stay the challenge. */
export function phaseKicker(caption: SpinCaption): string {
  if (caption.phase === "idle") return "Ready";
  if (caption.phase === "spinning") {
    return caption.remainingSec != null ? `Spinning, ${caption.remainingSec}s left` : "Spinning";
  }
  return "Do this";
}

/**
 * The same line as the overlay's `queueNote`, in full names rather than short
 * ones, because this card is on her phone rather than across her camera. It
 * takes the three primitives it needs for the same reason that one does: a
 * patch replaces the whole wheel slice, so the queue array is a new object
 * every time the state moves at all.
 */
export function queueSummary(count: number, nextBy: string, hasChallenges: boolean): string | null {
  if (count < 1) return null;
  if (!hasChallenges) return `${plural(count, "spin", "spins")} waiting, nothing on the wheel yet`;
  if (count === 1) return `${nextBy} is next`;
  return `${count} waiting, ${nextBy} is next`;
}

/** "1 spin", "3 spins". Two lines on this card count things, and hand-rolling
 * the plural in each is how one of them keeps its stray s the day somebody
 * edits the other. */
function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * What the fold says about the size of the list she is editing. It counts the
 * draft rather than the saved list so the cap shows up while she is typing,
 * not only when the server turns the save down.
 *
 * Over the cap it says the refusal itself, word for word, so the fold and the
 * notice are one sentence rather than two descriptions of one rule -- and so a
 * list that was already too big when it loaded explains itself on sight.
 *
 * It reports; it does not decide. The server owns the rule -- the Save button
 * stays live and its refusal is the authority, because a button that silently
 * greys out tells her nothing at arm's length.
 */
export function countLabel(count: number): string {
  if (count > MAX_CHALLENGES) {
    return `A wheel holds ${MAX_CHALLENGES} challenges — that list has ${count}`;
  }
  return plural(count, "challenge", "challenges");
}
