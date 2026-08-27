import type { ActiveSpin, QueuedSpin } from "@saarathi/shared";

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

/** Full names, unlike the overlay card that sits on her camera. */
export function queueSummary(queue: QueuedSpin[], hasChallenges: boolean): string | null {
  if (queue.length === 0) return null;
  if (!hasChallenges) {
    return queue.length === 1
      ? "1 spin waiting, nothing on the wheel yet"
      : `${queue.length} spins waiting, nothing on the wheel yet`;
  }
  const head = queue[0]!.by;
  if (queue.length === 1) return `${head} is next`;
  return `${queue.length} waiting, ${head} is next`;
}
