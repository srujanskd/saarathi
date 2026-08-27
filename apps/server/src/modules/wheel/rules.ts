import {
  SPIN_DURATION_MS,
  type ActiveSpin,
  type TriggerVia,
  type WheelState,
} from "@saarathi/shared";

/**
 * How long a finished spin is protected after it lands. The result has to stay
 * on screen long enough to read and do, or a second trigger arriving a beat
 * later would wipe the challenge she was about to attempt.
 */
export const SETTLE_MS = 1_000;

export interface SpinInput {
  by: string;
  via: TriggerVia;
  now: number;
  /** Injected so a test can pin the outcome. */
  random: () => number;
}

export type SpinOutcome = { ok: true; spin: ActiveSpin } | { ok: false; reason: string };

/** Milliseconds until the wheel is free, or 0 if it is free now. */
export function spinBlockedFor(spin: ActiveSpin | null, now: number): number {
  if (!spin) return 0;
  return Math.max(0, spin.startedAt + spin.durationMs + SETTLE_MS - now);
}

/**
 * Spin rules, in full:
 *  - an empty wheel cannot spin
 *  - a spin in progress (plus a moment to read the result) blocks every trigger,
 *    including hers, because two overlapping spins have no meaning on screen
 *
 * Rate limiting is deliberately not here. It belongs to the !spin command
 * binding, so a paid trigger or her own deck button reaches this function
 * without a cooldown to argue with.
 */
export function planSpin(state: WheelState, input: SpinInput): SpinOutcome {
  if (state.challenges.length === 0) {
    return { ok: false, reason: "There is nothing on the wheel yet" };
  }

  if (spinBlockedFor(state.spin, input.now) > 0) {
    return { ok: false, reason: "The wheel is still spinning" };
  }

  const index = Math.floor(input.random() * state.challenges.length);
  return {
    ok: true,
    spin: {
      index,
      label: state.challenges[index]!,
      by: input.by,
      via: input.via,
      startedAt: input.now,
      durationMs: SPIN_DURATION_MS,
      wheel: [...state.challenges],
    },
  };
}
