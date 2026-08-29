import { useState } from "react";
import type { DeckSlot } from "@saarathi/shared";
import { sameGrid } from "./deckDraft.js";

export interface DeckDraft {
  /** The grid she is looking at: her arrangement if she has one open, the
   * server's otherwise. Everything that reads or writes the deck reads this. */
  slots: DeckSlot[];
  /** She has an arrangement open at all, saved or not. Discard has something
   * to do, and nothing else may write the grid behind her back. */
  editing: boolean;
  /** ...and it differs from what the server holds, so Save has something to do. */
  unsaved: boolean;
  set(slots: DeckSlot[]): void;
  /** Back to the server's grid, which is also what a save lands on. */
  discard(): void;
}

/**
 * The one grid she is editing, held above the cards that touch it.
 *
 * It lives in `control.tsx` rather than in the deck card because the deck card
 * is not the only thing that writes buttons: the OBS card adds a scene, and
 * the day a module adds one of its own it will be a third. A draft owned by
 * one card shadows the server for that card alone, so a button added anywhere
 * else lands on the server, never appears in the list she is looking at, and
 * is deleted by her next Save -- a button she saw work and then lost, with
 * nothing on screen to say so.
 *
 * A draft shadows the server only while it exists, the same discipline the
 * challenge textarea uses: without that, one keystroke would freeze her grid
 * against every later snapshot.
 */
export function useDeckDraft(saved: DeckSlot[]): DeckDraft {
  const [draft, setDraft] = useState<DeckSlot[] | null>(null);

  return {
    slots: draft ?? saved,
    editing: draft !== null,
    unsaved: draft !== null && !sameGrid(draft, saved),
    set: setDraft,
    discard: () => setDraft(null),
  };
}
