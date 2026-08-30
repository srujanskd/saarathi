import type { EventType } from "../events.js";

export const GOALS_ID = "goals";

/**
 * Where a goal's number comes from.
 *
 * Two families, and the difference is not cosmetic. `subscribers` and `likes`
 * are *polled*: the number exists whether or not we were watching, so the goal
 * overwrites its own count from whatever the last poll said. The rest are
 * *tallied*: they only ever go up, one at a time, as something happens -- a
 * member joining, a tip landing, her thumb on a deck button -- so the goal owns
 * the count and nothing else may write it.
 */
export type GoalSource = "subscribers" | "likes" | "members" | "tips" | "manual";

/**
 * Whether the number carries across streams.
 *
 * The plan's one distinction between a subscriber goal and a like goal, and it
 * is about what happens on the boundary, not about the maths: a channel goal is
 * done forever once it lands, and a stream goal starts again with the next
 * stream. Everything else about the two is identical.
 */
export type GoalScope = "channel" | "stream";

export interface GoalSourceInfo {
  /** What she reads in the picker. */
  label: string;
  /** The polled count it reads, for a polled source. */
  count?: "subscribers" | "likes";
  /** The event that adds one, for a tallied source. */
  event?: EventType;
  /** True when only she moves it: a deck button, or her control page. */
  manual?: boolean;
}

/**
 * One table, both ends. The server decides behaviour from it and her picker
 * reads its labels, so a sixth source is one entry here rather than a switch on
 * each side that can disagree with the other.
 */
export const GOAL_SOURCES: Record<GoalSource, GoalSourceInfo> = {
  subscribers: { label: "Subscribers", count: "subscribers" },
  likes: { label: "Likes on this stream", count: "likes" },
  members: { label: "New members", event: "new-member" },
  tips: { label: "Tips and Super Chats", event: "paid-event" },
  manual: { label: "Counted by hand", manual: true },
};

export interface Goal {
  /** Stable for the life of the goal, because progress is attached to it. */
  id: string;
  label: string;
  target: number;
  source: GoalSource;
  scope: GoalScope;
  /**
   * Where it has got to, or null when nothing has been counted yet.
   *
   * Null rather than zero, on the rule `ChannelStats` already follows: a bar
   * reading 0 because no poll has landed is indistinguishable from a bar
   * reading 0 because nobody subscribed, and only one of those is true.
   */
  current: number | null;
  /** Server time it landed, or null. This is what makes it fire once. */
  completedAt: number | null;
  /**
   * The stream its progress belongs to, for a stream-scoped goal. Opaque: the
   * only thing anything does with it is notice that it changed.
   */
  streamKey: string | null;
  /** OBS scene to cut to when it lands, or blank for none. */
  scene: string;
}

export interface GoalsState {
  goals: Goal[];
}

/**
 * How many goals she may have.
 *
 * The overlay is a stack of bars over her camera and the list rides in every
 * snapshot every client gets. Past a handful she is hiding herself behind her
 * own goals, which is the same argument that caps the wheel.
 */
export const MAX_GOALS = 6;

/**
 * How long a goal's name may be. It sits on one line of a bar over her camera,
 * beside the numbers, and a name that wraps pushes the bar off the layout.
 */
export const MAX_GOAL_LABEL = 40;

/**
 * How long the overlay celebrates a goal that just landed.
 *
 * Read against `completedAt`, which is server time, so an OBS source that
 * reloads mid-celebration rejoins the celebration already in progress instead
 * of starting a second one -- the same trick `ActiveSpin.startedAt` does.
 */
export const GOAL_ALERT_MS = 12_000;
