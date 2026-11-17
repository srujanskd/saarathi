import { PAID_TIERS, knownTier, type AlertLevel } from "@saarathi/shared";

/** One level per rung: what she has until she groups them. */
export const defaultLevels = (): AlertLevel[] => Array.from({ length: PAID_TIERS }, (_, index) => ({ from: index + 1 }));

/**
 * Her levels, or why not, in a sentence for her card.
 *
 * Starting at 1 and climbing strictly is the whole invariant: with it every
 * rung lands on exactly one level, so there is no gap a paid message could
 * fall through and no overlap to break a tie in. An intro has to be a clip in
 * her library now, because a level pointing at nothing would look set on her
 * card and play nothing on stream.
 */
export function parseLevels(raw: unknown, clipIds: ReadonlySet<string>): AlertLevel[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "Keep at least one level";
  if (raw.length > PAID_TIERS) return `Use at most ${PAID_TIERS} levels`;
  const levels: AlertLevel[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) return "Each level needs a starting size";
    const { from, introId } = entry as { from?: unknown; introId?: unknown };
    if (!knownTier(from)) return `Each level starts at a size from 1 to ${PAID_TIERS}`;
    const previous = levels.at(-1);
    if (!previous && from !== 1) return "The first level has to start at the smallest";
    if (previous && from <= previous.from) return "Each level has to start above the one before it";
    if (introId !== undefined && (typeof introId !== "string" || !clipIds.has(introId))) return "That intro clip is gone";
    levels.push({ from, ...(introId === undefined ? {} : { introId }) });
  }
  return levels;
}

/** Which of her levels a rung lands on, 1-based. No rung is the smallest, never a guess. */
export function levelOf(levels: readonly AlertLevel[], tier: number | undefined): number {
  const rung = tier ?? 1;
  let found = 1;
  levels.forEach((level, index) => {
    if (level.from <= rung) found = index + 1;
  });
  return found;
}

/**
 * How big level `level` of `count` is drawn. Spread over every size the
 * overlay has rather than reusing the rung, so five levels still end on the
 * biggest alert with the burst, and two levels are as far apart as they can be.
 */
export function sizeOf(level: number, count: number): number {
  if (count <= 1) return 1;
  return Math.round(1 + ((level - 1) * (PAID_TIERS - 1)) / (count - 1));
}

/**
 * Levels saved by an earlier run, checked like any she saves now. An intro
 * whose clip went missing is dropped from its level and the level kept;
 * levels that make no sense at all go back to one per rung, because a paid
 * message has to land somewhere.
 */
export function restoreLevels(saved: unknown, clipIds: ReadonlySet<string>): AlertLevel[] {
  const kept = Array.isArray(saved)
    ? (saved as unknown[]).map((level) => {
      if (typeof level !== "object" || level === null) return level;
      const { introId, ...rest } = level as { introId?: unknown };
      return typeof introId === "string" && clipIds.has(introId) ? { ...rest, introId } : rest;
    })
    : saved;
  const levels = parseLevels(kept, clipIds);
  return typeof levels === "string" ? defaultLevels() : levels;
}
