import { STATS_POLL_MS, type ChannelStats, type Logger } from "@saarathi/shared";
import type { ChatAdapter } from "../chat/adapter.js";

/** The narrow half of a `ChatAdapter` this file needs. */
export type StatSource = Pick<ChatAdapter, "name" | "stats">;

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

  constructor(
    adapters: StatSource[],
    private readonly log: Logger,
    /** A number moved, so the core slice needs republishing. */
    private readonly onChange: () => void,
    private readonly pollMs: number = STATS_POLL_MS,
  ) {
    this.sources = adapters.filter((adapter) => typeof adapter.stats === "function");
  }

  view(): Record<string, ChannelStats> {
    const copy: Record<string, ChannelStats> = {};
    for (const [name, stats] of Object.entries(this.current)) {
      copy[name] = { counts: { ...stats.counts }, detail: stats.detail };
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
    this.onChange();
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
  }
  return true;
}
