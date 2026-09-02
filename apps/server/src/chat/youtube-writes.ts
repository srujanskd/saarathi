/**
 * The writing half of YouTube: three calls, one lookup, and what each documented
 * refusal means in words she can act on.
 *
 * Pure but for `httpJson`, on the split `youtube-stats.ts` uses. Every one of
 * these throws rather than answering false, because that is the contract
 * `ChatWrites` sets: a write failing is the normal case -- her Wi-Fi, a revoked
 * grant, a quota that ran out at 4pm -- and the caller has to tell those apart
 * from each other, which an error carries and a boolean does not. The message on
 * the error is written for her, because it is what her queue renders when a
 * button refuses.
 */

import { WriteRefused } from "./adapter.js";

const API = "https://www.googleapis.com/youtube/v3";

/** A write must not still be in flight when she presses the button again. */
const TIMEOUT_MS = 10_000;

export interface JsonResponse {
  status: number;
  body: unknown;
}

/**
 * One authorized request, injected so every branch below is testable without a
 * token. A throw means we could not reach YouTube at all.
 */
export type JsonRequest = (input: {
  method: "GET" | "POST" | "DELETE";
  url: string;
  token: string;
  body?: unknown;
}) => Promise<JsonResponse>;

/**
 * An authorized way to reach the API: how to call, and what to call as.
 *
 * One argument rather than the two that used to trail every call here. They
 * always travelled together and were always the last two parameters, which is a
 * type asking to be born -- and the token is the half that changes between one
 * call and the next, so a caller holding an `Api` is holding the thing with the
 * short life, named as such.
 */
export interface Api {
  token: string;
  request: JsonRequest;
}

/**
 * The id of the chat attached to the video she is live on.
 *
 * Not the video id, and this is the part that is easy to get wrong: two of the
 * three writes below are addressed to a *chat*, and nothing upstream has one.
 * Chat is read over InnerTube, which knows the video; the official API knows
 * the chat. So this is the bridge, and it costs one quota unit.
 *
 * Worth caching for the life of a video and worthless after it: a chat id
 * belongs to one broadcast, so the adapter throws it away when chat ends for
 * the same reason it throws the like count away.
 */
export async function activeChatId(videoId: string, api: Api): Promise<string> {
  const query = new URLSearchParams({ part: "liveStreamingDetails", id: videoId });
  const answer = await api.request({
    method: "GET",
    url: `${API}/videos?${query.toString()}`,
    token: api.token,
  });
  if (answer.status !== 200) throw refused(answer, "read her live chat");

  const items = (answer.body as { items?: unknown })?.items;
  // An id YouTube does not recognise comes back 200 with an empty list rather
  // than a 404, so this is the only place a stale video id is noticed.
  const details = Array.isArray(items)
    ? (items[0] as { liveStreamingDetails?: { activeLiveChatId?: unknown } })
        ?.liveStreamingDetails
    : undefined;
  const chatId = details?.activeLiveChatId;
  if (typeof chatId !== "string" || !chatId) {
    // The honest reading of an absent one: the broadcast has ended, or chat is
    // switched off for it. Neither is a bug and neither is worth a retry.
    throw new WriteRefused("That stream has no live chat open any more.");
  }
  return chatId;
}

/** Post a line as her channel. */
export async function insertMessage(chatId: string, text: string, api: Api): Promise<void> {
  const answer = await api.request({
    method: "POST",
    url: `${API}/liveChat/messages?part=snippet`,
    token: api.token,
    body: {
      snippet: {
        type: "textMessageEvent",
        liveChatId: chatId,
        textMessageDetails: { messageText: text },
      },
    },
  });
  if (answer.status >= 300) throw refused(answer, "post that");
}

/**
 * Take one message down.
 *
 * Addressed to the message rather than to the chat, which is why a delete needs
 * no chat id and works on a message from a broadcast that has since ended.
 */
export async function deleteMessage(messageId: string, api: Api): Promise<void> {
  const query = new URLSearchParams({ id: messageId });
  const answer = await api.request({
    method: "DELETE",
    url: `${API}/liveChat/messages?${query.toString()}`,
    token: api.token,
  });
  // A delete answers 204 with no body when it worked.
  if (answer.status >= 300) throw refused(answer, "take that message down");
}

/**
 * Ban an account from her chat, permanently.
 *
 * Permanent rather than a timed one because that is what her queue's button
 * says it does. A temporary ban is a different thing with a duration on it, and
 * offering both from one row is a decision at arm's length during a raid.
 */
