import type { ChatSignInView, InvokeResult, Logger } from "@saarathi/shared";
import {
  REFRESH_MARGIN_MS,
  pollForToken,
  refreshAccess,
  requestDeviceCode,
  type Access,
  type DeviceCode,
  type FormPost,
  type OAuthClient,
} from "./youtube-oauth.js";

/**
 * How much longer to wait after Google says `slow_down`.
 *
 * Additive rather than doubling: the interval it asked for is already the one
 * it wants, and a backoff that doubles a few times leaves her looking at a code
 * that has been valid for two minutes with nothing happening.
 */
const SLOW_DOWN_MS = 5_000;

export interface GrantOptions {
  /**
   * The credential to sign in with, asked for rather than held.
   *
   * A function because she can change it: her own client wins over the one the
   * build carries, and she pastes hers on the same card this appears on. A
   * value captured at construction would be the one she had before she saved.
   */
  client(): OAuthClient | null;
  post: FormPost;
  log: Logger;
  /** Persist the refresh token, or clear it with a blank string. */
  save(refreshToken: string): void;
  /** Something her page renders changed, and the core slice needs republishing. */
  onChange(): void;
  now?: () => number;
}

/**
 * Her Google sign-in: the one long-lived credential, the short-lived one it
 * buys, and the code she types to get either.
 *
 * A class and not a set of functions because all three of those are state that
 * outlives a call, and exactly one of them is written to disk. The refresh
 * token is persisted, in plaintext, beside the API key and the OBS password and
 * on the same reasoning: the encryption that would mean anything here is
 * Windows DPAPI through Electron's `safeStorage`, this process must never
 * import Electron because it has to run on a VPS the day IRL mode happens, and
 * a key stored next to the thing it encrypts stops nobody. What bounds this one
 * is that it never leaves the server -- the slice carries `granted`, never the
 * token -- never reaches a log or an error string, and is one revoke away in
 * her Google account. It is a bigger credential than the API key, which is why
 * the state file is written 0600 and why AGENTS no longer calls it good test
 * data.
 *
 * The access token is deliberately *not* persisted. It lives an hour, a restart
 * costs one refresh, and writing it down would be a second secret on disk
 * buying nothing.
 *
 * The pending sign-in is not persisted either, and that is the same decision
 * from the other end: a device code that outlives the process is a code she
 * cannot use, attached to a poll nobody is running.
 */
export class YouTubeGrant {
  private refreshToken: string;
  private access: Access | null = null;
  private pending: DeviceCode | null = null;
  private timer: NodeJS.Timeout | null = null;
  /**
   * The refresh in flight, if there is one.
   *
   * Shared rather than one per caller, because the callers arrive together: a
   * sweep of the queue is twenty writes in a row, and twenty simultaneous
   * refreshes of the same token is a way to have Google rate-limit us for
   * pressing one button.
   */
  private refreshing: Promise<string> | null = null;
  /** Why the last sign-in ended without one, for her card to say so. */
  private failure = "";
  private readonly now: () => number;

  constructor(
    private readonly options: GrantOptions,
    savedRefreshToken: string,
  ) {
    this.refreshToken = savedRefreshToken;
    this.now = options.now ?? (() => Date.now());
  }

  /** Whether the bot has a grant to write with at all. */
  get granted(): boolean {
    return this.refreshToken !== "";
  }

  /**
   * The half of the sign-in view this object owns.
   *
   * A subset rather than the whole `ChatSignInView`, because the credential
   * half belongs to the adapter: the grant is handed a client and does not
   * know whether it was hers or the build's, which is exactly the ignorance
   * that lets `options.client` change underneath it.
   */
  view(): Pick<ChatSignInView, "granted" | "detail" | "pending"> {
    return {
      granted: this.granted,
      ...(this.pending
        ? {
            pending: {
              code: this.pending.userCode,
              url: this.pending.url,
              expiresAt: this.pending.expiresAt,
            },
          }
        : {}),
      detail: this.detail(),
    };
  }

  /**
   * Start a sign-in and answer at once, rather than waiting for her.
   *
   * She has to read a code off this page and type it somewhere else, which can
   * take a minute or five, and an action that does not return until she has
   * done it is a spinner on her phone for five minutes. So the code goes into
   * the slice, the poll runs on the server, and her page learns it worked from
   * the next patch -- which is also how a second page she opens meanwhile finds
   * out, and how the tab she left open survives a reconnect.
   */
  async signIn(): Promise<InvokeResult> {
    const client = this.options.client();
    if (!client) {
      return {
        ok: false,
        reason: "Add a Google client ID and secret first, so the bot has something to sign in with.",
      };
    }
    // Starting again replaces whatever was pending. She pressed the button, so
    // whatever she was looking at is a code she has decided not to use.
    this.clearPending();

    const asked = await requestDeviceCode(client, this.options.post, this.now());
    if (!asked.ok) return asked;

    this.pending = asked.value;
    this.options.log.info(`youtube: sign-in waiting on a code at ${asked.value.url}`);
    this.schedule(asked.value.intervalMs);
    this.options.onChange();
    return { ok: true };
  }

