import { describe, expect, it } from "vitest";
import {
  collectStats,
  count,
  statsUrl,
  type StatFetch,
  type StatResponse,
} from "../../src/chat/youtube-stats.js";

const KEY = "test-key";
const CHANNEL = "UCchannel";
const VIDEO = "vid12345678";

const channelBody = (statistics: Record<string, unknown>) => ({ items: [{ statistics }] });
const videoBody = (statistics: Record<string, unknown>) => ({ items: [{ statistics }] });

const ok = (body: unknown): StatResponse => ({ status: 200, body });
const refused = (status: number, reason?: string): StatResponse => ({
  status,
  body: { error: { code: status, errors: reason ? [{ reason }] : [] } },
});

/** Answers by resource, and remembers every URL it was asked for. */
function fakeGet(answers: { channels?: StatResponse; videos?: StatResponse }) {
  const urls: string[] = [];
  const get: StatFetch = async (url) => {
    urls.push(url);
    const answer = url.includes("/channels?") ? answers.channels : answers.videos;
    if (!answer) throw new Error(`test asked for ${url} with no answer set`);
    return answer;
  };
  return Object.assign(get, { urls });
}

const both = (subscriberCount: string, likeCount: string) =>
  fakeGet({
    channels: ok(channelBody({ subscriberCount, hiddenSubscriberCount: false })),
    videos: ok(videoBody({ likeCount })),
  });

describe("count", () => {
  it("converts the JSON string YouTube actually sends", () => {
    // Observed against a live channel on Aug 30, 2026: a 37.7K channel answers
    // with the string "37700", not a number and not "37.7K".
    expect(count("37700")).toBe(37700);
  });

  it("takes a number that is already one as no answer, because YouTube sends strings", () => {
    expect(count(940)).toBeUndefined();
  });

  it("does not turn a missing field into a zero", () => {
    expect(count(undefined)).toBeUndefined();
    expect(count(null)).toBeUndefined();
    expect(count("")).toBeUndefined();
    expect(count("  ")).toBeUndefined();
  });

  it("refuses anything that is not a whole count", () => {
    expect(count("12.5")).toBeUndefined();
    expect(count("-1")).toBeUndefined();
    expect(count("lots")).toBeUndefined();
  });

  it("keeps a real zero, which is where she started", () => {
    expect(count("0")).toBe(0);
  });
});

describe("statsUrl", () => {
  it("asks for statistics and nothing else, because the payload rides on her data", () => {
    const url = new URL(statsUrl("channels", CHANNEL, KEY));
    expect(url.origin + url.pathname).toBe("https://www.googleapis.com/youtube/v3/channels");
    expect(url.searchParams.get("part")).toBe("statistics");
    expect(url.searchParams.get("id")).toBe(CHANNEL);
    expect(url.searchParams.get("key")).toBe(KEY);
  });

  it("escapes what it is given rather than pasting it in", () => {
    const url = new URL(statsUrl("videos", "a b&part=snippet", KEY));
    expect(url.searchParams.get("id")).toBe("a b&part=snippet");
    expect(url.searchParams.get("part")).toBe("statistics");
  });
});

