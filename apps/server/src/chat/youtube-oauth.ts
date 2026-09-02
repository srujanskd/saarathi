/**
 * Google's OAuth device flow, as far as it can be decided without state.
 *
 * Separate from the adapter for the reason `youtube-stats.ts` is: which URL to
 * ask, what each documented answer means, and what to tell her when Google says
 * no are all decisions, all reachable from a unit test with no browser and no
 * Google account, and all the sort of thing that is wrong in a way a live run
 * will not show you until she is streaming.
 *
 * Nothing here holds a token. `YouTubeGrant` does that.
 */

const DEVICE_ENDPOINT = "https://oauth2.googleapis.com/device/code";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/**
 * The one scope we ask for, and it has to be this one.
 *
 * `youtube.force-ssl` is what every tutorial reaches for and what most of the
 * live-chat examples on the internet use. It is **not** on Google's allowed
 * list for the device flow, and asking for it fails the very first call with a
 * message that mentions the scope and says nothing at all about device codes --
 * which is an afternoon to work out and no time to fix. Plain `youtube` is
 * allowed there, and all three of the writes we make accept either.
 *
 * One scope rather than several: everything the bot does is a write to her
 * live chat, and there is nothing narrower on offer that covers a ban.
 */
export const YOUTUBE_SCOPE = "https://www.googleapis.com/auth/youtube";

/**
 * The app's own OAuth credential.
 *
 * Compiled in, which reads like a straight contradiction of the API key rule
 * two paragraphs down in AGENTS and is not one. A device-flow client is a
 * "TVs and Limited Input devices" client: RFC 8252 §8.5 says a native app
 * cannot keep a secret and that such a credential is therefore not
 * confidential, Google issues it on those terms, and it grants nothing on its
 * own -- every token it can ever produce needs her to type a code into her own
 * Google account first. The alternative is asking a non-technical person to
 * create a Google Cloud project, which is the terminal rule in a different
 * costume.
 *
 * The consequence, and it is a real one: quota is per project, so every install
 * draws on the same pool. Fine for one streamer, and the reason a local counter
 * cannot see the whole of it -- see `quotaExceeded` in `youtube-writes.ts`.
 *
 * PKCE does not appear here because the device flow has no redirect to
 * intercept; the device code plays that part. The handoff's note about it
 * belongs to the loopback flow we decided against.
 */
export interface OAuthClient {
  id: string;
  secret: string;
}

/**
 * The credential this build carries, if it carries one.
 *
 * Blank in the repo, and substituted at build time rather than committed: the
 * repo is public, and a secret in it is a secret on the internet. Written as
 * `process.env` reads so esbuild's `define` can replace them in the bundle,
 * which also means a dev run picks them up from a real environment for free.
 *
 * Blank is a supported state, not a broken one. With nothing here she signs in
 * with a credential of her own, and the card says so; with something here hers
 * becomes an override. Neither case needs a code change, which is why this is
 * the fallback rather than the only source.
 */
const COMPILED: OAuthClient = {
  id: process.env.GOOGLE_CLIENT_ID ?? "",
  secret: process.env.GOOGLE_CLIENT_SECRET ?? "",
};

/** What this build carries, or null when it carries nothing. */
export function oauthClient(env?: NodeJS.ProcessEnv): OAuthClient | null {
  return credential(
    env?.GOOGLE_CLIENT_ID ?? COMPILED.id,
    env?.GOOGLE_CLIENT_SECRET ?? COMPILED.secret,
  );
}

/**
 * A credential out of two stored strings, or null when it is not a pair.
 *
 * The one place that decides what "complete" means, because three callers ask:
 * the build's own, hers, and the card's `ownClient` flag. Half a credential is
 * treated as none -- it can only fail, and failing on the first request would
 * tell her nothing about which half she is missing.
 */
export function credential(id: string, secret: string): OAuthClient | null {
  const trimmedId = id.trim();
  const trimmedSecret = secret.trim();
  return trimmedId && trimmedSecret ? { id: trimmedId, secret: trimmedSecret } : null;
}

/** How a Google client id ends, and nothing else is one. */
const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

/**
 * Where she gets a credential of her own, in one sentence.
 *
 * Here rather than on her card for the reason `WHERE` is: which console, and
 * which of the several client types, is a fact about Google.
 */
