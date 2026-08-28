import { MAX_CHALLENGES } from "@saarathi/shared";

/** One challenge per line, blanks ignored. The same rule `setChallenges` uses. */
export function toLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** The other direction, for putting the server's list back in the textarea. */
export function toText(challenges: string[]): string {
  return challenges.join("\n");
}

/**
 * What the fold says about the size of the list she is editing. It counts the
 * draft rather than the saved list so the cap shows up while she is typing,
 * not only when the server turns the save down.
 *
 * It reports; it does not decide. The server owns the rule -- the Save button
 * stays live and its refusal is the authority, because a button that silently
 * greys out tells her nothing at arm's length.
 */
export function countLabel(count: number): string {
  if (count > MAX_CHALLENGES) return `${count} challenges — ${MAX_CHALLENGES} is the most that fit`;
  return count === 1 ? "1 challenge" : `${count} challenges`;
}
