import type { ModuleStatus } from "@saarathi/shared";
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
}
