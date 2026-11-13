/**
 * What a viewer's text contains that nobody should be shown or read aloud
 * without a second look: links and the bundled scam shapes.
 *
 * Core and not either module's, because two of them ask. Moderation asks
 * whether to queue a chat message for her; paid speech asks whether to put a
 * message on her stream. Both have to agree on what a link is, or the one
 * that disagrees is the one a scam gets through.
 */

/**
 * The shapes a scam arrives in, and the words to describe each one to her.
 *
 * Bundled rather than left to her word list, because the whole point of this
 * one is that she does not have to know what this month's giveaway bot says.
 * Two signals where one would over-fire: "invest" on its own is a fitness
 * streamer's chat talking about a gym membership, and "cash" on its own is
 * nothing at all -- so the weak ones only count next to a second signal.
 *
 * Every entry names itself, because "a scam rule caught it" is not something
 * she can check, and this queue only works if she can see why in one line.
 */
const SCAMS: { reason: string; test: RegExp }[] = [
  {
    reason: "Asks people to message an account off-platform",
    test: /\b(?:whats\W?app|telegram|t\.me|wa\.me|signal)\b/i,
  },
  {
    reason: "Fake giveaway win",
    test: /\b(?:you(?:'ve| have)? won|claim (?:your|the) (?:prize|reward)|selected winner|congratulations winner)\b/i,
  },
  {
    reason: "Investment pitch",
    test: /\b(?:forex|crypto|bitcoin|binary option|trading signal)\b.{0,60}\b(?:profit|earn|invest|double|guaranteed|dm)\b/i,
  },
  {
    reason: "Pretends to be her",
    test: /\b(?:i am the real|this is the real|my official|second channel).{0,30}\b(?:channel|account)\b/i,
  },
  {
    reason: "Points at a profile instead of saying anything",
    test: /\b(?:check|see|look at) my (?:profile|bio|about|picture|pfp)\b/i,
  },
];

/** Which scam shape the text matches, in words she can read, or null. */
export function scamIn(text: string): string | null {
  return SCAMS.find((scam) => scam.test.test(text))?.reason ?? null;
}

// Bare domains as well as full URLs: a scam does not write the scheme, and
// "bit.ly/x" is the whole message half the time.
const LINK = /(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/\S*)?/gi;

// A sentence ending in ".so" or a decimal is not a link. Requiring a plausible
// public suffix costs a "localhost:4400" nobody types in chat.
const plausible = (host: string) => /\.[a-z]{2,}$/.test(host) && !/^\d+(?:\.\d+)+$/.test(host);

/** Where a link points, lowercased, for every link in the message. */
export function hostsIn(text: string): string[] {
  const hosts: string[] = [];
  for (const match of text.matchAll(LINK)) {
    const host = match[1]?.toLowerCase();
    if (host && plausible(host)) hosts.push(host);
  }
  return hosts;
}

/** The text with every link `hostsIn` would find swapped for `replacement`. */
export function withoutLinks(text: string, replacement: string): string {
  return text.replace(LINK, (match, host: string) => (plausible(host.toLowerCase()) ? replacement : match));
}
