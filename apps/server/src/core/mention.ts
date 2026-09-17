/** Names may already be handles; add a mention prefix only once. */
export function mention(name: string): string {
  return `@${name.replace(/^@+/, "")}`;
}
