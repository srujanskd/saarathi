import { useEffect, useState } from "react";
import { WHEEL_ID, type WheelState } from "@saarathi/shared";
import { useModuleState } from "../../lib/connection.js";
import type { CardProps } from "../types.js";
import { phaseKicker, queueSummary, spinCaption } from "./caption.js";
import { countLabel, toLines, toText } from "./challenges.js";

export function WheelCard({ connection, status }: CardProps) {
  const state = useModuleState<WheelState>(connection, WHEEL_ID);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => connection.serverNow());

  const spin = state?.spin ?? null;
  const endsAt = spin ? spin.startedAt + spin.durationMs : null;

  // The last challenge stays on this page after the overlay has hidden it, so
  // the only thing this clock decides is when "spinning" becomes "landed".
  // Once it has decided, it stops: an interval that keeps ticking is her phone
  // re-rendering forever for a number nothing reads.
  useEffect(() => {
    if (endsAt === null || connection.serverNow() >= endsAt) return;
    const id = setInterval(() => {
      const at = connection.serverNow();
      setNow(at);
      if (at >= endsAt) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [connection, endsAt]);

  const caption = spinCaption(spin, now);
  const queue = state?.queue ?? [];
  const challenges = state?.challenges ?? [];
  const queued = queueSummary(queue.length, queue[0]?.by ?? "", challenges.length > 0);
  const primary = status.actions.find((action) => action.id === "wheel.spin");
  const rest = status.actions.filter((action) => action !== primary);

  // The server owns the list. A draft is what she has typed and not yet saved,
  // so it shadows the server only while it exists -- and it stops existing the
  // moment it is saved or dropped. Without that, one keystroke would freeze
  // this textarea against every later snapshot, deck save, and reconnect.
  const saved = toText(challenges);
  const editor = draft ?? saved;
  const unsaved = draft !== null && draft !== saved;
  const drafted = toLines(editor);

  /** Fires an action and reports whether the server took it. The notice is
   * cleared on the way in as well as set on the way out, so a refusal she has
   * already dealt with does not sit on the card forever. */
  async function run(action: string, args?: string[]): Promise<boolean> {
    setBusy(action);
    setNotice(null);
    const result = await connection.invoke({ action, args });
    setBusy(null);
    if (!result.ok) setNotice(result.reason);
    return result.ok;
  }

  async function save(): Promise<void> {
    // The draft is dropped only on the way through. A refused save has to
    // leave her text where she can fix it, and the notice says why.
    if (await run("wheel.setChallenges", drafted)) setDraft(null);
  }

  return (
    <section className="card" data-testid="wheel-card">
      <h2>{status.title}</h2>
      <p className="caption" data-phase={caption.phase} data-testid="wheel-result">
        <span className="kicker">{phaseKicker(caption)}</span>
        <span className="caption-label">{caption.label}</span>
        {caption.by ? <span className="caption-by">{caption.by}</span> : null}
      </p>
      {queued ? (
        <p className="queue-line" data-testid="wheel-queue">
          {queued}
        </p>
      ) : null}
      {notice ? (
        <p className="notice" data-testid="wheel-notice">
          <span>{notice}</span>
          <button
            type="button"
            className="dismiss"
            aria-label="Dismiss"
            data-testid="wheel-notice-dismiss"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </p>
      ) : null}

      {primary ? (
        <button
          type="button"
          className="btn btn-primary"
          data-testid="wheel-spin"
          disabled={busy !== null}
          onClick={() => void run(primary.id)}
        >
          {primary.label}
        </button>
      ) : null}

      {rest.map((action) => (
        <button
          key={action.id}
          type="button"
          className="btn"
          data-testid={action.id.replace(".", "-")}
          disabled={busy !== null}
          onClick={() => void run(action.id)}
        >
          {action.label}
        </button>
      ))}

      <details className="fold">
        <summary>
          <span data-testid="wheel-count">{countLabel(drafted.length)}</span>
          {unsaved ? <span className="dirty" data-testid="wheel-unsaved">unsaved</span> : null}
        </summary>
        <label className="field">
          <span>One per line</span>
          <textarea
            className="textarea"
            data-testid="wheel-challenges"
            rows={Math.max(6, drafted.length + 1)}
            value={editor}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn"
          data-testid="wheel-save"
          disabled={busy !== null || !unsaved}
          onClick={() => void save()}
        >
          Save challenges
        </button>
        <button
          type="button"
          className="btn"
          data-testid="wheel-revert"
          disabled={busy !== null || draft === null}
          onClick={() => setDraft(null)}
        >
          Discard changes
        </button>
      </details>
    </section>
  );
}
