import type { ModuleStatus } from "@saarathi/shared";
import type { Connection } from "../lib/connection.js";

export interface CardProps {
  connection: Connection;
  status: ModuleStatus;
}
