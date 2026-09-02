import { useEffect, useState } from "react";
import {
  CORE_ACTIONS,
  type ChannelStats,
  type ChatSignInView,
  type ChatView,
  type ChatWritesView,
  type ConnectionStatus,
} from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";
import { useInvoke, type Invoker } from "../lib/invoke.js";
import { Notice } from "./Notice.js";
import { countsLine } from "./counts.js";
import { codeExpiry } from "./signIn.js";
import { writesLine } from "./writes.js";

/**
 * Where she tells Saarathi which channel to read.
 *
 * A core card rather than a module card, on the same footing as OBS: the chat
 * adapters are a service every module shares through the event bus, and no
 * module owns one. It is rendered once per adapter that has anything to set up,
 * so mock chat -- always registered beside the real one -- never appears here.
 *
 * Every platform-specific word on it comes from the server: the title, and the
 * sentence saying where a channel id is found. That is the same rule that puts
 * `ChannelStats.detail` in the adapter, and it is what keeps this file from
 * knowing YouTube exists.
 *
 * The key is write-only by design. It is stored on the server and never sent
 * back, so a saved key shows as a placeholder, a blank field means "leave it
 * alone", and Forget key is the way out.
 */
export function ChatSourceCard({
  connection,
  name,
  view,
  status,
  stats,
  writes,
}: {
  connection: Connection;
  /** The adapter's name, which is what the two actions are addressed to. */
  name: string;
  view: ChatView;
  status: ConnectionStatus | undefined;
  stats: ChannelStats | undefined;
  /** The whole meter, not this adapter's share: it says whose it is itself. */
  writes: ChatWritesView;
}) {
  const invoke = useInvoke(connection);
  const [draft, setDraft] = useState<{ channelId: string; apiKey: string } | null>(null);

  const busy = invoke.working;
  // Same discipline as the OBS card and the challenge editor: a draft shadows
  // the server only while it exists, so one keystroke cannot freeze the field
  // against the next snapshot, and a refused save leaves her text where she can
  // fix it.
  const fields = draft ?? { channelId: view.channelId, apiKey: "" };
  const dirty = draft !== null;
  const counts = countsLine(stats);
  const written = writesLine(writes, name);

  const { run } = invoke;

  async function save(): Promise<void> {
    const args = [name, fields.channelId, fields.apiKey];
    if (await run(CORE_ACTIONS.chatSettings, args)) setDraft(null);
  }

  return (
    <section className="card" data-testid="chat-card">
      <h2>{view.title}</h2>
      <p className="hint" data-state={status?.state} data-testid="chat-status">
        {status?.detail ?? "Starting up"}
      </p>

      {invoke.notice ? (
        <Notice notice={invoke.notice} testId="chat-notice" onDismiss={invoke.dismiss} />
      ) : null}

      {counts ? (
        <p className="counts" data-testid="chat-counts">
          {counts}
        </p>
      ) : null}
      {written ? (
        <p className="hint" data-testid="chat-writes">
          {written}
        </p>
      ) : null}
      {stats?.detail ? (
        <p className="hint" data-testid="chat-counts-detail">
          {stats.detail}
        </p>
      ) : null}

      {/* Open until she has set a channel, because until then this is the only
          thing on the page worth doing. It folds itself away once she has. */}
      <details className="fold" open={!view.channelId}>
        <summary>
          <span data-testid="chat-where">
            {view.channelId ? `Reading ${view.channelId}` : "Not set up yet"}
          </span>
          {dirty ? (
            <span className="dirty" data-testid="chat-unsaved">
              unsaved
            </span>
          ) : null}
        </summary>

        <p className="hint">{view.hint}</p>

        <label className="field">
          <span>Channel</span>
          <input
            className="input"
            data-testid="chat-channel"
            value={fields.channelId}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder="UC… or the channel URL"
            onChange={(event) => setDraft({ ...fields, channelId: event.target.value })}
          />
        </label>
        <label className="field">
          <span>{view.hasKey ? "API key (saved — leave blank to keep it)" : "API key"}</span>
          <input
            className="input"
            type="password"
            data-testid="chat-key"
            value={fields.apiKey}
            autoComplete="off"
            onChange={(event) => setDraft({ ...fields, apiKey: event.target.value })}
          />
        </label>
        <p className="hint">
          The key is only for the subscriber and like counts. Chat works without one.
        </p>

        <button
          type="button"
          className="btn"
          data-testid="chat-save"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          Save
        </button>
        <button
          type="button"
          className="btn"
          data-testid="chat-revert"
          disabled={busy || !dirty}
          onClick={() => setDraft(null)}
        >
          Discard changes
        </button>
        <button
          type="button"
          className="btn"
          data-testid="chat-forget"
          disabled={busy || !view.hasKey}
          onClick={() => void run(CORE_ACTIONS.chatForgetKey, [name])}
        >
          Forget key
        </button>
      </details>

      {/* Under the channel and not above it, because that is the order she does
          them in: chat works with a channel and no sign-in, and the sign-in is
          what the bot needs to write back. Absent altogether for a platform
          that needs none, rather than present and saying so -- the same rule
          that keeps mock chat off this page. */}
      {view.signIn ? (
        <SignIn connection={connection} name={name} signIn={view.signIn} invoke={invoke} />
      ) : null}
    </section>
  );
}

