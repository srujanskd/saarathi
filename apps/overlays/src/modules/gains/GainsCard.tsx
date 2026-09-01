import { useState } from "react";
import {
  GAINS,
  GAINS_ID,
  MAX_PER_MINUTE,
  type BoardRow,
  type GainsState,
} from "@saarathi/shared";
import { Notice } from "../../core/Notice.js";
import { addToDeck } from "../../core/addToDeck.js";
import { useModuleState } from "../../lib/connection.js";
import { useInvoke } from "../../lib/invoke.js";
import type { CardProps } from "../types.js";
import { rowSummary } from "./rank.js";
import "./gains-card.css";

/** What one tap of the give button is worth. Two sizes, because she is doing
 * this with a thumb between sets and a number pad is not the tool for it. */
const HANDOUTS = [50, 250] as const;

export function GainsCard({ connection, deck, status }: CardProps) {
  const state = useModuleState<GainsState>(connection, GAINS_ID);
  const invoke = useInvoke(connection);
  const [rate, setRate] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);

  const board = state?.board ?? [];
  const perMinute = state?.perMinute ?? 0;
  const busy = invoke.working;
  const { run } = invoke;

  async function saveRate(): Promise<void> {
    if (rate === null) return;
    if (await run(`${GAINS_ID}.rate`, [rate])) setRate(null);
  }

  /** A give button for one viewer, onto the grid she is looking at. See
   * `addToDeck`. */
  async function addGiveToDeck(row: BoardRow): Promise<void> {
    await addToDeck(deck, invoke, {
      action: `${GAINS_ID}.give`,
      args: [row.id, String(HANDOUTS[0])],
      label: row.name,
      icon: "💪",
    });
  }

  return (
    <section className="card" data-testid="gains-card">
      <h2>{status.title}</h2>

      {invoke.notice ? (
        <Notice notice={invoke.notice} testId="gains-notice" onDismiss={invoke.dismiss} />
      ) : null}

      <p className="hint" data-testid="gains-rate-now">
        {perMinute === 0
          ? `Nobody is earning ${GAINS.plural} right now`
          : `${perMinute} ${GAINS.plural} a minute to everyone who has chatted recently`}
      </p>

      {board.length === 0 ? (
        <p className="empty" data-testid="gains-empty">
          Nobody has earned anything yet. It fills up as chat talks.
        </p>
      ) : (
        <ol className="board-rows-card" data-testid="gains-rows">
          {board.map((row, index) => (
            <li key={row.id} className="board-row-card">
              <p className="board-row-card-top">
                <span>
                  <span className="board-row-card-place">{index + 1}</span>
                  {row.name}
                </span>
              </p>
              <p className="hint">{rowSummary(row)}</p>

              <div className="board-row-card-tools">
                {HANDOUTS.map((amount) => (
                  <button
                    key={`give-${amount}`}
                    type="button"
                    className="tool"
                    disabled={busy}
                    data-testid="gains-give"
                    onClick={() => void run(`${GAINS_ID}.give`, [row.id, String(amount)])}
                  >
                    +{amount}
                  </button>
                ))}
                {/* One hand-back per hand-out, not one for the smaller of
                    them: a double-tapped +250 that only comes off 50 at a time
                    is five taps to undo one mistake, and with a thumb between
                    sets the tap that lands twice is the normal case. */}
                {HANDOUTS.map((amount) => (
                  <button
                    key={`take-${amount}`}
                    type="button"
                    className="tool"
                    disabled={busy || row.balance < amount}
                    data-testid="gains-take"
                    onClick={() => void run(`${GAINS_ID}.give`, [row.id, String(-amount)])}
                  >
                    −{amount}
                  </button>
                ))}
                <button
                  type="button"
                  className="tool"
                  disabled={busy}
                  onClick={() => void addGiveToDeck(row)}
                >
                  On the deck
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <details className="fold">
        <summary>
          <span>Settings</span>
          {rate !== null ? (
            <span className="dirty" data-testid="gains-unsaved">
              unsaved
            </span>
          ) : null}
        </summary>

        <label className="field">
          <span>{GAINS.plural} an active minute</span>
          <input
            className="input"
            data-testid="gains-rate"
            // A number pad rather than a keyboard: she is doing this on a phone.
            inputMode="numeric"
            value={rate ?? String(perMinute)}
            placeholder={String(MAX_PER_MINUTE)}
            onChange={(event) => setRate(event.target.value)}
          />
        </label>

        <button
          type="button"
          className="btn btn-primary"
          data-testid="gains-rate-save"
          disabled={busy || rate === null}
          onClick={() => void saveRate()}
        >
          Save rate
        </button>
        {rate !== null ? (
          <button type="button" className="btn" disabled={busy} onClick={() => setRate(null)}>
            Discard
          </button>
        ) : null}

        {/* Two taps, because it zeroes every balance on the board and there is
            no undo for it. The second button says what it does rather than
            asking "are you sure" about something she has stopped reading. */}
        {clearing ? (
          <>
            <button
              type="button"
              className="btn"
              data-tool="remove"
              disabled={busy}
              data-testid="gains-clear-confirm"
              onClick={async () => {
                if (await run(`${GAINS_ID}.clear`, [])) setClearing(false);
              }}
            >
              Yes, take everyone back to zero
            </button>
            <button type="button" className="btn" onClick={() => setClearing(false)}>
              Keep the board
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy || board.length === 0}
            data-testid="gains-clear"
            onClick={() => setClearing(true)}
          >
            Start the board again
          </button>
        )}
      </details>
    </section>
  );
}
