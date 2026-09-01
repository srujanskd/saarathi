import { WRITES_ID, type ChatWritesView, type Logger } from "@saarathi/shared";
import type { ChatAdapter, ChatWrites } from "../chat/adapter.js";
import type { StateStore } from "./store.js";

/**
 * What one write costs, and the only place this number is allowed to appear.
 *
 * Google publishes 50 units for a write generically and has published nothing
 * per live-chat method since 2019, and no response from the Data API says what
 * it charged or what is left. So this converts a day's quota into a number of
 * writes, once, and never reaches a screen: a units bar built on it would look
 * measured and be a guess. Her page counts writes, which is a fact we own.
 *
 * Reads share the same pool -- the counts poll spends a unit a minute -- which
 * is why the ceiling below is not the whole of it and why running out still
 * arrives as a 403 no local counter predicted.
 */
const WRITE_UNITS = 50;
const DAILY_UNITS = 10_000;

/** Writes a day, before this counter starts refusing on its own. */
export const WRITE_CEILING = Math.floor(DAILY_UNITS / WRITE_UNITS);

/**
 * Writes no reply may spend, whatever tier it is.
 *
 * Moderation is not a tier: a delete is `ChatWrites.deleteMessage` and not
 * something the bot says, so it never queues behind a reply and never competes
 * with one. It spends against this, and at true exhaustion it attempts anyway
 * -- a ban is worth eating a 403 for, and a reply never is. Tens rather than a
 * handful because a bad wave is tens of messages, not one.
 */
export const MODERATION_RESERVE = 50;

/**
 * And the writes refusals stop at, above that reserve.
 *
 * Refusals are the first thing cut because they are the highest-volume and
 * lowest-value writer here: the kernel says something on *every* refused
 * command, and a viewer who typed a command on cooldown finds out by the thing
 * not happening. An answer she asked for -- a balance, a place on the board --
 * outlives it, so it keeps spending after refusals have stopped.
 */
const REFUSAL_HEADROOM = 50;

/**
 * The two kinds of reply, in the order they are cut.
 *
 * There is deliberately no tier above these. A module reaching for chat to
 * announce something is a module routing around its own overlay, which always
 * works and costs no quota, so `ctx.say` is always the lower of the two.
 */
export type SayTier = "refusal" | "info";

/** Writes that have to be left over before a tier may spend one. */
export const SAY_FLOOR: Record<SayTier, number> = {
  refusal: MODERATION_RESERVE + REFUSAL_HEADROOM,
  info: MODERATION_RESERVE,
};

/**
 * How long replies about the same command are held before one message goes out.
 *
 * Trailing only: the window closes and one line goes out, rather than the first
 * asker being answered instantly and everyone behind them merged. A leading
 * send would double the writes for the single burst this exists to make cheap,
 * and five seconds of a bot being slow is not a thing chat notices.
 */
export const REPLY_WINDOW_MS = 5_000;

/**
 * How long a message may be.
 *
 * A tunable with a conservative default, not a spec: YouTube documents no cap
 * on a live chat message and the 200 everyone repeats is folklore. Nothing
 * decides anything on this number except where a merged line stops.
 */
export const MAX_REPLY_CHARS = 200;

/**
 * How many replies about one thing may be waiting at once.
 *
 * Overflow spills, so without a cap a raid on a priced command would queue
 * hundreds of refusals and dribble them out four at a time for the rest of the
 * hour -- a bot answering questions nobody remembers asking, on writes that
 * moderation is about to need. Past this the newest are dropped: her control
 * page still shows every one of them, and chat is already being answered as
 * fast as the budget allows.
 */
export const MAX_PENDING_PER_KEY = 20;

/** Between merged replies. One character, and it survives a phone's font. */
const JOIN = " · ";

const PACIFIC = "America/Los_Angeles";