/**
 * Signing the bot in, which is a code she reads here and types somewhere else.
 *
 * The code is state on the server rather than the result of the button she
 * pressed, and that is what makes this survivable: she reads it on her phone,
 * unlocks a laptop, types it into Google, and the page she left open finds out
 * it worked from the next patch. A tab that reconnects mid-sign-in rejoins the
 * same one, and a second page she opens shows the same code rather than
 * starting a rival sign-in.
 *
 * Every word about what a sign-in is for comes from the server, on the rule
 * that keeps this whole file from knowing YouTube exists.
 */
function SignIn({
  connection,
  name,
  signIn,
  invoke,
}: {
  connection: Connection;
  name: string;
  signIn: ChatSignInView;
  invoke: Invoker;
}) {
  const pending = signIn.pending;
  const [now, setNow] = useState(() => connection.serverNow());
  // Either she has pasted a complete credential, or the build carries one.
  const ready = signIn.builtIn || (signIn.clientId !== "" && signIn.hasClientSecret);

  // A clock only while a code is waiting, and it stops itself when the code
  // runs out: an interval still ticking is her phone re-rendering forever for
  // a number nobody is reading.
  useEffect(() => {
    if (!pending || connection.serverNow() >= pending.expiresAt) return;
    const id = setInterval(() => {
      const at = connection.serverNow();
      setNow(at);
      if (at >= pending.expiresAt) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [connection, pending]);

  const { run, working } = invoke;

  return (
    <div className="signin" data-granted={signIn.granted ? "yes" : "no"} data-testid="chat-signin">
      <p className="hint" data-testid="chat-signin-detail">
        {signIn.detail}
      </p>

      {/* Where the credential goes. In front of her on a build that carries
          none -- there it is the only way in -- and behind a fold on one that
          does, where it is an override for somebody who would rather not share
          a quota. One control, two levels of insistence. */}
      {signIn.builtIn ? (
        <details className="fold">
          <summary>
            <span>
              {signIn.clientId ? "Using her own Google project" : "Use her own Google project"}
            </span>
          </summary>
          <ClientFields name={name} signIn={signIn} invoke={invoke} />
        </details>
      ) : (
        <ClientFields name={name} signIn={signIn} invoke={invoke} />
      )}

      {pending ? (
        <>
          {/* The one thing on the page she has to copy by hand, so it is the
              biggest thing on it and it selects in one tap. */}
          <p className="signin-code" data-testid="chat-signin-code">
            {pending.code}
          </p>
          <p className="hint" data-testid="chat-signin-where">
            Type that in at {pending.url}
          </p>
          <p className="hint" data-testid="chat-signin-expiry">
            {codeExpiry(pending, now)}
          </p>
        </>
      ) : null}

      {/* Sign in again is offered on top of a grant she already has, because
          the reason to press it is a grant that has stopped working -- and
          that is a state the server cannot always tell her about in advance. */}
      {/* Nothing to sign in with is a button that can only refuse, so it is
          not offered -- the fields above are the thing to do instead. */}
      <button
        type="button"
        className="btn"
        disabled={working || !ready}
        data-testid="chat-signin-start"
        onClick={() => void run(CORE_ACTIONS.chatSignIn, [name])}
      >
        {pending ? "Start again with a new code" : signIn.granted ? "Sign in again" : "Sign in"}
      </button>
      {/* The way out exists exactly when there is something to get out of.
          Elsewhere on this card a button that has nothing to do is disabled
          rather than absent, which is right for one of them and wrong for a
          stack: a fresh install had four buttons here that could not be
          pressed, on the one card it lands on. */}
      {signIn.granted || pending ? (
        <button
          type="button"
          className="btn"
          disabled={working}
          data-testid="chat-signin-out"
          onClick={() => void run(CORE_ACTIONS.chatSignOut, [name])}
        >
          {pending ? "Cancel" : "Sign out"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Her own OAuth client, for the quota rather than for the secrecy.
 *
 * The reason to offer this at all is that Google's daily allowance belongs to
 * the project the credential came from: a credential the installer ships is a
 * pool every install draws on, and hers is an allowance nobody else can spend.
 * It is not a way of keeping anything secret -- whatever ships in the installer
 * is readable by anyone who has the installer.
 *
 * The id is echoed back and the secret is not, on the same split as her channel
 * and her API key: an id is public, Google prints it on the consent screen, and
 * reading it back is how she checks which of the two boxes she pasted where.
 */
function ClientFields({
  name,
  signIn,
  invoke,
}: {
  name: string;
  signIn: ChatSignInView;
  invoke: Invoker;
}) {
  const [draft, setDraft] = useState<{ clientId: string; clientSecret: string } | null>(null);
  // Same discipline as every other field on this card: a draft shadows the
  // server only while it exists, so one keystroke cannot freeze the box
  // against the next snapshot and a refused save leaves her text to fix.
  const fields = draft ?? { clientId: signIn.clientId, clientSecret: "" };
  const dirty = draft !== null;
  const { run, working } = invoke;

  return (
    <div className="client-fields" data-testid="chat-client">
      <p className="hint">{signIn.clientHint}</p>

      <label className="field">
        <span>Client ID</span>
        <input
          className="input"
          data-testid="chat-client-id"
          value={fields.clientId}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          placeholder="…apps.googleusercontent.com"
          onChange={(event) => setDraft({ ...fields, clientId: event.target.value })}
        />
      </label>
      <label className="field">
        <span>
          {signIn.hasClientSecret ? "Client secret (saved — leave blank to keep it)" : "Client secret"}
        </span>
        <input
          className="input"
          type="password"
          data-testid="chat-client-secret"
          value={fields.clientSecret}
          autoComplete="off"
          onChange={(event) => setDraft({ ...fields, clientSecret: event.target.value })}
        />
      </label>

      <button
        type="button"
        className="btn"
        data-testid="chat-client-save"
        disabled={working || !dirty}
        onClick={() => {
          void (async () => {
            const args = [name, fields.clientId, fields.clientSecret];
            if (await run(CORE_ACTIONS.chatClient, args)) setDraft(null);
          })();
        }}
      >
        Save
      </button>
      {/* The way out, offered once there is something to get out of. On a
          build with a credential of its own it puts that one back; on a build
          without, it puts her back to no sign-in. */}
      {signIn.clientId || signIn.hasClientSecret ? (
        <button
          type="button"
          className="btn"
          data-testid="chat-client-forget"
          disabled={working}
          onClick={() => void run(CORE_ACTIONS.chatForgetClient, [name])}
        >
          {signIn.builtIn ? "Use the built-in one" : "Forget it"}
        </button>
      ) : null}
    </div>
  );
}
