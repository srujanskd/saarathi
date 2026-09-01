import type { ChannelStats } from "@saarathi/shared";

/**
 * The counts, in one line she can read at arm's length.
 *
 * Absent is the normal case, not the error case -- likes belong to a video and
 * there is no video until she goes live -- so a missing number is simply left
 * out rather than rendered as a zero. With neither number there is nothing to
 * say, and the adapter's own sentence underneath says why.
 *
 * Numbers are grouped but never abbreviated. YouTube already rounds a
 * subscriber count to three significant figures above 1,000, and rounding a
 * rounded number a second time -- 37,700 into "38K" -- moves a goal bar by more
 * than the real increments it is measuring.
 */
export function countsLine(stats: ChannelStats | undefined): string {
  if (!stats) return "";
  const parts: string[] = [];
  const { subscribers, likes } = stats.counts;

  if (subscribers !== undefined) {
    parts.push(`${subscribers.toLocaleString()} ${subscribers === 1 ? "subscriber" : "subscribers"}`);
  }
  if (likes !== undefined) {
    parts.push(`${likes.toLocaleString()} ${likes === 1 ? "like" : "likes"}`);
  }
  return parts.join(" · ");
}
