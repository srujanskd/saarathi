/** One challenge per line, blanks ignored. The same rule `setChallenges` uses. */
export function toLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** The other direction, for putting the server's list back in the textarea. */
export function toText(challenges: string[]): string {
  return challenges.join("\n");
}
