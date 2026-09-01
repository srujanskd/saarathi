import { CORE_ACTIONS, type DeckSlot } from "@saarathi/shared";
import type { Invoker } from "../lib/invoke.js";
import { appendSlot, encodeGrid } from "./deckDraft.js";
import type { DeckDraft } from "./useDeckDraft.js";

/**
 * A button onto the grid she is looking at.
 *
 * Three cards write one -- OBS a scene, goals a "+1", gains a hand-out -- for
 * the same reason each time: the action needs an argument, the argument is
 * something she is already looking at, and the deck's own picker never asks
 * her to type one. They were three copies of these eight lines, and the fourth
 * module would have been the fourth copy.
 *
 * With nothing open in the deck card it appends and saves in one go: the deck
 * has no half-saved state -- a save replaces the whole grid -- and a full deck
 * is refused by the server in its own words, which land in the card's notice.
 *
 * With an arrangement open there, the button goes into that arrangement and she
 * saves once, from the card with the Save button on it. Saving over her draft
 * would commit edits she has not finished; saving under it would put the button
 * somewhere she cannot see, and her next Save would delete it.
 */
export async function addToDeck(
  deck: DeckDraft,
  invoke: Invoker,
  slot: DeckSlot,
): Promise<void> {
  const next = appendSlot(deck.slots, slot);
  if (deck.editing) {
    deck.set(next);
    invoke.say(`${slot.label} added to the deck you are editing — Save deck to keep it`);
    return;
  }
  if (await invoke.run(CORE_ACTIONS.deckSet, [encodeGrid(next)])) deck.discard();
}