  /**
   * Forget the grant. The way out, and it is one button.
   *
   * It also cancels a sign-in she started and changed her mind about, which is
   * the reverse state of the paragraph above: if there is a way in there has to
   * be a way out, and "I pressed it by accident" is the commonest reason to
   * want one.
   */
  async signOut(): Promise<InvokeResult> {
    const had = this.granted || this.pending !== null;
    this.clearPending();
    this.refreshToken = "";
    this.access = null;
    this.refreshing = null;
    this.options.save("");
    if (had) this.options.log.info("youtube: signed out, so the bot can no longer write");
    this.options.onChange();
    return { ok: true };
  }

  /**
   * A working access token, refreshed if it is close to expiring.
   *
   * Throws with words she can read, because that is what the adapter's writes
   * do and this is on the same path: `ChatWriter` turns the message into the
   * refusal her queue renders.
   */
  async token(): Promise<string> {
    const client = this.options.client();
    if (!client || !this.granted) {
      throw new Error("Her Google sign-in is not set up, so the bot cannot write to chat.");
    }

    const held = this.access;
    if (held && held.expiresAt - REFRESH_MARGIN_MS > this.now()) return held.token;

    // Refreshed early rather than on expiry, so a token cannot die between
    // being handed out and being used.
    this.refreshing ??= this.renew(client).finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /** Drops the poll. Nothing waiting on a code may keep the tray alive. */
  stop(): void {
    this.clearPending();
  }

  // --- plumbing -------------------------------------------------------------

  private async renew(client: OAuthClient): Promise<string> {
    const got = await refreshAccess(client, this.refreshToken, this.options.post, this.now());
    if (got.ok) {
      this.access = got.value;
      return got.value.token;
    }

    // Only `invalid_grant` costs her the sign-in. Everything else -- her Wi-Fi,
    // a 500, a rate limit -- is worth pressing the button again for and must
    // not make her type a code to recover from.
    if (got.lost) {
      this.refreshToken = "";
      this.access = null;
      this.options.save("");
      this.options.log.warn("youtube: the grant is gone, so the bot has stopped writing");
      this.options.onChange();
    }
    throw new Error(got.reason);
  }

  private schedule(ms: number): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, ms);
    // A sign-in she walked away from must not be what stops the tray shutting
    // down.
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    const client = this.options.client();
    const waiting = this.pending;
    if (!client || !waiting) return;

    if (this.now() >= waiting.expiresAt) {
      this.give("That code ran out. Start the sign-in again.");
      return;
    }

    const answer = await pollForToken(client, waiting.deviceCode, this.options.post);
    // She may have signed out, or started again, while that was in flight --
    // in which case this poll is about a code that no longer exists.
    if (this.pending !== waiting) return;

    switch (answer.state) {
      case "done":
        this.clearPending();
        this.refreshToken = answer.refreshToken;
        this.access = null;
        this.options.save(answer.refreshToken);
        this.options.log.info("youtube: signed in, so the bot can write to her chat");
        this.options.onChange();
        return;
      case "waiting":
        this.schedule(waiting.intervalMs);
        return;
      case "slower":
        waiting.intervalMs += SLOW_DOWN_MS;
        this.schedule(waiting.intervalMs);
        return;
      case "refused":
        this.give(answer.reason);
        return;
    }
  }

  /** A sign-in that ended without a grant, and the words to leave behind. */
  private give(reason: string): void {
    this.clearPending();
    this.failure = reason;
    this.options.log.warn(`youtube: sign-in ended — ${reason}`);
    this.options.onChange();
  }

  private clearPending(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pending = null;
    this.failure = "";
  }

  /**
   * One sentence about the sign-in, in her words.
   *
   * It lives here rather than on her card for the reason `ChannelStats.detail`
   * does: what a Google sign-in is for, and what it is not, is knowledge about
   * this platform, and the point of the adapter seam is that the card holds
   * none of it.
   */
  private detail(): string {
    if (!this.options.client()) {
      return "No Google client ID yet, so the bot can read chat but cannot reply or moderate.";
    }
    if (this.pending) return "Waiting for her to type the code.";
    if (this.failure) return this.failure;
    if (this.granted) return "Signed in. The bot can reply in chat and take messages down.";
    return "Not signed in. The bot can read chat but cannot reply or moderate.";
  }
}
