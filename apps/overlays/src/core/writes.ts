import type { ChatWritesView } from "@saarathi/shared";

/**
 * What the bot has spent writing to chat, in one line, on the card of the
 * adapter doing the writing.
 *
 * Writes, never units. The server counts what it sent because that is the only
 * thing anybody can count -- Google's quota is spent per call and reported
 * nowhere -- so this says "writes" and means it, rather than drawing a bar
 * against a number nothing measured.
 *
 * Blank for every adapter that is not the one writing, which is how one meter
 * ends up on exactly one card without this file learning any adapter's name.
 */
export function writesLine(writes: ChatWritesView, adapter: string): string {
  if (writes.adapter !== adapter) return "";

  const spent = `${writes.used.toLocaleString()} of ${writes.ceiling.toLocaleString()} writes today`;
  // The reserve is what a delete spends and a reply may not, so once that is
  // all that is left the honest thing to tell her is that the bot has gone
  // quiet on purpose -- not to show her a number with room left in it.
  const left = writes.ceiling - writes.used;
  if (left <= writes.reserve) return `${spent} · only moderation can write now`;
  return `${spent} · ${writes.reserve.toLocaleString()} kept back for moderation`;
}
