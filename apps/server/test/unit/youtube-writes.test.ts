import { describe, expect, it } from "vitest";
import {
  activeChatId,
  banUser,
  deleteMessage,
  insertMessage,
  refusal,
  type JsonRequest,
  type JsonResponse,
} from "../../src/chat/youtube-writes.js";

type Asked = Parameters<JsonRequest>[0];

/** A YouTube that answers whatever the test says, and keeps what it was asked. */
function youtube(...answers: JsonResponse[]) {
  const asked: Asked[] = [];
  let next = 0;
  const request: JsonRequest = async (input) => {
    asked.push(input);
    return answers[Math.min(next++, answers.length - 1)]!;
  };
  return { request, asked };
}

const CHAT_ID = "Cg0KC2FiY2RlZmdoaWpr";

describe("finding the chat on the video she is live on", () => {
  it("asks for the live details and returns the chat's own id", async () => {
    // The part that is easy to get wrong: two of the three writes are
    // addressed to a *chat*, and nothing upstream has one -- chat is read over
    // InnerTube, which knows the video, and the official API knows the chat.
    const yt = youtube({
      status: 200,
      body: { items: [{ liveStreamingDetails: { activeLiveChatId: CHAT_ID } }] },
    });

    expect(await activeChatId("vid123", "token", yt.request)).toBe(CHAT_ID);
    expect(yt.asked[0]!.method).toBe("GET");
    expect(yt.asked[0]!.url).toContain("part=liveStreamingDetails");
    expect(yt.asked[0]!.url).toContain("id=vid123");
    expect(yt.asked[0]!.token).toBe("token");
  });

  it("says the chat is closed when YouTube names no active one", async () => {
    // A broadcast that has ended, or one with chat switched off. Neither is a
    // bug and neither is worth a retry.
    const yt = youtube({ status: 200, body: { items: [{ liveStreamingDetails: {} }] } });
    await expect(activeChatId("vid", "t", yt.request)).rejects.toThrow(
      "That stream has no live chat open any more.",
    );
  });

  it("says the same for a video id YouTube does not recognise", async () => {
    // An unknown id comes back 200 with an empty list rather than a 404, so
    // this is the only place a stale video id is noticed at all.
    const yt = youtube({ status: 200, body: { items: [] } });
    await expect(activeChatId("gone", "t", yt.request)).rejects.toThrow("no live chat open");
  });
});

describe("posting a line as her channel", () => {
  it("sends the documented shape for a text message", async () => {
    const yt = youtube({ status: 200, body: {} });

    await insertMessage(CHAT_ID, "@viewer 12 gains", "token", yt.request);

    expect(yt.asked[0]).toMatchObject({
      method: "POST",
      url: "https://www.googleapis.com/youtube/v3/liveChat/messages?part=snippet",
      body: {
        snippet: {
          type: "textMessageEvent",
          liveChatId: CHAT_ID,
          textMessageDetails: { messageText: "@viewer 12 gains" },
        },
      },
    });
  });

  it("throws with words she can read when YouTube refuses", async () => {
    const yt = youtube({ status: 403, body: { error: { errors: [{ reason: "blockedUser" }] } } });
    await expect(insertMessage(CHAT_ID, "hi", "t", yt.request)).rejects.toThrow(
      "YouTube blocked that message. It may have looked like spam.",
    );
  });
});

describe("taking a message down", () => {
  it("names the message and needs no chat id", async () => {
    // Which is why a row still sitting in her queue twenty minutes after the
    // broadcast ended can still be acted on.
    const yt = youtube({ status: 204, body: null });

    await deleteMessage("msg-abc", "token", yt.request);

    expect(yt.asked[0]!.method).toBe("DELETE");
    expect(yt.asked[0]!.url).toContain("id=msg-abc");
    expect(yt.asked[0]!.body).toBeUndefined();
  });

  it("treats 204 with no body as success, because that is what a delete answers", async () => {
    const yt = youtube({ status: 204, body: null });
    await expect(deleteMessage("m", "t", yt.request)).resolves.toBeUndefined();
  });

  it("says a message that is already gone is already gone", async () => {
    const yt = youtube({
      status: 404,
      body: { error: { errors: [{ reason: "liveChatMessageNotFound" }] } },
    });
    await expect(deleteMessage("m", "t", yt.request)).rejects.toThrow("already gone");
  });
});

describe("banning an account", () => {
  it("sends a permanent ban against the chat and the channel", async () => {
    const yt = youtube({ status: 200, body: {} });

    await banUser(CHAT_ID, "UCviewer", "token", yt.request);

    expect(yt.asked[0]).toMatchObject({
      method: "POST",
      url: "https://www.googleapis.com/youtube/v3/liveChat/bans?part=snippet",
      body: {
        snippet: {
          liveChatId: CHAT_ID,
          // Permanent, because that is what the button on her queue says it
          // does. A timed ban is a different thing with a duration on it.
          type: "permanent",
          bannedUserDetails: { channelId: "UCviewer" },
        },
      },
    });
  });
});

describe("what she is told about a refusal", () => {
  const because = (reason: string, status = 403): JsonResponse => ({
    status,
    body: { error: { errors: [{ reason }] } },
  });

  it("explains a spent quota, in Google's day rather than hers", async () => {
    // The one failure nothing local predicted: our counter sees only what this
    // install spent, and the quota belongs to the whole project.
    expect(refusal(because("quotaExceeded"), "post that")).toBe(
      "YouTube has used up today's quota, so it will not post that. It resets at midnight Pacific time.",
    );
  });

  it("tells her which refusals a fresh sign-in might fix", () => {
    expect(refusal(because("insufficientPermissions"), "ban them")).toContain(
      "Signing in again may fix it",
    );
    expect(refusal(because("authError", 401), "post that")).toContain("Sign in again");
  });

  it("reads the newer status enum as well as the errors array", () => {
    // A 403 carrying only `status` would otherwise fall through to a bare
    // status code, which tells her nothing she can act on.
    expect(refusal({ status: 403, body: { error: { status: "PERMISSION_DENIED" } } }, "x")).toContain(
      "not allowed",
    );
    expect(
      refusal({ status: 401, body: { error: { status: "UNAUTHENTICATED" } } }, "x"),
    ).toContain("Sign in again");
  });

  it("tells her to try again for a YouTube problem, and not for hers", () => {
    // A 5xx is worth pressing the button again. Everything above it will still
    // be true in a minute, so none of those say "try again".
    expect(refusal({ status: 503, body: null }, "post that")).toContain("Try again");
    expect(refusal(because("liveChatEnded", 403), "post that")).not.toContain("Try again");
  });

  it("names what it could not do, whatever went wrong", () => {
    // The verb comes from the caller, so one sentence serves three calls and
    // she is never told "the write failed".
    expect(refusal({ status: 418, body: null }, "take that message down")).toBe(
      "YouTube would not take that message down (418).",
    );
  });
});
