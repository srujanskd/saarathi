import { useEffect, useState } from "react";
import { WHEEL_ID, type WheelState } from "@saarathi/shared";
import { useModuleState } from "../../lib/connection.js";
import type { CardProps } from "../types.js";
import { phaseKicker, queueSummary, spinCaption } from "./caption.js";
import { linesOf, textOf } from "./challenges.js";

export function WheelCard({ connection, status }: CardProps) {
  const state = useModuleState<WheelState>(connection, WHEEL_ID);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => connection.serverNow());

  const spin = state?.spin ?? null;
  const startedAt = spin?.startedAt ?? null;

  // The last challenge stays on this page after the overlay has hidden it, so
  // the only clock we need is the one that flips "spinning" to "landed".
  useEffect(() => {
    if (startedAt === null) return;
    const tick = () => setNow(connection.serverNow());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [connection, startedAt]);

  const caption = spinCaption(spin, now);
  const queued = queueSummary(state?.queue ?? [], (state?.challenges.length ?? 0) > 0);
  const primary = status.actions.find((action) => action.id === "wheel.spin");
  const rest = status.actions.filter((action) => action !== primary);
  const challenges = state?.challenges ?? [];
  const editor = draft ?? textOf(challenges);

  async function run(action: string, args?: string[]): Promise<void> {
    setBusy(action);
    const result = await connection.invoke({ action, args });
    setBusy(null);
    setNotice(result.ok ? null : result.reason);
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
          {notice}
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

      {rest.length > 0 ? (
        <div className="btn-row">
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
        </div>
      ) : null}

      <details className="fold">
        <summary>
          {challenges.length === 1 ? "1 challenge" : `${challenges.length} challenges`}
        </summary>
        <label className="field">
          <span>One per line</span>
          <textarea
            className="textarea"
            data-testid="wheel-challenges"
            rows={Math.max(6, challenges.length + 1)}
            value={editor}
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="btn"
          data-testid="wheel-save"
          disabled={busy !== null}
          onClick={() => void run("wheel.setChallenges", linesOf(editor))}
        >
          Save challenges
        </button>
      </details>
    </section>
  );
}