/**
 * Which quota day a moment belongs to, as Google reckons it.
 *
 * Midnight Pacific, because that is when the quota resets and it is not her
 * midnight -- the same class of mistake as reading a server timestamp on a
 * phone's clock, one dimension over. A formatted day rather than arithmetic on
 * an offset, so the two nights a year the offset changes need no code.
 */
const day = new Intl.DateTimeFormat("en-CA", {
  timeZone: PACIFIC,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function quotaDay(at: number): string {
  return day.format(at);
}

/**
 * One message out of everything waiting on the same command, and what did not
 * fit.
 *
 * Overflow spills to the next window rather than being dropped: the whole point
 * of merging is that a burst is answered, and answering four of eleven people
 * is a bot that looks broken to seven of them. The first item always goes,
 * truncated if it has to be -- a single line longer than the cap would
 * otherwise spill forever and take everything behind it with it.
 */
export function composeReply(
  pending: readonly string[],
  maxChars = MAX_REPLY_CHARS,
): { text: string; rest: string[] } {
  const [first, ...queue] = pending;
  if (first === undefined) return { text: "", rest: [] };

  let text = first.length > maxChars ? `${first.slice(0, maxChars - 1)}…` : first;
  let taken = 0;
  for (const next of queue) {
    const merged = `${text}${JOIN}${next}`;
    if (merged.length > maxChars) break;
    text = merged;
    taken += 1;
  }

  return { text, rest: queue.slice(taken) };
}

/**
 * The daily write counter.
 *
 * It persists, for the reason a balance does: what it protects is an allowance
 * from Google that does not care how many times she restarted the tray. It
 * counts attempts rather than successes, because a write that failed somewhere
 * past our own network may well have been charged, and a counter that only
 * counts what came back clean is one that undercounts exactly when it matters.
 */
export class WriteMeter {
  private today: string;
  private count = 0;

  constructor(
    private readonly store: StateStore,
    private readonly log: Logger,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.today = quotaDay(this.now());
    const saved = store.read(WRITES_ID);
    const savedDay = typeof saved?.day === "string" ? saved.day : undefined;
    const savedCount = typeof saved?.used === "number" ? saved.used : 0;
    // A count from a day that has ended is not this day's count. Kept only when
    // the day matches, which is the whole of the reset: nothing has to run at
    // midnight, so nothing has to have been running at midnight.
    if (savedDay === this.today && Number.isFinite(savedCount)) {
      this.count = Math.max(0, Math.floor(savedCount));
    }
  }

  get used(): number {
    this.rollover();
    return this.count;
  }

  /** Writes left before the ceiling. Never negative: moderation may go past it. */
  get remaining(): number {
    return Math.max(0, WRITE_CEILING - this.used);
  }

  /** Whether a reply of this tier may spend a write right now. */
  allows(tier: SayTier): boolean {
    return this.remaining > SAY_FLOOR[tier];
  }

  /** Records one write, whatever it was for and whether or not it landed. */
  spend(what: string): void {
    this.rollover();
    this.count += 1;
    this.store.write(WRITES_ID, { day: this.today, used: this.count });
    this.log.info(`writes: ${this.count} of ${WRITE_CEILING} today (${what})`);
  }

  view(adapter: string | null): ChatWritesView {
    return {
      adapter,
      used: this.used,
      ceiling: WRITE_CEILING,
      reserve: MODERATION_RESERVE,
    };
  }

  private rollover(): void {
    const current = quotaDay(this.now());
    if (current === this.today) return;
    this.today = current;
    this.count = 0;
    this.store.write(WRITES_ID, { day: this.today, used: 0 });
  }
}

/** One reply waiting to go out, and what it is competing for a write with. */
export interface Reply {
  text: string;
  tier: SayTier;
  /**
   * What this reply is about, and the only thing merged replies have in common.
   *
   * A command binding for a refusal, a module id for `ctx.say`. Per command
   * rather than globally: "!spin costs 50 gains; you have 10" and a balance
   * belong in different sentences, and one line carrying both is a line nobody
   * reads.
   */
  key: string;
}

/**
 * Everything the bot says or does to chat, and the budget it does it on.
 *
 * The adapter is chosen at the moment of a write and never cached, real ones
 * ahead of stand-ins on the rule `Stats` follows: mock chat is registered on
 * every run, so a cached choice would be the day her real adapter grew a token
 * and nothing noticed. A stand-in writing at all is what makes the whole of
 * this demoable from a keyboard.
 *
 * Replies only, and that is the shape rather than a stage of it. A moderation
 * write is `ChatWrites.deleteMessage` or `.ban`: it does not queue, does not
 * merge with anything, is not one of the tiers, and spends straight against the
 * meter -- past the ceiling if it has to, because a ban is worth eating a 403
 * for. It joins this file when the queue grows the buttons that ask for one.
 */
export class ChatWriter {
  private readonly pending = new Map<string, string[]>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly adapters: readonly ChatAdapter[],
    private readonly meter: WriteMeter,
    private readonly log: Logger,
    private readonly windowMs: number = REPLY_WINDOW_MS,
  ) {}

  /** The meter as her page sees it, including who is doing the writing. */
  view(): ChatWritesView {
    return this.meter.view(this.target()?.name ?? null);
  }

  /**
   * Queue a reply for the next window on its key.
   *
   * Never a promise, and never queued for later than the window: `Kernel.say`
   * is additive -- the effect her control page renders has already been emitted
   * by the time this is called -- so a reply that cannot be sent is a reply
   * that was still seen, and holding it for a budget that might free up would
   * put yesterday's refusal in front of chat tomorrow.
   */
  say(reply: Reply): void {
    if (!this.target()) return;

    const queue = this.pending.get(reply.key);
    if (queue) {
      if (queue.length >= MAX_PENDING_PER_KEY) {
        this.log.info(`writes: ${reply.key} has ${queue.length} waiting, dropping this one`);
        return;
      }
      queue.push(reply.text);
      return;
    }

    this.pending.set(reply.key, [reply.text]);
    this.open(reply.key, reply.tier);
  }

  /** Drops what is waiting rather than flushing it. See `say`. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
  }

  private open(key: string, tier: SayTier): void {
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.flush(key, tier);
    }, this.windowMs);
    // A reply is not worth keeping the process alive for, and one waiting on a
    // window must not be what stops the tray from shutting down.
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private async flush(key: string, tier: SayTier): Promise<void> {
    const queue = this.pending.get(key) ?? [];
    this.pending.delete(key);
    if (queue.length === 0) return;

    const target = this.target();
    if (!target) return;

    // Checked here rather than when the reply was queued, because this is the
    // moment the write happens: moderation may have spent the difference in the
    // five seconds since, and it is entitled to.
    if (!this.meter.allows(tier)) {
      this.log.info(`writes: ${queue.length} ${tier} repl(ies) dropped, budget spent`);
      return;
    }

    const { text, rest } = composeReply(queue);
    if (rest.length > 0) {
      // Spilled rather than dropped, and it keeps the tier it arrived with.
      this.pending.set(key, rest);
      this.open(key, tier);
    }

    this.meter.spend(`say ${key}`);
    try {
      await target.writes.say(text);
    } catch (err) {
      this.log.warn(`writes: say failed — ${String(err)}`);
    }
  }

  /**
   * The adapter that would write right now.
   *
   * Real adapters first and stand-ins last, exactly as the counts are ranked,
   * and for the same failure: mock chat echoing the bot into her chat log while
   * YouTube could have posted it for real is test data on her stream wearing a
   * smaller hat.
   */
  private target(): { name: string; writes: ChatWrites } | null {
    const able = this.adapters.filter((adapter) => adapter.writes);
    const best = able.find((adapter) => !adapter.standIn) ?? able[0];
    return best?.writes ? { name: best.name, writes: best.writes } : null;
  }
}
