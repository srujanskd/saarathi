import {
  GOAL_SOURCES,
  MAX_GOAL_LABEL,
  isPolled,
  type Goal,
  type GoalSource,
} from "@saarathi/shared";

/**
 * The goal rules: what a number does to a goal, and when a goal has landed.
 *
 * Pure, and separate from the module for the reason `wheel/rules.ts` is: every
 * decision here is one a test can make without a kernel, a clock or a socket,
 * and the three that matter -- a count crossing a target, a completion firing
 * exactly once, a number that goes back down -- are the ones worth being sure
 * about before she is live.
 */

/** What a poll had to say about one goal. */
export interface Reading {
  /** The polled count, or undefined for a tallied source and for no answer. */
  count?: number;
  /** The stream those counts belong to. See `ChannelStats.stream`. */
  stream?: string;
  now: number;
}

/** A goal after a poll: re-armed if the stream turned over, then settled. */
export function pollGoal(goal: Goal, reading: Reading): Goal {
  const armed = forStream(goal, reading.stream);
  const polled = isPolled(goal.source);
  // A tallied goal owns its own count and a poll may not touch it. A polled one
  // takes whatever the last poll said, `undefined` included: a count that has
  // gone away is not a count of zero.
  const current = polled ? (reading.count ?? null) : armed.current;
  return settle(armed, current, reading.now);
}

/** A goal after something happened that it counts: a member, a tip, her thumb. */
export function tallyGoal(goal: Goal, amount: number, now: number): Goal {
  // Never below zero. She corrects an over-count with a negative bump, and a
  // goal reading -2 is a bar with nothing to draw.
  const current = Math.max(0, (goal.current ?? 0) + amount);
  return settle(goal, current, now);
}

/** A goal she has put back to the start. Her way out of a completion. */
export function resetGoal(goal: Goal, stream: string | undefined): Goal {
  return {
    ...goal,
    current: startingCount(goal),
    completedAt: null,
    streamKey: stream ?? goal.streamKey,
  };
}

/**
 * What a goal reads before anything has happened to it.
 *
 * A polled goal knows nothing until the next poll, a second away, and null is
 * what nothing means. A tallied one starts at a zero that is a fact: no members
 * have joined this stream yet, and saying "—" about a number we are certain of
 * is its own kind of wrong.
 */
export function startingCount(goal: Goal): number | null {
  return isPolled(goal.source) ? null : 0;
}

/**
 * Whether a goal has landed, and the stamp that makes it land only once.
 *
 * `completedAt` sticks. Likes go down -- someone un-likes, or the video is
 * pulled -- and a completion that un-fired and re-fired on the way past the
 * target would put the same alert on her stream three times in a minute. The
 * ways back to nothing are both deliberate: she resets the goal, or the next
 * stream starts.
 */
function settle(goal: Goal, current: number | null, now: number): Goal {
  const landed = current !== null && current >= goal.target;
  return {
    ...goal,
    current,
    completedAt: goal.completedAt ?? (landed ? now : null),
  };
}

/**
 * A stream-scoped goal, against the stream running now.
 *
 * Only a token that exists and differs re-arms it. No token at all means the
 * adapter is not on a stream -- she has not gone live, or YouTube did not
 * answer this minute -- and treating that as a new stream would wipe the goal
 * she is halfway through every time her Wi-Fi hiccuped. A goal that has never
 * seen a stream adopts the first one it sees without resetting, so the reps
 * she counted in the ten minutes before going live still count.
 */
function forStream(goal: Goal, stream: string | undefined): Goal {
  if (goal.scope !== "stream" || stream === undefined || stream === goal.streamKey) return goal;
  if (goal.streamKey === null) return { ...goal, streamKey: stream };
  return { ...goal, current: startingCount(goal), completedAt: null, streamKey: stream };
}

/** The fields the functions above write. Everything else is hers and static. */
export function sameGoals(a: readonly Goal[], b: readonly Goal[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index]!;
    return (
      left.id === right.id &&
      left.current === right.current &&
      left.completedAt === right.completedAt &&
      left.streamKey === right.streamKey
    );
  });
}

export type Made = { ok: true; goal: Goal } | { ok: false; reason: string };

/**
 * A goal out of the arguments her control page sent, or one sentence saying
 * what is wrong with them. Every refusal is in her words: this is the only
 * validation between her thumb and the state file.
 */
export function makeGoal(args: string[], id: string): Made {
  const label = (args[0] ?? "").trim().slice(0, MAX_GOAL_LABEL);
  if (!label) return { ok: false, reason: "A goal needs a name" };

  const target = Number((args[1] ?? "").trim());
  if (!Number.isInteger(target) || target < 1) {
    return { ok: false, reason: "A target has to be a whole number, one or more" };
  }

  const source = (args[2] ?? "").trim();
  if (!isSource(source)) return { ok: false, reason: `Nothing counts "${source}"` };

  const scope = (args[3] ?? "").trim();
  if (scope !== "channel" && scope !== "stream") {
    return { ok: false, reason: `A goal is for the channel or for one stream, not "${scope}"` };
  }

  const goal: Goal = {
    id,
    label,
    target,
    source,
    scope,
    current: null,
    completedAt: null,
    streamKey: null,
    scene: (args[4] ?? "").trim(),
  };
  return { ok: true, goal: { ...goal, current: startingCount(goal) } };
}

function isSource(name: string): name is GoalSource {
  return Object.hasOwn(GOAL_SOURCES, name);
}
