import type { ComponentType } from "react";
import { CHATLOG_ID, GAINS_ID, GOALS_ID, MODERATION_ID, WHEEL_ID } from "@saarathi/shared";
import { ChatCard } from "./chatlog/ChatCard.js";
import { GainsCard } from "./gains/GainsCard.js";
import { GainsOverlay } from "./gains/GainsOverlay.js";
import { GoalsCard } from "./goals/GoalsCard.js";
import { GoalsOverlay } from "./goals/GoalsOverlay.js";
import { ModerationCard } from "./moderation/ModerationCard.js";
import type { CardProps, OverlayProps } from "./types.js";
import { WheelCard } from "./wheel/WheelCard.js";
import { WheelOverlay } from "./wheel/WheelOverlay.js";

/**
 * Client half of the module contract, keyed by the same ids the server uses.
 *
 * One entry per game, not one per surface: a module declares the browser
 * source it draws and the card it puts on her phone in the same place, so
 * adding a game is one line here and one entry in the server's module list.
 * Nothing else on this side knows a wheel exists, which is the whole point:
 * when you find yourself special-casing a module id outside this file, the gap
 * is in the contract, not here.
 */
export interface ModuleClient {
  /** The OBS browser source, for a module that draws one. */
  overlay?: ComponentType<OverlayProps>;
  /** Its card on her phone. A module without one still gets the generic card,
   * which is its title and its declared actions, so a game that is only
   * buttons does not have to invent a layout to show up. */
  card?: ComponentType<CardProps>;
}

export const clients: Record<string, ModuleClient> = {
  [WHEEL_ID]: { overlay: WheelOverlay, card: WheelCard },
  [GOALS_ID]: { overlay: GoalsOverlay, card: GoalsCard },
  [GAINS_ID]: { overlay: GainsOverlay, card: GainsCard },
  [MODERATION_ID]: { card: ModerationCard },
  [CHATLOG_ID]: { card: ChatCard },
};

/** The ids `overlay.html?module=` will actually render, so a typo in OBS can
 * be answered with the list rather than a blank browser source. */
export function overlayIds(): string[] {
  return Object.entries(clients)
    .filter(([, client]) => client.overlay)
    .map(([id]) => id);
}
