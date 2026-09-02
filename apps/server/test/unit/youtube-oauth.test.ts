import { describe, expect, it } from "vitest";
import {
  YOUTUBE_SCOPE,
  clientFrom,
  clientIdProblem,
  oauthClient,
  pollForToken,
  refreshAccess,
  requestDeviceCode,
  type FormPost,
} from "../../src/chat/youtube-oauth.js";

const CLIENT = { id: "client.apps.googleusercontent.com", secret: "shh" };
const NOW = 1_760_000_000_000;

/** A Google that answers whatever the test says, and keeps what it was asked. */
function google(...answers: { status: number; body: unknown }[]) {
  const asked: { url: string; form: Record<string, string> }[] = [];
  let next = 0;
  const post: FormPost = async (url, form) => {
    asked.push({ url, form });
    return answers[Math.min(next++, answers.length - 1)]!;
  };
  return { post, asked };
}

/** A Google that cannot be reached at all, which is not the same as a refusal. */
const offline: FormPost = async () => {
  throw new Error("Could not reach Google");
};

describe("the credential this build was compiled with", () => {
  it("is whatever the environment says, for a dev run", () => {
    expect(oauthClient({ GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" })).toEqual({
      id: "id",
      secret: "secret",
    });
  });

  it("is null when half of it is missing, so nothing tries a call that cannot work", () => {
    // A build with no credential asks her for one. It does not fail on the
    // first request, which is what dev and CI would otherwise do.
    expect(oauthClient({ GOOGLE_CLIENT_ID: "id" })).toBeNull();
    expect(oauthClient({ GOOGLE_CLIENT_SECRET: "secret" })).toBeNull();
    expect(oauthClient({})).toBeNull();
  });
});

describe("what counts as a complete credential", () => {
  it("needs both halves, and trims what she pasted", () => {
    // A phone's paste brings whitespace with it more often than not.
    expect(clientFrom("  id  ", "\tsecret\n")).toEqual({ id: "id", secret: "secret" });
    expect(clientFrom("id", "   ")).toBeNull();
    expect(clientFrom("", "secret")).toBeNull();
  });
});

describe("what she pasted into the client ID box", () => {
  it("accepts a real one", () => {
    expect(clientIdProblem("123-abc.apps.googleusercontent.com")).toBeNull();
    // Trimmed, because a paste from a phone brings spaces with it.
    expect(clientIdProblem("  123.apps.googleusercontent.com  ")).toBeNull();
  });

  it("names the API key, which is the mistake she will actually make", () => {
    // The two boxes are one card apart and both hold a long opaque string.
    expect(clientIdProblem("AIzaSyExampleKeyValue")).toContain("YouTube API key");
  });

  it("names the secret, when the two are the other way round", () => {
    expect(clientIdProblem("GOCSPX-abcdef")).toContain("the other way round");
  });

  it("says what one looks like, and where to get it, for anything else", () => {
    const wrong = clientIdProblem("my-project-42")!;
    expect(wrong).toContain(".apps.googleusercontent.com");
    // The sentence about where comes from the adapter layer, not the card:
    // which console, and which of several client types, is a fact about Google.
    expect(wrong).toContain("TVs and Limited Input devices");
  });

  it("asks for it rather than describing it when the box is empty", () => {
    expect(clientIdProblem("   ")).toBe("Paste the client ID as well as the secret.");
  });
});

describe("asking Google for a code she can type", () => {
  it("asks for the one scope the device flow allows", async () => {
    const g = google({
      status: 200,
      body: {
        device_code: "dev-code",
        user_code: "ABCD-EFGH",
        verification_url: "https://www.google.com/device",
        expires_in: 1800,
        interval: 5,
      },
    });

    const got = await requestDeviceCode(CLIENT, g.post, NOW);

    // force-ssl is not on Google's allowed list for this flow, and asking for
    // it fails the very first call with a message about scopes that mentions
    // nothing about device codes. This assertion is the guard on that.
    expect(g.asked[0]!.form.scope).toBe("https://www.googleapis.com/auth/youtube");
    expect(YOUTUBE_SCOPE).not.toContain("force-ssl");
    // No client secret on this call: it is the token exchange that needs one.
    expect(g.asked[0]!.form).not.toHaveProperty("client_secret");

    expect(got).toEqual({
      ok: true,
      value: {
        deviceCode: "dev-code",
        userCode: "ABCD-EFGH",
        url: "https://www.google.com/device",
        // Our clock plus Google's duration, not Google's own timestamp: her
        // page renders the time left, and it is on a phone.
        expiresAt: NOW + 1_800_000,
        intervalMs: 5_000,
      },
    });
  });

  it("reads the RFC's spelling of the URL as well as Google's", async () => {
    // Google sends `verification_url`; the RFC calls it `verification_uri`.
    // Guessing the URL would send her somewhere she cannot sign in.
    const g = google({
      status: 200,
      body: {
        device_code: "d",
        user_code: "C",
        verification_uri: "https://example.test/device",
      },
    });
    const got = await requestDeviceCode(CLIENT, g.post, NOW);
    expect(got).toMatchObject({ ok: true, value: { url: "https://example.test/device" } });
  });

  it("falls back to sane timings when Google sends none", async () => {
    const g = google({
      status: 200,
      body: { device_code: "d", user_code: "C", verification_url: "u" },
    });
    const got = await requestDeviceCode(CLIENT, g.post, NOW);
    expect(got).toMatchObject({ ok: true, value: { intervalMs: 5_000 } });
    expect((got as { value: { expiresAt: number } }).value.expiresAt).toBeGreaterThan(NOW);
  });

  it("says a build problem is a build problem, not something she can fix", async () => {
    const g = google({ status: 401, body: { error: "invalid_client" } });
    const got = await requestDeviceCode(CLIENT, g.post, NOW);
    expect(got).toEqual({
      ok: false,
      reason:
        "This build's Google sign-in is not set up correctly. That is a bug, not something she can fix.",
    });
  });

  it("says so when the scope was refused, which is the force-ssl trap", async () => {
    const g = google({ status: 400, body: { error: "invalid_scope" } });
    const got = await requestDeviceCode(CLIENT, g.post, NOW);
    expect(got).toMatchObject({ ok: false });
    expect((got as { reason: string }).reason).toContain("bug");
  });

  it("tells her about the internet, not about Google, when it cannot reach it", async () => {
    const got = await requestDeviceCode(CLIENT, offline, NOW);
    expect(got).toEqual({
      ok: false,
      reason: "Could not reach Google. Check the internet and try again.",
    });
  });

  it("refuses an answer it cannot read rather than half-starting a sign-in", async () => {
    const g = google({ status: 200, body: { user_code: "C" } });
    const got = await requestDeviceCode(CLIENT, g.post, NOW);
    expect(got).toEqual({
      ok: false,
      reason: "Google sent back a sign-in we could not read.",
    });
  });
});

describe("polling while she types it", () => {
  it("keeps the refresh token and nothing else", async () => {
    const g = google({
      status: 200,
      body: { access_token: "at", refresh_token: "rt", expires_in: 3600 },
    });

    expect(await pollForToken(CLIENT, "dev-code", g.post)).toEqual({
      state: "done",
      refreshToken: "rt",
    });
    expect(g.asked[0]!.form).toMatchObject({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: "dev-code",
      client_secret: "shh",
    });
  });

  it("waits while she is still finding her phone", async () => {
    const g = google({ status: 428, body: { error: "authorization_pending" } });
    expect(await pollForToken(CLIENT, "d", g.post)).toEqual({ state: "waiting" });
  });

  it("is told to slow down and says so, rather than treating it as a refusal", async () => {
    const g = google({ status: 403, body: { error: "slow_down" } });
    expect(await pollForToken(CLIENT, "d", g.post)).toEqual({ state: "slower" });
  });

  it("waits through a network blip instead of throwing the sign-in away", async () => {
    // Her Wi-Fi dropping for four seconds is not her being denied, and losing
    // the sign-in over it means typing the code again for nothing.
    expect(await pollForToken(CLIENT, "d", offline)).toEqual({ state: "waiting" });
  });

  it("ends on a refusal she can read", async () => {
    const denied = google({ status: 403, body: { error: "access_denied" } });
    expect(await pollForToken(CLIENT, "d", denied.post)).toEqual({
      state: "refused",
      reason: "Sign-in was turned down. Nothing has changed.",
    });

    const stale = google({ status: 400, body: { error: "expired_token" } });
    expect(await pollForToken(CLIENT, "d", stale.post)).toEqual({
      state: "refused",
      reason: "That code ran out. Start the sign-in again.",
    });
  });

  it("refuses a grant with no refresh token in it", async () => {
    // An access token on its own dies in an hour, which would mean signing in
    // again every stream. That is not a sign-in.
    const g = google({ status: 200, body: { access_token: "at", expires_in: 3600 } });
    expect(await pollForToken(CLIENT, "d", g.post)).toMatchObject({ state: "refused" });
  });
});

describe("trading the refresh token for a working one", () => {
  it("asks with the refresh grant and dates the answer by our clock", async () => {
    const g = google({ status: 200, body: { access_token: "at", expires_in: 3600 } });

    const got = await refreshAccess(CLIENT, "rt", g.post, NOW);

    expect(g.asked[0]!.form).toMatchObject({ grant_type: "refresh_token", refresh_token: "rt" });
    expect(got).toEqual({ ok: true, value: { token: "at", expiresAt: NOW + 3_600_000 } });
  });

  it("marks a revoked grant as lost, which is the only failure that costs her the sign-in", async () => {
    const g = google({ status: 400, body: { error: "invalid_grant" } });
    const got = await refreshAccess(CLIENT, "rt", g.post, NOW);
    expect(got).toMatchObject({ ok: false, lost: true });
    expect((got as { reason: string }).reason).toContain("Sign in again");
  });

  it("does not lose the grant over a rate limit or a bad afternoon", async () => {
    // Everything that is not `invalid_grant` is worth pressing the button
    // again for, and must not make her type a code to recover from.
    const limited = google({ status: 429, body: { error: "rate_limit_exceeded" } });
    const broken = google({ status: 500, body: null });

    for (const post of [limited.post, broken.post, offline]) {
      const got = await refreshAccess(CLIENT, "rt", post, NOW);
      expect(got.ok).toBe(false);
      expect(got.lost).toBeFalsy();
    }
  });

  it("quotes Google's own description when it has nothing better", async () => {
    const g = google({
      status: 400,
      body: { error: "something_new", error_description: "Bad Request, in detail" },
    });
    expect(await refreshAccess(CLIENT, "rt", g.post, NOW)).toEqual({
      ok: false,
      reason: "Bad Request, in detail",
    });
  });
});
