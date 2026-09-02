import {
  WRITES_ID,
  type ChatWriteActions,
  type ChatWritesView,
  type InvokeResult,
  type Logger,
} from "@saarathi/shared";
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
 * Trailing: each new reply on the key restarts the wait, so a burst that is
 * still arriving is one message, not one message plus a straggler five seconds
 * later. A leading send would double the writes for the single burst this
 * exists to make cheap, and five seconds of a bot being slow is not a thing
 * chat notices.
 */
export const REPLY_WINDOW_MS = 5_000;

/**
 * How long a message may be.
 *
 * A tunable with a conservative default, not a spec: live chat hosts document
 * no cap, and the 200 everyone repeats is folklore. Nothing decides anything
 * on this number except where a merged line stops.
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
const quotaDayFormat = new Intl.DateTimeFormat("en-CA", {
  timeZone: PACIFIC,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function quotaDay(at: number): string {
  return quotaDayFormat.format(at);
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
   * A command binding for a refusal, the same binding (or action id) for
   * `ctx.say`. Per command rather than globally: "!spin costs 50 gains; you
   * have 10" and a balance belong in different sentences, and one line carrying
   * both is a line nobody reads.
   */
  key: string;
}

/**
 * Everything the bot says or does to chat, and the budget it does it on.
 *
 * The adapter is chosen at the moment of a write and never cached, on the
 * rule `Stats` follows: a stand-in drops out the moment a real adapter is
 * connected, even if that adapter cannot write, because mock chat echoing the
 * bot into her log while a live source is up is test data on her stream. Mock
 * chat is registered on every run, so a cached choice would be the day her
 * real adapter grew a token and nothing noticed. A stand-in writing at all,
 * while nothing real is live, is what makes the whole of this demoable from a
 * keyboard.
 *
 * Replies queue and moderation does not, and that is the shape rather than a
 * stage of it. `remove` and `ban` do not merge with anything, are not one of
 * the tiers, and spend straight against the meter -- past the ceiling if they
 * have to, because a ban is worth eating a 403 for and a reply never is. They
 * also answer, where `say` cannot: nothing else on her phone shows her a
 * message going away, so whether it went is the only thing she wants back.
 */
export class ChatWriter {
  private readonly pending = new Map<string, string[]>();
  private readonly tiers = new Map<string, SayTier>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  /**
   * The narrow view a module gets as `ctx.writes`.
   *
   * Built here rather than in the registry for the reason `ObsAdapter.actions`
   * is: `available` has to be read at the moment of a write, and an object the
   * registry assembled once when the module registered would answer with
   * whatever was true before she signed in.
   */
  readonly actions: ChatWriteActions;

  constructor(
    private readonly adapters: readonly ChatAdapter[],
    private readonly meter: WriteMeter,
    private readonly log: Logger,
    /**
     * Whether a real (non-stand-in) adapter is connected right now.
     *
     * Same shape as `Stats.preferred`: the stand-in is fine until then, and
     * gone the moment one is, even if the live adapter has no grant.
     */
    private readonly realLive: () => boolean = () => false,
    private readonly windowMs: number = REPLY_WINDOW_MS,
  ) {
    const able = () => this.target() !== null;
    this.actions = {
      get available() {
        return able();
      },
      removeMessage: (messageId) => this.remove(messageId),
      banAuthor: (authorId) => this.ban(authorId),
    };
  }

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
      this.restart(reply.key);
      return;
    }

    this.pending.set(reply.key, [reply.text]);
    this.tiers.set(reply.key, reply.tier);
    this.open(reply.key, reply.tier);
  }

  /**
   * Take one message down.
   *
   * Unbudgeted on purpose: `MODERATION_RESERVE` is held back from both reply
   * tiers precisely so this call has somewhere to spend from, and once even
   * that is gone it still attempts. A 403 costs her nothing and refusing
   * locally costs her the one write she actually needed.
   */
  remove(messageId: string): Promise<InvokeResult> {
    return this.act("remove", messageId, (writes) => writes.deleteMessage(messageId));
  }

  /** Ban an account. Same budget, same reasoning, bigger hammer. */
  ban(authorId: string): Promise<InvokeResult> {
    return this.act("ban", authorId, (writes) => writes.ban(authorId));
  }

  /** Drops what is waiting rather than flushing it. See `say`. */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.pending.clear();
    this.tiers.clear();
  }

  private restart(key: string): void {
    const tier = this.tiers.get(key);
    if (tier === undefined) return;
    const prior = this.timers.get(key);
    if (prior) clearTimeout(prior);
    this.open(key, tier);
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
    this.tiers.delete(key);
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
      this.tiers.set(key, tier);
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
   * One moderation write, counted before it is attempted and reported after.
   *
   * The meter moves first because it counts attempts: a call that failed past
   * our own network may well have been charged, and a counter that only counts
   * clean answers undercounts on exactly the afternoon it matters.
   *
   * The refusal is the adapter's own sentence. An adapter throws with words
   * written for her -- that is the same contract `stats` runs on -- so this
   * passes the message through rather than inventing one, and stays a file that
   * does not know YouTube exists.
   */
  private async act(
    what: string,
    subject: string,
    call: (writes: ChatWrites) => Promise<void>,
  ): Promise<InvokeResult> {
    const target = this.target();
    if (!target) {
      return { ok: false, reason: "Nothing is signed in that can do that yet" };
    }

    this.meter.spend(`${what} ${subject}`);
    try {
      await call(target.writes);
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(`writes: ${what} failed — ${reason}`);
      return { ok: false, reason };
    }
  }

  /**
   * The adapter that would write right now.
   *
   * Real adapters first and stand-ins last, exactly as the counts are ranked,
   * and for the same failure: mock chat echoing the bot into her chat log while
   * a live source is up is test data on her stream wearing a smaller hat. A
   * real adapter that is connected but has no grant still shuts the stand-in
   * out: the hole is silence, not a fake line in her log.
   */
  private target(): { name: string; writes: ChatWrites } | null {
    const pool = this.realLive()
      ? this.adapters.filter((adapter) => !adapter.standIn)
      : this.adapters;
    const able = pool.filter((adapter) => adapter.writes);
    const best = able.find((adapter) => !adapter.standIn) ?? able[0];
    return best?.writes ? { name: best.name, writes: best.writes } : null;
  }
}
