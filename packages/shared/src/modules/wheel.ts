import type { TriggerVia } from "../module.js";

export const WHEEL_ID = "wheel";

/**
 * A spin in progress or the last one that finished. It lives in state rather
 * than in a one-shot event so an overlay that connects mid-spin can work out
 * how far through the animation it is from `startedAt` and render correctly.
 */
export interface ActiveSpin {
  index: number;
  label: string;
  by: string;
  via: TriggerVia;
  startedAt: number;
  durationMs: number;
  /**
   * The wheel as it was when this spin was drawn, because `index` only means
   * anything against that list.
   *
   * It lives on the spin rather than being read from `challenges` at render
   * time for one reason: she can save a new challenge list mid-spin. If an
   * overlay derived the wedges from the current list, the pointer would land on
   * a wedge that no longer matches `label` -- and a client freezing the list
   * itself would not help, because an overlay that reloads after the edit was
   * never there to freeze the old one. Only the server knows what the wheel
   * looked like when it picked.
   */
  wheel: string[];
}

export interface SpinRecord {
  label: string;
  by: string;
  via: TriggerVia;
  at: number;
}

/**
 * A spin someone already paid for that could not run yet. Free triggers are
 * refused when the wheel is busy; paid ones wait their turn, because a viewer
 * who spent money or gains and got nothing is the one failure mode here that
 * costs her something real.
 */
export interface QueuedSpin {
  by: string;
  via: TriggerVia;
  at: number;
}

export interface WheelState {
  challenges: string[];
  spin: ActiveSpin | null;
  queue: QueuedSpin[];
  history: SpinRecord[];
}

export const SPIN_DURATION_MS = 6_000;
export const SPIN_COOLDOWN_MS = 45_000;
export const MAX_HISTORY = 200;

/**
 * Long enough that nobody's money is turned away in practice, short enough that
 * a superchat spammer cannot commit her to an hour of burpees.
 */
export const MAX_QUEUE = 25;

/**
 * How many challenges a wheel may hold.
 *
 * Two limits meet near here and 24 is under both. On screen, `labelFontSize`
 * bottoms out at 28 wedges and the labels start colliding with their
 * neighbours past that, so a wheel nobody can read is not worth saving. In the
 * payload, `ActiveSpin.wheel` copies the whole list into every snapshot for as
 * long as a spin is live, and she may be on phone data in IRL mode.
 */
export const MAX_CHALLENGES = 24;

export const DEFAULT_CHALLENGES = [
  "20 squats",
  "30s plank",
  "10 push-ups",
  "15 jumping jacks",
  "wall sit — 45s",
  "20 lunges (10 each leg)",
  "30s high knees",
  "chat picks the next song",
  "10 burpees",
  "60s stretch break",
];
