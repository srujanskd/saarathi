import { useState } from "react";
import {
  CORE_ACTIONS,
  GAINS,
  GAINS_ID,
  MAX_PER_MINUTE,
  type BoardRow,
  type GainsState,
} from "@saarathi/shared";
import { Notice } from "../../core/Notice.js";
import { appendSlot, encodeGrid } from "../../core/deckDraft.js";
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

  /**
   * A give button for one viewer, onto the grid she is looking at. Same
   * arrangement as the goals card's "+1" and for the same reason: the action
   * needs an argument, the argument is somebody she is already looking at, and
   * the deck's own picker never asks her to type one.
   */
  async function addToDeck(row: BoardRow): Promise<void> {
    const next = appendSlot(deck.slots, {
      action: `${GAINS_ID}.give`,
      args: [row.id, String(HANDOUTS[0])],
      label: row.name,
      icon: "💪",
    });
    if (deck.editing) {
      deck.set(next);
      invoke.say(`${row.name} added to the deck you are editing — Save deck to keep it`);
      return;
    }
    if (await run(CORE_ACTIONS.deckSet, [encodeGrid(next)])) deck.discard();
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
                    key={amount}
                    type="button"
                    className="tool"
                    disabled={busy}
                    data-testid="gains-give"
                    onClick={() => void run(`${GAINS_ID}.give`, [row.id, String(amount)])}
                  >
                    +{amount}
                  </button>
                ))}
                {/* The way back out of a tap that landed twice, which with a
                    thumb between sets is the normal case and not the odd one. */}
                <button
                  type="button"
                  className="tool"
                  disabled={busy || row.balance < HANDOUTS[0]}
                  data-testid="gains-take"
                  onClick={() =>
                    void run(`${GAINS_ID}.give`, [row.id, String(-HANDOUTS[0])])
                  }
                >
                  −{HANDOUTS[0]}
                </button>
                <button
                  type="button"
                  className="tool"
                  disabled={busy}
                  onClick={() => void addToDeck(row)}
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
