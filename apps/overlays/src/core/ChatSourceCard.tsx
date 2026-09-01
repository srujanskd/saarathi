import { useState } from "react";
import {
  CORE_ACTIONS,
  type ChannelStats,
  type ChatView,
  type ChatWritesView,
  type ConnectionStatus,
} from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";
import { useInvoke } from "../lib/invoke.js";
import { Notice } from "./Notice.js";
import { countsLine } from "./counts.js";
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
    </section>
  );
}
