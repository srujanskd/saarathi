import type { PurgeReport } from "@saarathi/shared";

/**
 * The two sentences her queue says about the panic controls.
 *
 * Pure and in their own file for the reason `caption.ts` is: what a countdown
 * reads at arm's length and what a sweep says afterwards are both decisions,
 * both wrong in ways a screenshot will not show, and both reachable from a unit
 * test without a browser.
 */

/**
 * How long lockdown has left, in her words, or blank when it is off.
 *
 * Blank rather than "off" is what the card branches on, so there is one place
 * that decides whether lockdown is on and it is this comparison. Note it takes
 * the server's clock: `lockdownUntil` is server time, and her phone's idea of
 * now is routinely tens of seconds out.
 *
 * Minutes round down. "1m left" with fifty seconds to go is a small lie in the
 * safe direction; "5m left" with four minutes on the clock is the same lie in
 * the direction where she stops watching chat.
 */
export function lockdownLeft(until: number | null, serverNow: number): string {
  if (until === null || until <= serverNow) return "";
  const seconds = Math.ceil((until - serverNow) / 1000);
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m left` : `${seconds}s left`;
}

/**
 * What the last sweep managed.
 *
 * The rows it removed are gone and the rows it could not look untouched, so
 * without this she cannot tell a sweep that worked from a button that did
 * nothing. The two kinds of leftover get a clause each and are never summed,
 * because "3 had no message to remove" is a fact about her platform and
 * "3 were not attempted" is a fact about this app -- and it is the second one
 * that means press it again in a minute. Folding them into one number is how
 * a spent quota comes out reading as a limitation of YouTube.
 */
export function purgeLine(purge: PurgeReport | null): string {
  if (!purge) return "";

  const clauses = [
    purge.removed === 0
      ? ""
      : `Took down ${purge.removed} message${purge.removed === 1 ? "" : "s"}`,
    purge.noId === 0 ? "" : `${purge.noId} came with no message to take down`,
    purge.stopped === 0 ? "" : `${purge.stopped} could not be taken down`,
  ].filter(Boolean);

  return clauses.length === 0 ? "Nothing to take down" : clauses.join(" · ");
}
