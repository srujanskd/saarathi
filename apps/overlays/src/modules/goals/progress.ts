import { GOAL_ALERT_MS, type Goal } from "@saarathi/shared";

/**
 * What a goal bar is allowed to say.
 *
 * All of it is arithmetic on numbers the server already decided, because the
 * server is authoritative about whether a goal has landed and this file is
 * about how far along the bar draws. The one idea in here that is not obvious
 * is the step below.
 */

/**
 * The smallest amount a count of this size can actually move.
 *
 * A subscriber count is rounded to three significant figures above 1,000 --
 * "37700" arrives for anything from 37,700 to 37,799 -- so past that the number
 * moves in tens, then hundreds, and the values in between are not numbers
 * anyone will ever be told. Derived from the value rather than hardcoded,
 * because the granularity changes as she grows: she is under 1,000 today, where
 * the count is exact, and this starts mattering months from now.
 */
export function countStep(value: number): number {
  if (value < 1_000) return 1;
  return 10 ** (Math.floor(Math.log10(value)) - 2);
}

/**
 * The step for this goal.
 *
 * Only a subscriber count is rounded. Likes are exact, and so is anything the
 * server tallied itself, so a "3 to go" on one of those is honest.
 */
export function stepFor(goal: Goal): number {
  return goal.source === "subscribers" ? countStep(goal.target) : 1;
}

/**
 * How many more she needs, rounded up to something reachable, or null when
 * there is nothing to say -- no count yet, or already there.
 *
 * "50 to go" on a count that moves in hundreds is a bar that appears to stall
 * one step short and then overshoot. The honest answer is the next value that
 * can actually be reported.
 */
export function toGo(goal: Goal): number | null {
  if (goal.current === null) return null;
  const remaining = goal.target - goal.current;
  if (remaining <= 0) return null;
  const step = stepFor(goal);
  return Math.ceil(remaining / step) * step;
}

/** How full the bar draws, 0 to 1. Nothing counted yet draws empty. */
export function fill(goal: Goal): number {
  if (goal.current === null || goal.target <= 0) return 0;
  return Math.min(1, Math.max(0, goal.current / goal.target));
}

/**
 * Whether this goal landed recently enough to still be celebrating.
 *
 * Worked out from `completedAt` against the server's clock, never from an event
 * the page had to be present for: a browser source that reloads mid-celebration
 * rejoins the one in progress, and one that opens a minute later shows a goal
 * that is simply done.
 */
export function celebrating(goal: Goal, serverNow: number): boolean {
  if (goal.completedAt === null) return false;
  const elapsed = serverNow - goal.completedAt;
  return elapsed >= 0 && elapsed < GOAL_ALERT_MS;
}

/** The count and the target, grouped and never abbreviated -- rounding a
 * rounded number a second time moves the bar by more than the real steps. */
export function countText(goal: Goal): string {
  const current = goal.current === null ? "—" : goal.current.toLocaleString();
  return `${current} / ${goal.target.toLocaleString()}`;
}
