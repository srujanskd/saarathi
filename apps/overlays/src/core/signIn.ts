import type { ChatSignInView } from "@saarathi/shared";

/**
 * How long she has left to type the code, in her words, or blank when there is
 * nothing pending.
 *
 * Pure and here rather than in the card for the reason `lockdown.ts` is: it
 * takes the *server's* clock, and passing a phone's `Date.now()` to it -- which
 * is routinely tens of seconds out -- is exactly the bug this repo keeps
 * writing the same comment about. Minutes round down, so it never claims more
 * time than the code has.
 */
export function codeExpiry(pending: ChatSignInView["pending"], serverNow: number): string {
  if (!pending) return "";
  const seconds = Math.ceil((pending.expiresAt - serverNow) / 1000);
  if (seconds <= 0) return "That code has run out";
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"} left to type it`;
  }
  return `${seconds}s left to type it`;
}
