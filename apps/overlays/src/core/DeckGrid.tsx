import { useEffect, useState } from "react";
import type { DeckSlot } from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";
import { Notice, type NoticeText } from "./Notice.js";

/** Long enough to read at arm's length, short enough to be gone before she
 * needs the space back. Only a confirmation fades; a refusal stays. */
const CONFIRM_MS = 1_600;

/**
 * Her grid, as something to press.
 *
 * There is no `deck.press(n)`: a button *is* a saved action and its arguments,
 * so pressing one is this page invoking that action the way the control page
 * invokes any other. The server stores the grid and never dispatches from it,
 * which is what keeps a client holding a stale grid from pressing the wrong
 * thing by index.
 *
 * The page renders no module state at all -- it subscribes to none -- so the
 * only feedback a press can give is the server's own answer to it. That is why
 * a success says so out loud for a second: she is looking at this page and not
 * at the wheel, and a button with no visible result is a button she presses
 * twice.
 */
export function DeckGrid({
  connection,
  slots,
}: {
  connection: Connection;
  slots: DeckSlot[];
}) {
  const [note, setNote] = useState<NoticeText | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  useEffect(() => {
    if (!note?.ok) return;
    const timer = setTimeout(() => setNote(null), CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [note]);

  async function press(index: number, slot: DeckSlot): Promise<void> {
    setBusy(index);
    setNote(null);
    const result = await connection.invoke({ action: slot.action, args: slot.args });
    setBusy(null);
    // A confirmation says what she pressed: this page renders no module state,
    // so "Spin — done" is the whole of what she gets back.
    setNote(
      result.ok ? { text: `${slot.label} — done`, ok: true } : { text: result.reason, ok: false },
    );
  }

  if (slots.length === 0) {
    return (
      <p className="empty" data-testid="deck-empty">
        No buttons yet. Add some under <b>Deck</b> on the control page, below.
      </p>
    );
  }

  return (
    <>
      {note ? (
        <Notice notice={note} testId="deck-notice" onDismiss={() => setNote(null)} />
      ) : null}

      <div className="grid" data-testid="deck-grid">
        {slots.map((slot, index) => (
          // Position is the key, because a slot has no id: a save replaces the
          // whole grid, so "the third button" is the only thing that is stable
          // across one -- and it is stable for exactly as long as she is not
          // the one editing it.
          <button
            key={index}
            type="button"
            className="key"
            data-testid="deck-key"
            disabled={busy !== null}
            onClick={() => void press(index, slot)}
          >
            {slot.icon ? (
              <span className="key-icon" aria-hidden="true">
                {slot.icon}
              </span>
            ) : null}
            <span className="key-label">{slot.label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
