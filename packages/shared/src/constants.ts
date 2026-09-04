export const SERVER_PORT = 4400;

/** Store namespace for the two access capabilities. */
export const ACCESS_ID = "access";

/**
 * The channel currency's display name. It is not final, so it lives here and
 * nowhere else. No string literal anywhere may spell it out.
 */
export const GAINS = {
  singular: "point",
  plural: "points",
} as const;

/**
 * Store namespace the gains ledger persists under, and deliberately not
 * "gains".
 *
 * A module's persisted slice is keyed by its id, and the module that earns and
 * ranks this currency is called "gains" -- so the ledger sitting under that
 * name too meant the first `setState` from the module silently overwrote every
 * balance. Two things owning one key is not a bug you find in a test; it is a
 * bug you find when her chat's balances are gone.
 */
export const LEDGER_ID = "ledger";

/**
 * Store namespace the chat write counter persists under.
 *
 * It survives a restart for the reason a balance does: the thing it protects is
 * a daily allowance from Google, and a counter that starts over every time she
 * restarts the tray is a counter that cannot protect anything.
 */
export const WRITES_ID = "writes";

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

/** Long enough to cough and take a breath, short enough not to lose a sentence. */
export const COUGH_MUTE_MS = 5_000;

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

/**
 * The hotkeys she may put on a button, and the only ones the tray will ever
 * register.
 *
 * A closed list rather than a text box, for the reason there is no free-text
 * argument field on the deck editor: she arranges her grid on her phone, and
 * "press the combination you want" is not a thing a phone can offer. It also
 * means the shell never hands Electron an accelerator string it invented --
 * `globalShortcut.register` throws on a malformed one, and that would be a
 * crash on the one path she has no way to debug.
 *
 * Two families, because they are two different pieces of hardware. The
 * modifier ones are what she presses on the keyboard next to her while OBS has
 * focus. F13-F24 exist on no keyboard, which is exactly why they are here: a
 * $20 macro keypad programmed to send one is a physical deck button that
 * cannot collide with a shortcut in OBS, a browser or Windows itself.
 */
export interface HotkeyChoice {
  /** Electron accelerator syntax, exactly as `globalShortcut` takes it. */
  readonly accelerator: string;
  /** What she reads on the picker and on the button. */
  readonly label: string;
  /** Heading it sits under in the picker. */
  readonly group: string;
}

export const HOTKEYS: readonly HotkeyChoice[] = [
  ...["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"].map((key) => ({
    accelerator: `Control+Alt+${key}`,
    label: `Ctrl+Alt+${key}`,
    group: "Keyboard",
  })),
  ...Array.from({ length: 12 }, (_, index) => index + 13).map((n) => ({
    accelerator: `F${n}`,
    label: `F${n}`,
    group: "Macro keypad",
  })),
];

/** The accelerator a saved button carries, or undefined if it is not one of
 * ours. The server validates with this and the tray registers on it, so a
 * hotkey that is not in the list above cannot reach either. */
export function hotkeyChoice(accelerator: string): HotkeyChoice | undefined {
  return HOTKEYS.find((choice) => choice.accelerator === accelerator);
}

/**
 * How often the core asks each chat adapter for its counts.
 *
 * Measured rather than guessed: a spike against a live stream on Aug 30, 2026
 * watched `likeCount` move twice inside one minute, so a minute is fast enough
 * for a like goal to feel live. It is also the cheap end of the quota -- the
 * YouTube Data API charges 1 unit per call against 10,000 a day, so polling two
 * endpoints this often for an eight hour stream spends under a tenth of it,
 * leaving room for the retries and the dev runs that share the same key.
 *
 * Faster buys very little: subscriber counts round to three significant figures
 * above 1,000, so past that they cannot move more than once every few minutes
 * anyway.
 */
export const STATS_POLL_MS = 60_000;