export const CLIENT_WHERE =
  "In the Google Cloud console: APIs & Services \u2192 Credentials \u2192 Create credentials \u2192 OAuth client ID, and pick \u201cTVs and Limited Input devices\u201d.";

/**
 * What is wrong with what she pasted into the client id box, or null.
 *
 * She is going to paste the API key in here at least once -- the two live one
 * card apart and both look like a long opaque string -- and the failure without
 * this check is a sign-in that refuses with Google's words about an invalid
 * client, which names neither box. So it is refused before anything is written,
 * exactly as a mistyped channel id is.
 */
export function clientIdProblem(id: string): string | null {
  const text = id.trim();
  if (text === "") return "Paste the client ID as well as the secret.";
  if (text.endsWith(CLIENT_ID_SUFFIX)) return null;
  if (text.startsWith("AIza")) {
    return "That is a YouTube API key, not an OAuth client ID. The key goes in the box above.";
  }
  if (text.startsWith("GOCSPX-")) {
    return "That is the client secret, not the client ID. They are the other way round.";
  }
  return `A client ID ends in ${CLIENT_ID_SUFFIX}. ${CLIENT_WHERE}`;
}

/** What she has to do, and how long she has to do it. */
export interface DeviceCode {
  /** Ours, and the thing we poll with. Never shown to her. */
  deviceCode: string;
  /** Hers to type. Short, and Google formats it with a dash in the middle. */
  userCode: string;
  /** Where she types it. */
  url: string;
  /** Server time the code stops working. See `Snapshot.serverNow`. */
  expiresAt: number;
  /** How long to wait between polls. Google says five seconds; it may raise it. */
  intervalMs: number;
}

export interface FormResponse {
  status: number;
  /** Parsed JSON, or null when there was none to parse. */
  body: unknown;
}

/**
 * One form POST, injected so every branch here is testable without a network.
 * A throw means we could not reach Google, which is a different sentence from
 * Google saying no.
 */
export type FormPost = (url: string, form: Record<string, string>) => Promise<FormResponse>;

/** Either the thing, or one sentence she can act on. Never both. */
export type Attempt<T> = { ok: true; value: T } | { ok: false; reason: string };

const REACH = "Could not reach Google. Check the internet and try again.";

/**
 * Ask Google for a code for her to type.
 *
 * The clock is ours rather than Google's `expires_in`, for the reason every
 * other timestamp in this app is server time: her page is on a phone whose
 * clock is routinely tens of seconds out, and it renders how long she has left.
 */
export async function requestDeviceCode(
  client: OAuthClient,
  post: FormPost,
  now: number,
): Promise<Attempt<DeviceCode>> {
  const answer = await post(DEVICE_ENDPOINT, {
    client_id: client.id,
    scope: YOUTUBE_SCOPE,
  }).catch(() => null);
  if (!answer) return { ok: false, reason: REACH };

  const body = asRecord(answer.body);
  if (answer.status !== 200) {
    return { ok: false, reason: signInRefusal(body) };
  }

  const deviceCode = str(body.device_code);
  const userCode = str(body.user_code);
  // Google sends `verification_url`; the RFC calls it `verification_uri`. Both
  // are read because the one we are handed is the one she has to visit, and
  // guessing it would be a URL she cannot sign in at.
  const url = str(body.verification_url) || str(body.verification_uri);
  if (!deviceCode || !userCode || !url) {
    return { ok: false, reason: "Google sent back a sign-in we could not read." };
  }

  const seconds = num(body.expires_in) ?? 900;
  const interval = num(body.interval) ?? 5;
  return {
    ok: true,
    value: {
      deviceCode,
      userCode,
      url,
      expiresAt: now + seconds * 1000,
      intervalMs: Math.max(1, interval) * 1000,
    },
  };
}

/**
 * Where one poll leaves us.
 *
 * `waiting` and `slower` are the normal case, not the error case: the whole
 * flow is a loop that expects to be told to keep waiting while she finds her
 * phone. Only `done` and a refusal end it.
 */
export type Poll =
  | { state: "done"; refreshToken: string }
  | { state: "waiting" }
  | { state: "slower" }
  | { state: "refused"; reason: string };

/**
 * One poll of the token endpoint.
 *
 * A network failure answers `waiting` rather than refusing. Her Wi-Fi dropping
 * for four seconds in the middle of a sign-in is not her being denied, and
 * throwing the sign-in away for it would mean she types the code again for
 * nothing. The code's own expiry is what ends the loop.
 */
