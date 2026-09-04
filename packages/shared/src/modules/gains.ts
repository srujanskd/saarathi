/**
 * The gains economy: what chat earns, and who has the most.
 *
 * `GAINS_ID` is a durable key and not a display name. It is in her saved deck
 * buttons, in the persisted slice on disk and in the overlay URL she typed into
 * OBS, so it does not follow `GAINS.plural` the day the currency gets a better
 * name. The name she reads comes from `GAINS`; this is the name the data has.
 */
export const GAINS_ID = "gains";

/**
 * One viewer, as the module remembers them.
 *
 * Server-only, every field of it. It is her chat's names and their habits, it
 * grows with her channel, and no page draws it -- pages draw the board below.
 */
export interface GainsAccount {
  /** Display name as chat last showed it, so the board is not a wall of ids. */
  name: string;
  /** Server time of their last message. What "active" is measured against. */
  lastSeenAt: number;
  /** Streams in a row they have turned up for. At least 1 once they are here. */
  streak: number;
  /**
   * The last stream they said anything in. Opaque, like `Goal.streamKey`: the
   * only thing done with it is noticing which stream it is, and whether that
   * is the one before this one.
   */
  lastStreamKey: string | null;
}

/** One row of the board. This is the part that reaches a client. */
export interface BoardRow {
  id: string;
  name: string;
  balance: number;
  streak: number;
}

export interface GainsState {
  /** Server-only. See `GainsAccount`. */
  roster: Record<string, GainsAccount>;
  /** The top few, rebuilt from the roster and the ledger. Published. */
  board: BoardRow[];
  /** What an active minute pays. Hers to change, which is why it is state. */
  perMinute: number;
  /** Server-only. The stream running now, and the one before it: a streak is
   * "turned up for consecutive streams", so both are needed to tell a viewer
   * who came back from one who missed a stream. */
  streamKey: string | null;
  priorStreamKey: string | null;
}

/**
 * How often earnings are paid out.
 *
 * A minute, because the currency is per active minute and paying it in one
 * lump every ten would make a priced command refuse for nine minutes and then
 * work.
 */
export const EARN_TICK_MS = 60_000;

/**
 * How long after a message someone still counts as watching.
 *
 * The chat reader only ever sees people who talk -- there is no lurker list to
 * read -- so "active" has to mean "said something recently". Five minutes is
 * long enough that following along without typing between sets still pays, and
 * short enough that someone who left an hour ago is not still earning.
 */
export const ACTIVE_WINDOW_MS = 5 * 60_000;

/** What an active minute pays before she changes it. */
export const DEFAULT_PER_MINUTE = 10;

/**
 * The most an active minute may pay.
 *
 * Not a safety rail against her, but against a typo: the rate box is a number
 * field on a phone, and a stray zero turning 10 into 100000 is a chat that can
 * buy everything forever, with no way back that does not involve editing the
 * state file by hand.
 */
export const MAX_PER_MINUTE = 1_000;

/**
 * What turning up for consecutive streams is worth, paid once on the first
 * message of the stream.
 *
 * A multiple of her own rate rather than a second number to tune, so the one
 * field on her card moves the whole economy together. Capped because an
 * uncapped streak pays a regular the entire ledger by month three.
 */
export const STREAK_CAP = 10;

/** How many rows the board holds. It sits over her camera. */
export const BOARD_SIZE = 10;

/**
 * How many viewers the module remembers.
 *
 * Persisted state may not grow forever: this file is read and rewritten on
 * every change, and an unbounded roster is a state file that gets slower for
 * the rest of the channel's life. Least-recently-seen falls off, which is the
 * right end -- someone who has not spoken in months is not on the board.
 */
export const MAX_ROSTER = 500;

/** How long a name may be on a board row over her camera. */
export const MAX_BOARD_NAME = 24;

/**
 * How often one viewer may ask the bot for their balance.
 *
 * The answer costs a platform write, so a command with no cooldown lets one
 * person spend the day's allowance by holding Enter. Kept per viewer by the
 * core's command gate, which means somebody else can still ask immediately.
 */
export const GAINS_QUERY_COOLDOWN_MS = 30_000;
