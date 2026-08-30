import type { ModuleStatus } from "@saarathi/shared";
import type { DeckDraft } from "../core/useDeckDraft.js";
import type { Connection } from "../lib/connection.js";

/** What a module's OBS browser source is handed. It draws one module and knows
 * nothing about the page around it. */
export interface OverlayProps {
  connection: Connection;
}

/** What a module's card on her phone is handed. `status` is the server's own
 * description of the module: its title and the actions it will accept. */
export interface CardProps {
  connection: Connection;
  status: ModuleStatus;
  /**
   * The one grid she is editing, shared with the deck card and the OBS card.
   * A module gets it because a module action that takes an argument can only
   * become a deck button from the card that knows what the argument is -- the
   * goals card writes a "+1" for a goal, as the OBS card writes a scene. A
   * draft owned by one card and written behind by another is a button she saw
   * work and then lost to her next Save.
   */
  deck: DeckDraft;
}