describe("collectStats", () => {
  it("reports both counts when both calls land", async () => {
    const get = both("940", "97");
    const stats = await collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: VIDEO }, get);

    expect(stats.counts).toEqual({ subscribers: 940, likes: 97 });
    expect(stats.detail).toBe("Counting subscribers and likes.");
  });

  it("spends nothing at all without a key, and says so", async () => {
    const get = fakeGet({});
    const stats = await collectStats({ channelId: CHANNEL, videoId: VIDEO }, get);

    expect(stats.counts).toEqual({});
    expect(get.urls).toEqual([]);
    expect(stats.detail).toContain("API key");
  });

  it("counts likes only while chat is connected, and names the reason", async () => {
    // videos.list needs a video id and only chat ever learns one. This is the
    // ordinary state between her streams, not a failure.
    const get = fakeGet({ channels: ok(channelBody({ subscriberCount: "940" })) });
    const stats = await collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: null }, get);

    expect(stats.counts).toEqual({ subscribers: 940 });
    expect(stats.detail).toContain("No live stream yet");
    expect(get.urls).toHaveLength(1);
  });

  it("still counts likes when there is no channel id", async () => {
    const get = fakeGet({ videos: ok(videoBody({ likeCount: "97" })) });
    const stats = await collectStats({ apiKey: KEY, videoId: VIDEO }, get);

    expect(stats.counts).toEqual({ likes: 97 });
    expect(stats.detail).toContain("No channel set");
  });

  it("leaves subscribers out when she has hidden them", async () => {
    const get = fakeGet({
      channels: ok(channelBody({ hiddenSubscriberCount: true, subscriberCount: "0" })),
      videos: ok(videoBody({ likeCount: "97" })),
    });
    const stats = await collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: VIDEO }, get);

    // YouTube sends "0" alongside the flag. Rendering that is a goal bar that
    // reads empty forever and never says why.
    expect(stats.counts).toEqual({ likes: 97 });
    expect(stats.detail).toContain("hidden");
  });

  it("leaves likes out when ratings are off for the stream", async () => {
    const get = fakeGet({
      channels: ok(channelBody({ subscriberCount: "940" })),
      videos: ok(videoBody({ viewCount: "12" })),
    });
    const stats = await collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: VIDEO }, get);

    expect(stats.counts).toEqual({ subscribers: 940 });
    expect(stats.detail).toContain("Likes are hidden");
  });

  it("notices an id YouTube does not know, which answers 200 with nothing in it", async () => {
    const get = fakeGet({ channels: ok({ items: [] }), videos: ok(videoBody({ likeCount: "97" })) });
    const stats = await collectStats({ apiKey: KEY, channelId: "typo", videoId: VIDEO }, get);

    expect(stats.counts).toEqual({ likes: 97 });
    expect(stats.detail).toContain("no channel with that id");
  });

  it("tells her the key was refused, in words she can act on", async () => {
    const get = fakeGet({ channels: refused(400, "keyInvalid"), videos: refused(400, "keyInvalid") });
    const stats = await collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: VIDEO }, get);

    expect(stats.counts).toEqual({});
    expect(stats.detail).toContain("refused the API key");
  });

  it("tells her the quota is gone and when it comes back", async () => {
    const get = fakeGet({
      channels: refused(403, "quotaExceeded"),
      videos: ok(videoBody({ likeCount: "97" })),
    });
    const stats = await collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: VIDEO }, get);

    expect(stats.detail).toContain("quota");
    // One call refused does not cost her the other one's number.
    expect(stats.counts).toEqual({ likes: 97 });
  });

  it("throws when YouTube is having an afternoon, so the core keeps her numbers", async () => {
    // A 5xx is a blip. Returning absent counts for it would blank her goal bar
    // and fill it back in a minute later, which reads as a bug in the goal.
    const get = fakeGet({ channels: refused(503), videos: ok(videoBody({ likeCount: "97" })) });

    await expect(
      collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: VIDEO }, get),
    ).rejects.toThrow("503");
  });

  it("never puts the key in the error it throws", async () => {
    // The key rides in the query string, so anything that quotes the URL leaks
    // it into a log she may well send someone for help.
    const get = fakeGet({ channels: refused(500) });
    const failure = await collectStats(
      { apiKey: KEY, channelId: CHANNEL, videoId: VIDEO },
      get,
    ).catch((err: unknown) => String(err));

    expect(failure).toContain("500");
    expect(failure).not.toContain(KEY);
  });

  it("lets a network failure through for the same reason", async () => {
    const get: StatFetch = async () => {
      throw new Error("ETIMEDOUT");
    };

    await expect(
      collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: VIDEO }, get),
    ).rejects.toThrow("ETIMEDOUT");
  });

  it("does not read a body that is not the shape YouTube documents", async () => {
    const get = fakeGet({ channels: ok(null), videos: ok({ items: [{}] }) });
    const stats = await collectStats({ apiKey: KEY, channelId: CHANNEL, videoId: VIDEO }, get);

    expect(stats.counts).toEqual({});
  });
});
