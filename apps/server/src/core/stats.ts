import {
  STATS_POLL_MS,
  type Cancel,
  type ChannelStats,
  type Logger,
  type StatCounts,
  type StatsView,
} from "@saarathi/shared";
import type { ChatAdapter } from "../chat/adapter.js";

/** The narrow half of a `ChatAdapter` this file needs. */
export type StatSource = Pick<ChatAdapter, "name" | "stats" | "standIn">;

/**
 * The counts, polled.
 *
 * This exists because a count is not an event. `ChatAdapter` is start, stop and
 * a sink to push at, which is the right shape for everything that *happens* --
 * a message, a Super Chat, a member joining. A subscriber count happens at no
 * particular moment: there is only a number that reads differently next time
 * somebody asks. So the core asks, on a timer, and publishes the answers as
 * core state that any module can read like any other source.
 *
 * Nothing here is persisted. A subscriber count from last week rendering on a
 * goal bar is worse than an empty one, because an empty one is visibly empty
 * and a stale one is quietly wrong.
 */
export class Stats {
  private readonly sources: StatSource[];
  private current: Record<string, ChannelStats> = {};
  private timer: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    adapters: StatSource[],
    private readonly log: Logger,
    /** A number moved, so the core slice needs republishing. */
    private readonly publish: () => void,
    private readonly pollMs: number = STATS_POLL_MS,
  ) {
    // Real adapters first, stand-ins last, and that order is what `count` and
    // `stream` below read in. Mock chat is registered on every run and its
    // numbers climb on their own, so without this a goal on her stream would
    // render test data the moment both could answer -- and it would look
    // entirely plausible while doing it.
    this.sources = adapters
      .filter((adapter) => typeof adapter.stats === "function")
      .sort((a, b) => Number(a.standIn ?? false) - Number(b.standIn ?? false));
  }

  /**
   * The read-only half, as a module sees it. One object per kernel rather than
   * one per module: it holds nothing per-module, and `onChange` hands back the
   * cancel that the registry drops on teardown.
   */
  forModules(): StatsView {
    return {
      all: () => this.snapshot(),
      count: (name) => this.count(name),
      stream: () => this.stream(),
      onChange: (fn) => this.onChange(fn),
    };
  }

  /**
   * The sources worth reading, best first.
   *
   * A stand-in drops out entirely the moment a real adapter has answered
   * anything at all, rather than field by field. YouTube with a key but no
   * live video has a subscriber count and no like count, and falling through
   * on that one missing field would put mock chat's invented likes on a bar
   * over her camera -- the same failure the ranking exists to stop, wearing a
   * smaller hat.
   */
  private preferred(): StatSource[] {
    const real = this.sources.some((source) => !source.standIn && this.answered(source.name));
    return real ? this.sources.filter((source) => !source.standIn) : this.sources;
  }

  /**
   * Whether an adapter has told us anything yet.
   *
   * A number or a stream token counts. `detail` alone does not: "no live
   * stream yet" is an adapter saying it has nothing, and an adapter with
   * nothing must not shut out the stand-in that could still move a bar.
   */
  private answered(name: string): boolean {
    const stats = this.current[name];
    if (!stats) return false;
    if (stats.stream !== undefined) return true;
    return Object.values(stats.counts).some((value) => value !== undefined);
  }

  /**
   * The count from the best-placed adapter that has one.
   *
   * "Best-placed" is the order above and nothing cleverer. A count that is
   * absent is skipped rather than treated as zero, so YouTube with no live
   * stream yet does not shadow the stand-in that could have shown her a bar
   * moving.
   */
  count(name: keyof StatCounts): number | undefined {
    for (const source of this.preferred()) {
      const value = this.current[source.name]?.counts[name];
      if (value !== undefined) return value;
    }
    return undefined;
  }

  /** The stream token of the best-placed adapter on one. */
  stream(): string | undefined {
    for (const source of this.preferred()) {
      const token = this.current[source.name]?.stream;
      if (token !== undefined) return token;
    }
    return undefined;
  }

  /** Told when a poll actually moved something, never on a poll that did not. */
  onChange(listener: () => void): Cancel {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** Every adapter's last answer, for the core slice. Not ranked: her status
   * page is the one place that wants to see who said what. */
  snapshot(): Record<string, ChannelStats> {
    const copy: Record<string, ChannelStats> = {};
    for (const [name, stats] of Object.entries(this.current)) {
      copy[name] = { counts: { ...stats.counts }, detail: stats.detail, stream: stats.stream };
    }
    return copy;
  }

  /**
   * Polls once now and then on the interval. Nothing is awaited: a slow or
   * hanging adapter must not delay the kernel's own start, the way a slow OBS
   * handshake is not allowed to delay chat.
   */
  start(): void {
    // No adapter can answer, so there is no clock to run. This is the common
    // case today -- mock chat is the only producer until YouTube grows one.
    if (this.sources.length === 0) return;

    void this.poll();
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    // Her counts are not worth keeping a process alive for on their own.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    const next: Record<string, ChannelStats> = {};

    for (const source of this.sources) {
      try {
        // Narrowed here rather than at the call: the constructor filtered on
        // it, but that is a fact about the array and not about this element.
        const ask = source.stats;
        if (!ask) continue;
        next[source.name] = await ask.call(source);
      } catch (err) {
        // The numbers we had are kept and only the words change. Clearing them
        // would blank her goal bar every time a poll times out and fill it back
        // in a minute later, which reads as a bug in the goal rather than as a
        // network that came and went.
        next[source.name] = {
          counts: this.current[source.name]?.counts ?? {},
          stream: this.current[source.name]?.stream,
          detail: `Could not reach ${source.name} just now. Trying again shortly.`,
        };
        this.log.warn(`stats: ${source.name} poll failed — ${String(err)}`);
      }
    }

    // Republishing costs every connected client a full core slice, which in IRL
    // mode is her phone on mobile data. Subscriber counts move a few times a
    // stream at most, so most polls change nothing and most polls should
    // therefore send nothing.
    if (sameStats(this.current, next)) return;
    this.current = next;
    this.publish();
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (err) {
        // A module that throws on a poll must not stop the next module hearing
        // about it, and must not take the poll timer down with it.
        this.log.warn(`stats: a listener threw — ${String(err)}`);
      }
    }
  }
}

/**
 * Whether two polls said the same thing.
 *
 * Compared field by field rather than by serializing, because a missing count
 * and a count of zero are different states here and JSON is not reliably
 * ordered. `undefined` on both sides is equal: an adapter that still has no
 * live stream has not changed its mind about anything.
 */
export function sameStats(
  a: Record<string, ChannelStats>,
  b: Record<string, ChannelStats>,
): boolean {
  const names = Object.keys(a);
  if (names.length !== Object.keys(b).length) return false;

  for (const name of names) {
    const left = a[name];
    const right = b[name];
    if (!left || !right) return false;
    if (left.detail !== right.detail) return false;
    if (left.counts.subscribers !== right.counts.subscribers) return false;
    if (left.counts.likes !== right.counts.likes) return false;
    // A new stream with identical numbers is still a change: it is what re-arms
    // a stream-scoped goal, and nothing else says so.
    if (left.stream !== right.stream) return false;
  }
  return true;
}
