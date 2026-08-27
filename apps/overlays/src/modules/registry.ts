import type { ComponentType } from "react";
import { WHEEL_ID } from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";
import { WheelOverlay } from "./wheel/WheelOverlay.js";

export interface OverlayProps {
  connection: Connection;
}

/**
 * Client half of the module contract, keyed by the same ids the server uses.
 *
 * A new game adds one line here and one entry in the server's module list.
 * Nothing else on this side knows a wheel exists, which is the whole point:
 * when you find yourself special-casing a module id outside this file, the gap
 * is in the contract, not here.
 */
export const overlays: Record<string, ComponentType<OverlayProps>> = {
  [WHEEL_ID]: WheelOverlay,
};
