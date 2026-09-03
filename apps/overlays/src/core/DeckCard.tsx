import { useState } from "react";
import { CORE_ACTIONS, type ModuleStatus } from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";
import { useInvoke } from "../lib/invoke.js";
import { Notice } from "./Notice.js";
import {
  actionChoices,
  appendSlot,
  deckSizeNote,
  describeAction,
  editSlot,
  encodeGrid,
  findAction,
  hotkeyChoices,
  moveSlot,
  removeSlot,
  setHotkey,
} from "./deckDraft.js";
import type { DeckDraft } from "./useDeckDraft.js";

/**
 * Where she says what is on her deck.
 *
 * A core card, not a module card, for the reason the OBS one is: every surface
 * renders the grid and no module owns it. The grid itself is `deck.html`; this
 * is the only place it is edited, because the deck is the page she uses while
 * she cannot look at it properly.
 *
 * There is no argument field anywhere on it. The picker offers actions that
 * take none -- which is what `ModuleStatus.actions` means, enforced on the
 * server by `needsArgs` -- and a button that needs one, an OBS scene today, is
 * added from the card that already knows the answer. Asking her to type an
 * argument is the no-terminal rule failing in a different costume.
 */
export function DeckCard({
  connection,
  deck,
  modules,
  href,
}: {
  connection: Connection;
  /** Shared with the OBS card, which also writes buttons. */
  deck: DeckDraft;
  modules: ModuleStatus[];
  /** Where `deck.html` is from here, carrying whatever `?server=` this page
   * was given. */
  href: string;
}) {
  const invoke = useInvoke(connection);
  const [picked, setPicked] = useState("");

  const groups = actionChoices(modules);
  const slots = deck.slots;
  const busy = invoke.working;

  async function save(): Promise<void> {
    // Dropped only on the way through: a refused save has to leave her grid
    // where she can fix it, and the notice says what was wrong with it.
    if (await invoke.run(CORE_ACTIONS.deckSet, [encodeGrid(slots)])) deck.discard();
  }

  function add(): void {
    const chosen = findAction(groups, picked);
    if (!chosen) return;
    // Her own words start as the module's words, which is a label that already
    // reads correctly on a button. Blank is the one thing the server refuses.
    deck.set(appendSlot(slots, { action: chosen.id, args: [], label: chosen.label, icon: "" }));
    setPicked("");
  }

  return (
    <section className="card" id="deck-setup" data-testid="deck-card">
      <h2>Deck</h2>
      <p className="hint">
        Her buttons, full screen: <a href={href}>open the deck</a>. Add it to the home screen of
        whatever she props next to her.
      </p>

      {invoke.notice ? (
        <Notice notice={invoke.notice} testId="deck-editor-notice" onDismiss={invoke.dismiss} />
      ) : null}

      <details className="fold">
        <summary>
          <span data-testid="deck-count">{deckSizeNote(slots.length)}</span>
          {deck.unsaved ? (
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
              const keys = hotkeyChoices(slots, index);
              const groupNames = [...new Set(keys.map((choice) => choice.group))];
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
                      onChange={(event) => deck.set(editSlot(slots, index, { icon: event.target.value }))}
                    />
                    <input
                      className="input slot-label"
                      data-testid="deck-slot-label"
                      aria-label={`Label for button ${index + 1}`}
                      value={slot.label}
                      autoComplete="off"
                      onChange={(event) => deck.set(editSlot(slots, index, { label: event.target.value }))}
                    />
                </div>
                {/* Her PC only: the tray registers these, so a phone-only
                    setup will never see one fire. It is edited here anyway
                    because here is where her buttons are, and she arranges
                    them on the phone -- a picker that only appeared on the
                    machine that uses it would be a picker she never found. */}
                <div className="slot-key">
                  <label className="field-inline">
                    <span>Key</span>
                    <select
                      className="select key-pick"
                      data-testid="deck-slot-hotkey"
                      aria-label={`Hotkey for ${slot.label}`}
                      value={slot.hotkey ?? ""}
                      disabled={busy}
                      onChange={(event) =>
                        deck.set(setHotkey(slots, index, event.target.value))
                      }
                    >
                      <option value="">No key</option>
                      {/* A key she saved that this build no longer offers still
                          shows, or the row would say "No key" about a button
                          that has one. */}
                      {slot.hotkey && !keys.some((c) => c.accelerator === slot.hotkey) ? (
                        <option value={slot.hotkey}>{slot.hotkey}</option>
                      ) : null}
                      {groupNames.map((name) => (
                        <optgroup key={name} label={name}>
                          {keys
                            .filter((choice) => choice.group === name)
                            .map((choice) => (
                              <option key={choice.accelerator} value={choice.accelerator}>
                                {choice.label}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
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
                    onClick={() => deck.set(moveSlot(slots, index, index - 1))}
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
                    onClick={() => deck.set(moveSlot(slots, index, index + 1))}
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
                    onClick={() => deck.set(removeSlot(slots, index))}
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
          disabled={busy || !deck.unsaved}
          onClick={() => void save()}
        >
          Save deck
        </button>
        <button
          type="button"
          className="btn"
          data-testid="deck-revert"
          disabled={busy || !deck.editing}
          onClick={() => deck.discard()}
        >
          Discard changes
        </button>
      </details>
    </section>
  );
}
