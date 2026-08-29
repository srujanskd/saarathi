export const SERVER_PORT = 4400;

/**
 * The channel currency's display name. It is not final, so it lives here and
 * nowhere else. No string literal anywhere may spell it out.
 */
export const GAINS = {
  singular: "gain",
  plural: "gains",
} as const;

/**
 * OBS's WebSocket server. The port and the fact that it wants a password are
 * OBS's defaults, not ours: it ships disabled, on 4455, with auth required and
 * a random password generated on first run. We read that password out of OBS's
 * own config rather than asking her to copy it, so these are only the fallback
 * for the day the server is not on the same machine as OBS.
 */
export const OBS_ID = "obs";
export const OBS_DEFAULT_HOST = "127.0.0.1";
export const OBS_DEFAULT_PORT = 4455;

/** Flat, like the chat adapter's. She starts OBS after us as often as before. */
export const OBS_RETRY_MS = 5_000;

/** A filtered port never refuses and never opens, so a connect needs its own clock. */
export const OBS_CONNECT_TIMEOUT_MS = 10_000;

/**
 * The same hazard one layer down: a half-open socket answers a request never,
 * not with an error, so a module calling `ctx.obs.setScene` mid-spin would wait
 * for the rest of the stream. Shorter than the connect timeout because by here
 * OBS has already answered once.
 */
export const OBS_CALL_TIMEOUT_MS = 5_000;

/** Namespace her deck persists under. */
export const DECK_ID = "deck";

/**
 * How many buttons her deck holds. Two reasons meet at roughly the same number
 * and this is under both: past two dozen she is scrolling to find a button
 * mid-workout, which is the opposite of what a deck is for, and the whole list
 * rides in every snapshot every client gets -- her phone included, on mobile
 * data, in IRL mode.
 */
export const MAX_DECK_SLOTS = 24;
