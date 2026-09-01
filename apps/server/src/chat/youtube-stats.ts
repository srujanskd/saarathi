import type { ChannelStats, StatCounts } from "@saarathi/shared";

/**
 * The pure half of the YouTube counts: which URL to ask, what the two documented
 * JSON shapes mean, and what to tell her when a number is not there.
 *
 * It is a separate file from the adapter for the reason `obs-config.ts` is
 * separate from `obs.ts`: every decision in here is reachable from a unit test
 * without a socket or a key, and the one impure function is small enough to read
 * in a sitting.
 *
 * Both counts arrive as JSON *strings* -- YouTube sends `"37700"`, not 37700 --
 * and they convert here, at the boundary, like everything else that crosses one.
 */

const API = "https://www.googleapis.com/youtube/v3";

/**
 * A slow call must not still be running when the next poll starts, so this is
 * comfortably under `STATS_POLL_MS`. It is the same hazard the OBS timeouts
 * exist for: a filtered port answers never rather than answering badly.
 */
const FETCH_TIMEOUT_MS = 10_000;

export interface StatResponse {
  status: number;
  /** Parsed JSON, or null when there was none to parse. */
  body: unknown;
}

/**
 * One GET, injected so every branch below is testable without a network or a
 * key. A throw means "we could not reach YouTube", which the core's poll turns
 * into words and a set of counts held still.
 */
export type StatFetch = (url: string) => Promise<StatResponse>;

export interface StatsInput {
  apiKey?: string;
  channelId?: string;
  /**
   * The video she is live on right now. `videos.list` needs one and the adapter
   * only ever learns it from chat, so likes exist exactly while chat is
   * connected. That is the honest shape of the number, not a limitation.
   */
  videoId?: string | null;
}

/** The counts YouTube can give us right now, and why it cannot give the rest. */
export async function collectStats(input: StatsInput, get: StatFetch): Promise<ChannelStats> {
  const { apiKey, channelId, videoId } = input;
  // One sentence and nothing else: with no key neither call is worth making, and
  // "add a key" is the only thing she could do about either.
  if (!apiKey) {
    return {
      counts: {},
      stream: videoId ?? undefined,
      detail: "No YouTube API key yet, so there are no counts to show.",
    };
  }

  const counts: StatCounts = {};
  const notes: string[] = [];

  const subscribers = channelId
    ? await ask(get, statsUrl("channels", channelId, apiKey), "channel", readSubscribers)
    : { note: "No channel set, so subscribers cannot be counted." };
  if (subscribers.count !== undefined) counts.subscribers = subscribers.count;
  if (subscribers.note) notes.push(subscribers.note);

  const likes = videoId
    ? await ask(get, statsUrl("videos", videoId, apiKey), "video", readLikes)
    : { note: "No live stream yet, so there are no likes to count." };
  if (likes.count !== undefined) counts.likes = likes.count;
  if (likes.note) notes.push(likes.note);

  return {
    counts,
    // The video she is live on *is* the stream, so the id is the token -- and
    // nothing downstream is allowed to know that is what it is. It carries one
    // fact: a different one means the like count started over.
    stream: videoId ?? undefined,
    detail: notes.length > 0 ? notes.join(" ") : "Counting subscribers and likes.",
  };
}

/** A count we got, or a sentence about why we did not. Never both. */
interface Reading {
  count?: number;
  note?: string;
}

type ResourceKind = "channel" | "video";

async function ask(
  get: StatFetch,
  url: string,
  kind: ResourceKind,
  read: (statistics: Record<string, unknown>) => Reading,
): Promise<Reading> {
  const answer = await get(url);
  if (answer.status !== 200) return { note: refusal(answer, kind) };

  const statistics = firstStatistics(answer.body);
  // An id YouTube does not recognise comes back 200 with an empty list rather
  // than a 404, so this is the only place a wrong id is noticed.
  if (!statistics) return { note: `YouTube has no ${kind} with that id.` };
  return read(statistics);
}

