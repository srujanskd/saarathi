import {
  CHATLOG_ID,
  MAX_LOGGED_EVENTS,
  type ChatLogState,
  type EventType,
  type GameModuleDef,
} from "@saarathi/shared";

const LOGGED: EventType[] = ["chat-message", "chat-command", "paid-event", "new-member"];

/**
 * Recent chat, for her control page. It is a module rather than a field on core
 * state so that an overlay in OBS is not paying to receive chat it never
 * renders -- clients subscribe per module, and the wheel overlay does not
 * subscribe to this one.
 *
 * Nothing here is persisted. A chat log from last week's stream is noise.
 */
export const chatlog: GameModuleDef<ChatLogState> = {
  id: CHATLOG_ID,
  title: "Chat",
  initialState: { events: [] },
  actions: {},

  setup(ctx) {
    for (const type of LOGGED) {
      ctx.on(type, (event) => {
        ctx.setState((state) => ({
          events: [event, ...state.events].slice(0, MAX_LOGGED_EVENTS),
        }));
      });
    }
  },
};
