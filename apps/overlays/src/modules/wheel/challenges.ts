/** One challenge per line, blanks ignored. The same rule `setChallenges` uses. */
export function linesOf(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function textOf(challenges: string[]): string {
  return challenges.join("\n");
}
