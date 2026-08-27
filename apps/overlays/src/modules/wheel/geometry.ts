/**
 * Wheel geometry and spin timing. Pure, so the angle maths and the phase
 * boundaries can both be checked without a browser.
 *
 * Angles are degrees clockwise from twelve o'clock, because that is where the
 * pointer is and it makes "which segment is under the pointer" the same number
 * as the rotation.
 */

import type { ActiveSpin } from "@saarathi/shared";

export const VIEWBOX = 100;
export const CENTRE = VIEWBOX / 2;
export const RADIUS = 46;

/** Covers the point where every wedge meets, which is always a mess. */
export const HUB_RADIUS = 9;

/** How far a label stops short of the rim. */
const LABEL_INSET = 4;

/** Whole turns before it lands, so a six second spin looks like a spin. */
export const TURNS = 5;

/** How long the result stays up after it lands, before the overlay fades out. */
export const HOLD_MS = 8_000;

export type Phase = "hidden" | "spinning" | "landed";

/**
 * How far into the spin we are, in milliseconds.
 *
 * `now` is passed in rather than read from `Date.now()` because it has to be
 * server time: see `Snapshot.serverNow`. The clamp is what stops a client whose
 * clock is ahead of the server from animating backwards; the correction is what
 * stops one that is behind from animating forever.
 *
 * It takes the timestamp rather than the spin so the overlay's effects can
 * depend on that one number instead of on an object the server replaces
 * wholesale every patch.
 */
export function elapsedOf(startedAt: number, now: number): number {
  return Math.max(0, now - startedAt);
}

/**
 * Which of the three things the overlay is doing. `landed` holds the result on
 * screen long enough to read it and start doing it, and `hidden` is both before
 * the first spin and after the hold has run out.
 */
export function phaseOf(spin: ActiveSpin | null, now: number): Phase {
  if (!spin) return "hidden";
  const elapsed = elapsedOf(spin.startedAt, now);
  if (elapsed >= spin.durationMs + HOLD_MS) return "hidden";
  return elapsed >= spin.durationMs ? "landed" : "spinning";
}

export interface Segment {
  index: number;
  /** Already cut to what will fit down the wedge. */
  label: string;
  path: string;
  /** Degrees to the middle of this segment. */
  centre: number;
  /** Puts the text along the wedge, reading outward and never upside down. */
  labelTransform: string;
  labelAnchor: "start" | "end";
  labelX: number;
}

export function segments(challenges: string[]): Segment[] {
  const step = 360 / challenges.length;
  const limit = maxLabelChars(challenges.length);
  return challenges.map((label, index) => {
    const centre = index * step + step / 2;
    return {
      index,
      label: truncate(label, limit),
      centre,
      path:
        challenges.length === 1 ? fullCircle() : wedge(index * step, (index + 1) * step),
      ...placeLabel(centre),
    };
  });
}

/**
 * Labels run down the wedge, from the rim in toward the hub. Across the wedge
 * they collide with their neighbours the moment a challenge is longer than a
 * word.
 *
 * Every label points the same way relative to its own wedge, which means the
 * ones at the bottom of the wheel are upside down. That is the convention
 * every prize wheel uses, and it is the only option here: the labels rotate
 * with the wheel, so no fixed choice can keep them all upright, and
 * counter-rotating ten text nodes every frame is exactly the continuously
 * repainting animation we are not allowed to ship. The answer chat actually
 * reads is the large text under the wheel.
 */
function placeLabel(centre: number): Pick<Segment, "labelTransform" | "labelAnchor" | "labelX"> {
  return {
    labelTransform: `rotate(${centre} ${CENTRE} ${CENTRE}) translate(${CENTRE} ${CENTRE}) rotate(-90)`,
    labelAnchor: "end",
    labelX: RADIUS - LABEL_INSET,
  };
}

/** Shrinks as the wheel gets busier, because the wedge does. */
export function labelFontSize(count: number): number {
  return Math.max(1.5, Math.min(3.9, 42 / count));
}

/**
 * How much text fits between the hub and the rim. Readable at arm's length
 * beats complete: the full challenge is on her control page, and the wheel
 * only has to say which one it is.
 */
export function maxLabelChars(count: number): number {
  const room = RADIUS - LABEL_INSET - HUB_RADIUS;
  return Math.max(6, Math.floor(room / (labelFontSize(count) * 0.53)));
}

function truncate(label: string, limit: number): string {
  return label.length > limit ? `${label.slice(0, limit - 1).trimEnd()}…` : label;
}

/**
 * Wedge colours. Sequential, not random, so the wheel looks the same every
 * spin -- and ordered so no two neighbours share a hue family, which is the
 * whole job. A palette of light/dark pairs fails this: it puts two greens side
 * by side and the wedge boundary disappears.
 */
const PALETTE = [
  "#1f3a5f", // navy
  "#2c7a68", // teal
  "#6d3f6e", // plum
  "#3f5185", // indigo
  "#2f6f4e", // forest
  "#8a4f6d", // mauve
];

export function wedgeColour(index: number, count: number): string {
  // The one case the modulo gets wrong: the last wedge wraps onto the first
  // one's colour and the seam vanishes.
  const wraps = count % PALETTE.length === 1 && index === count - 1;
  return PALETTE[wraps ? 1 : index % PALETTE.length]!;
}

/**
 * Where the wheel has to end up for `index` to sit under the pointer. Always
 * negative-going before the turns are added, so the wheel only ever spins
 * clockwise: a wheel that sometimes goes backwards reads as a bug to chat.
 */
export function targetRotation(index: number, count: number): number {
  const step = 360 / count;
  return TURNS * 360 - (index * step + step / 2);
}

function point(angle: number, radius = RADIUS): [number, number] {
  const radians = (angle * Math.PI) / 180;
  return [CENTRE + radius * Math.sin(radians), CENTRE - radius * Math.cos(radians)];
}

function wedge(from: number, to: number): string {
  const [x1, y1] = point(from);
  const [x2, y2] = point(to);
  const large = to - from > 180 ? 1 : 0;
  return `M ${CENTRE} ${CENTRE} L ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 ${large} 1 ${x2} ${y2} Z`;
}

/** An arc cannot draw 360 degrees, so a one-challenge wheel is two halves. */
function fullCircle(): string {
  const [x1, y1] = point(0);
  const [x2, y2] = point(180);
  return `M ${x1} ${y1} A ${RADIUS} ${RADIUS} 0 1 1 ${x2} ${y2} A ${RADIUS} ${RADIUS} 0 1 1 ${x1} ${y1} Z`;
}
