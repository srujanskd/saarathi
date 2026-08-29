import { useState } from "react";
import type { DeckSlot, DeckView, ModuleStatus } from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";
import {
  actionChoices,
  append,
  describeAction,
  editAt,
  encodeGrid,
  gridNote,
  move,
  removeAt,
  sameGrid,
} from "./deckDraft.js";

/**
 * Where she says what is on her deck.
 *
 * A core card, not a module card, for the reason the OBS one is: every surface
 * renders the grid and no module owns it. The grid itself is `deck.html`; this
 * is the only place it is edited, because the deck is the page she uses while
 * she cannot look at it properly.
 *
 * There is no argument field anywhere on it. The picker offers actions that
 * take none, and a button that needs one -- an OBS scene, today -- is added
 * from the card that already knows the answer. Asking her to type an argument
 * is the no-terminal rule failing in a different costume.
 */
export function DeckCard({
  connection,
  deck,
  modules,
  href,
}: {
  connection: Connection;
  deck: DeckView;
  modules: ModuleStatus[];
  /** Where `deck.html` is from here, carrying whatever `?server=` this page
   * was given. */
  href: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<DeckSlot[] | null>(null);
  const [picked, setPicked] = useState("");

  const groups = actionChoices(modules);

  // The server owns the grid. A draft is what she has arranged and not yet
  // saved, so it shadows the server only while it exists -- otherwise one
  // keystroke would freeze this list against every later snapshot, including
  // the scene button she adds from the OBS card a moment later.
  const slots = draft ?? deck.slots;
  const unsaved = draft !== null && !sameGrid(draft, deck.slots);

  async function run(action: string, args?: string[]): Promise<boolean> {
    setBusy(true);
    setNotice(null);
    const result = await connection.invoke({ action, args });
    setBusy(false);
    if (!result.ok) setNotice(result.reason);
    return result.ok;
  }

  async function save(): Promise<void> {
    // Dropped only on the way through: a refused save has to leave her grid
    // where she can fix it, and the notice says what was wrong with it.
    if (await run("core.deckSet", [encodeGrid(slots)])) setDraft(null);
  }

  function add(): void {
    const chosen = groups.flatMap((group) => group.actions).find((action) => action.id === picked);
    if (!chosen) return;
    // Her own words start as the module's words, which is a label that already
    // reads correctly on a button. Blank is the one thing the server refuses.
    setDraft(append(slots, { action: chosen.id, args: [], label: chosen.label, icon: "" }));
    setPicked("");
  }

  return (
    <section className="card" data-testid="deck-card">
      <h2>Deck</h2>
      <p className="hint">
        Her buttons, full screen: <a href={href}>open the deck</a>. Add it to the home screen of
        whatever she props next to her.
      </p>

      {notice ? (
        <p className="notice" data-testid="deck-editor-notice">
          <span>{notice}</span>
          <button
            type="button"
            className="dismiss"
            aria-label="Dismiss"
            data-testid="deck-editor-notice-dismiss"
            onClick={() => setNotice(null)}
          >
            ×
          </button>
        </p>
      ) : null}

      <details className="fold">
        <summary>
          <span data-testid="deck-count">{gridNote(slots.length)}</span>
          {unsaved ? (
            <span className="dirty" data-testid="deck-unsaved">
              unsaved
            </span>
          ) : null}
        </summary>

        {slots.length === 0 ? (
          <p className="empty" data-testid="deck-editor-empty">
            Nothing on the deck yet.
          </p>
        ) : (
          <ul className="slots" data-testid="deck-slots">
            {slots.map((slot, index) => {
              const does = describeAction(slot, groups);
              return (
              // Position is the key because a slot has no id -- a save replaces
              // the whole grid, the way her challenge list is replaced.
              <li className="slot" key={index} data-testid="deck-slot">
                <div className="slot-head">
                    <input
                      className="input slot-icon"
                      data-testid="deck-slot-icon"
                      aria-label={`Icon for ${slot.label}`}
                      value={slot.icon}
                      // One emoji. Not enforced past this: a two-character
                      // symbol she likes is not worth a refusal, and the button
                      // clamps what it draws anyway.
                      maxLength={4}
                      autoComplete="off"
                      onChange={(event) => setDraft(editAt(slots, index, { icon: event.target.value }))}
                    />
                    <input
                      className="input slot-label"
                      data-testid="deck-slot-label"
                      aria-label={`Label for button ${index + 1}`}
                      value={slot.label}
                      autoComplete="off"
                      onChange={(event) => setDraft(editAt(slots, index, { label: event.target.value }))}
                    />
                </div>
                <div className="slot-foot">
                  {/* Only when it adds something. A button she has not renamed
                      says the module's own words twice otherwise, and the row
                      she does need to read -- the scene one -- gets lost among
                      the ones that are just repeating themselves. */}
                  <p className="slot-does" data-testid="deck-slot-does">
                    {does === slot.label ? "" : does}
                  </p>
                  <button
                    type="button"
                    className="tool"
                    data-tool="up"
                    data-testid="deck-slot-up"
                    aria-label={`Move ${slot.label} up`}
                    disabled={busy || index === 0}
                    onClick={() => setDraft(move(slots, index, index - 1))}
                  >
                    ▲
                  </button>
                  <button
                    type="button"
                    className="tool"
                    data-tool="down"
                    data-testid="deck-slot-down"
                    aria-label={`Move ${slot.label} down`}
                    disabled={busy || index === slots.length - 1}
                    onClick={() => setDraft(move(slots, index, index + 1))}
                  >
                    ▼
                  </button>
                  <button
                    type="button"
                    className="tool"
                    data-tool="remove"
                    data-testid="deck-slot-remove"
                    aria-label={`Remove ${slot.label}`}
                    disabled={busy}
                    onClick={() => setDraft(removeAt(slots, index))}
                  >
                    ×
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
        )}

        <div className="add-row">
          <label className="field">
            <span>Add a button</span>
            <select
              className="select"
              data-testid="deck-add-action"
              value={picked}
              onChange={(event) => setPicked(event.target.value)}
            >
              <option value="">Choose an action…</option>
              {groups.map((group) => (
                <optgroup key={group.title} label={group.title}>
                  {group.actions.map((action) => (
                    <option key={action.id} value={action.id}>
                      {action.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn"
            data-testid="deck-add"
            disabled={busy || !picked}
            onClick={() => add()}
          >
            Add
          </button>
        </div>

        <button
          type="button"
          className="btn"
          data-testid="deck-save"
          disabled={busy || !unsaved}
          onClick={() => void save()}
        >
          Save deck
        </button>
        <button
          type="button"
          className="btn"
          data-testid="deck-revert"
          disabled={busy || draft === null}
          onClick={() => setDraft(null)}
        >
          Discard changes
        </button>
      </details>
    </section>
  );
}