function readSubscribers(statistics: Record<string, unknown>): Reading {
  // A real state and hers to choose, not an error: YouTube Studio has a switch
  // for it, and no key of any kind reaches the number once it is on.
  if (statistics.hiddenSubscriberCount === true) {
    return { note: "Her subscriber count is hidden on YouTube, so it cannot be counted." };
  }
  const subscribers = count(statistics.subscriberCount);
  return subscribers === undefined
    ? { note: "YouTube sent no subscriber count." }
    : { count: subscribers };
}

function readLikes(statistics: Record<string, unknown>): Reading {
  const likes = count(statistics.likeCount);
  // Omitted rather than zeroed when ratings are off for the video.
  return likes === undefined ? { note: "Likes are hidden on this stream." } : { count: likes };
}

/**
 * What to say about a call YouTube refused -- and what to do about one it could
 * not answer at all.
 *
 * A 5xx throws, so the core keeps the numbers it had and only changes the words:
 * YouTube having an afternoon is a blip, and blanking her goal bar for it reads
 * as a bug in the goal. A 4xx is a fact about the key or the id that will still
 * be true in a minute, so it gets a sentence she can act on instead, and the
 * count really does go away because it really is not available.
 */
function refusal(answer: StatResponse, kind: ResourceKind): string {
  const reason = errorReason(answer.body);
  if (answer.status >= 500) {
    // The URL carries the key, so nothing here may quote it. Status and reason
    // are all a log needs anyway.
    throw new Error(`YouTube answered ${answer.status}${reason ? ` (${reason})` : ""}`);
  }
  switch (reason) {
    case "quotaExceeded":
    case "rateLimitExceeded":
      return "This API key has used up YouTube's quota for today. It resets at midnight Pacific time.";
    case "keyInvalid":
    case "badRequest":
      return "YouTube refused the API key. Check the key in settings.";
    case "ipRefererBlocked":
      return "YouTube refused the API key from this machine. Check the key's restrictions.";
    default:
      return `YouTube would not answer for the ${kind} (${answer.status}).`;
  }
}

/** `part=statistics` and nothing else: the payload rides on her data in IRL mode. */
export function statsUrl(resource: "channels" | "videos", id: string, apiKey: string): string {
  const query = new URLSearchParams({ part: "statistics", id, key: apiKey });
  return `${API}/${resource}?${query.toString()}`;
}

/**
 * A count out of the JSON string YouTube sends. Anything that is not a whole,
 * non-negative number is treated as no answer rather than as a zero: a goal bar
 * that reads 0 because a field changed shape is worse than one that reads empty
 * and says why.
 */
export function count(raw: unknown): number | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The `statistics` object of the first item, if the answer has that shape. */
function firstStatistics(body: unknown): Record<string, unknown> | null {
  const items = (body as { items?: unknown })?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const statistics = (items[0] as { statistics?: unknown })?.statistics;
  if (typeof statistics !== "object" || statistics === null) return null;
  return statistics as Record<string, unknown>;
}

/** Google's machine-readable reason, e.g. "quotaExceeded". */
function errorReason(body: unknown): string | null {
  const errors = (body as { error?: { errors?: unknown } })?.error?.errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const reason = (errors[0] as { reason?: unknown })?.reason;
  return typeof reason === "string" ? reason : null;
}

/** The one impure function here: a real GET with a clock on it. */
export async function httpGet(url: string): Promise<StatResponse> {
  // The rejection is replaced rather than passed on, because the URL carries
  // her key and a thrown error is the one string here that travels: the core
  // logs it verbatim when a poll fails, and a key in a log file is a key that
  // has left the server. What went wrong is a network either way.
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(
    () => {
      throw new Error("Could not reach YouTube");
    },
  );
  // Google sends JSON for its errors too, so this is parsed either way. A body
  // that is not JSON at all is a proxy or a captive portal talking, and null
  // lands in the same "would not answer" branch as an empty one.
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