export async function pollForToken(
  client: OAuthClient,
  deviceCode: string,
  post: FormPost,
): Promise<Poll> {
  const answer = await post(TOKEN_ENDPOINT, {
    client_id: client.id,
    client_secret: client.secret,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  }).catch(() => null);
  if (!answer) return { state: "waiting" };

  const body = asRecord(answer.body);
  if (answer.status === 200) {
    const refreshToken = str(body.refresh_token);
    // No refresh token means an access token that dies in an hour and a sign-in
    // she would have to repeat every stream, which is not a sign-in.
    if (!refreshToken) {
      return { state: "refused", reason: "Google did not send a lasting sign-in. Try again." };
    }
    return { state: "done", refreshToken };
  }

  switch (str(body.error)) {
    case "authorization_pending":
      return { state: "waiting" };
    case "slow_down":
      return { state: "slower" };
    case "access_denied":
      return { state: "refused", reason: "Sign-in was turned down. Nothing has changed." };
    case "expired_token":
      return { state: "refused", reason: "That code ran out. Start the sign-in again." };
    default:
      return { state: "refused", reason: signInRefusal(body) };
  }
}

/** An access token and when it stops working. Held in memory, never saved. */
export interface Access {
  token: string;
  /** Server time. Refreshed before this, not after. */
  expiresAt: number;
}

/**
 * How early to refresh, so a write never carries a token that expires in
 * flight. Google's are an hour long, so a minute costs nothing.
 */
export const REFRESH_MARGIN_MS = 60_000;

/**
 * Trade the stored refresh token for a working access token.
 *
 * `lost` is the fact the caller has to act on and the reason this does not just
 * answer with a sentence: `invalid_grant` means the grant is gone for good --
 * she revoked it in her Google account, or it expired -- so the stored token has
 * to be thrown away and she has to be offered the button again. Every other
 * refusal is worth retrying and must not cost her a sign-in.
 */
export async function refreshAccess(
  client: OAuthClient,
  refreshToken: string,
  post: FormPost,
  now: number,
): Promise<Attempt<Access> & { lost?: boolean }> {
  const answer = await post(TOKEN_ENDPOINT, {
    client_id: client.id,
    client_secret: client.secret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  }).catch(() => null);
  if (!answer) return { ok: false, reason: REACH };

  const body = asRecord(answer.body);
  if (answer.status === 200) {
    const token = str(body.access_token);
    if (!token) return { ok: false, reason: "Google sent back no access token." };
    return { ok: true, value: { token, expiresAt: now + (num(body.expires_in) ?? 3600) * 1000 } };
  }

  if (str(body.error) === "invalid_grant") {
    return {
      ok: false,
      lost: true,
      reason: "Her Google sign-in is no longer valid. Sign in again to let the bot write.",
    };
  }
  return { ok: false, reason: signInRefusal(body) };
}

/**
 * What to tell her about a sign-in Google refused.
 *
 * `invalid_client` gets its own sentence because it is the one failure here
 * that is ours rather than hers: it means the credential this build was
 * compiled with is wrong or has been deleted, and nothing she does on her phone
 * can fix it. Telling her to try again would be a loop.
 */
function signInRefusal(body: Record<string, unknown>): string {
  const error = str(body.error);
  const described = str(body.error_description);
  switch (error) {
    case "invalid_client":
    case "unauthorized_client":
      return "This build's Google sign-in is not set up correctly. That is a bug, not something she can fix.";
    case "invalid_scope":
      // The force-ssl trap. Worth its own words, because the message Google
      // sends says nothing about the device flow.
      return "Google refused the permissions this build asked for. That is a bug, not something she can fix.";
    case "rate_limit_exceeded":
      return "Google is rate limiting sign-ins right now. Try again in a minute.";
    default:
      return described || (error ? `Google refused the sign-in (${error}).` : "Google refused the sign-in.");
  }
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * The one impure function here: a real form POST with a clock on it.
 *
 * The rejection is replaced rather than passed on, for the reason `httpGet`
 * replaces its own: the form carries her refresh token and the client secret,
 * and a thrown error is the one string here that travels into a log.
 */
export async function httpForm(url: string, form: Record<string, string>): Promise<FormResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => {
    throw new Error("Could not reach Google");
  });
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}
