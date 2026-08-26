import type { StreamEvent } from "../events.js";

export const CHATLOG_ID = "chatlog";

export interface ChatLogState {
  events: StreamEvent[];
}

export const MAX_LOGGED_EVENTS = 50;