export async function banUser(chatId: string, channelId: string, api: Api): Promise<void> {
  const answer = await api.request({
    method: "POST",
    url: `${API}/liveChat/bans?part=snippet`,
    token: api.token,
    body: {
      snippet: {
        liveChatId: chatId,
        type: "permanent",
        bannedUserDetails: { channelId },
      },
    },
  });
  if (answer.status >= 300) throw refused(answer, "ban them");
}

/**
 * What to tell her about a write YouTube would not do.
 *
 * `quotaExceeded` gets the fullest sentence because it is the one nothing local
 * predicted: our own counter can only see what this install spent, and the
 * quota belongs to the whole project, so exhaustion arrives as a refusal no
 * meter had reached. Saying "it resets at midnight Pacific" is the only useful
 * thing there -- and Pacific, not hers, because it is Google's day.
 */
export function refusal(answer: JsonResponse, what: string): string {
  const reason = errorReason(answer.body);
  switch (reason) {
    case "quotaExceeded":
      return `YouTube has used up today's quota, so it will not ${what}. It resets at midnight Pacific time.`;
    case "rateLimitExceeded":
      // Not the same failure as the one above it, and folding the two together
      // cost her the difference: a rate limit is Google asking us to slow down
      // for a moment and is worth pressing again, where an exhausted quota is
      // gone until it resets. Only one of them is worth telling her the day is
      // over for.
      return `YouTube is rate limiting us right now, so it would not ${what}. Try again in a moment.`;
    case "insufficientPermissions":
    case "forbidden":
      return `Her Google sign-in is not allowed to ${what}. Signing in again may fix it.`;
    case "authError":
    case "unauthorized":
      return "Her Google sign-in has expired. Sign in again to let the bot write.";
    case "liveChatDisabled":
      return "Live chat is switched off for this stream.";
    case "liveChatEnded":
      return "That stream's chat has ended.";
    case "liveChatNotFound":
      return "YouTube cannot find that chat any more.";
    case "liveChatMessageNotFound":
      return "That message is already gone.";
    case "liveChatBanInsertionFailed":
      return "YouTube would not add that ban. They may already be banned.";
    case "blockedUser":
      return "YouTube blocked that message. It may have looked like spam.";
    default:
      if (answer.status >= 500) {
        // YouTube having an afternoon. Worth pressing again, unlike everything
        // above it, and the words say which kind of failure this is.
        return `YouTube could not ${what} just now (${answer.status}). Try again.`;
      }
      return `YouTube would not ${what} (${answer.status}).`;
  }
}

/**
 * The refusal as something to throw, carrying whether the day is over.
 *
 * `refusal` stays exported and stays a string: it is the sentence, and the
 * sentence is what her queue renders. This adds the one bit the *core* reads --
 * see `WriteRefused` -- so the meter can go to an exhausted state instead of
 * logging one more failure it cannot tell apart from her Wi-Fi.
 */
export function refused(answer: JsonResponse, what: string): WriteRefused {
  return new WriteRefused(refusal(answer, what), errorReason(answer.body) === "quotaExceeded");
}

/** Google's machine-readable reason, e.g. "quotaExceeded". */
function errorReason(body: unknown): string | null {
  const error = (body as { error?: { errors?: unknown; status?: unknown } })?.error;
  const errors = error?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const reason = (errors[0] as { reason?: unknown })?.reason;
    if (typeof reason === "string") return reason;
  }
  // Newer responses carry a status enum instead of the errors array, and a
  // 403 with neither would otherwise fall through to a bare status code.
  const status = error?.status;
  if (typeof status === "string") {
    if (status === "PERMISSION_DENIED") return "forbidden";
    if (status === "UNAUTHENTICATED") return "unauthorized";
  }
  return null;
}

/** The one impure function here: a real authorized request with a clock on it. */
export async function httpJson(input: {
  method: "GET" | "POST" | "DELETE";
  url: string;
  token: string;
  body?: unknown;
}): Promise<JsonResponse> {
  const response = await fetch(input.url, {
    method: input.method,
    headers: {
      authorization: `Bearer ${input.token}`,
      ...(input.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => {
    // Replaced rather than passed on: the request carries her access token in a
    // header, and this message is what lands in a log and on her card.
    throw new Error("Could not reach YouTube");
  });
  // A 204 has no body, and Google sends JSON for its errors, so this is parsed
  // either way and null lands in the same branch as an unreadable one.
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
