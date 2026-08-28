import type { StreamEvent } from "@saarathi/shared";

export interface ChatLine {
  who: string;
  what: string;
  kind: StreamEvent["type"];
}

/** One row on her chat card. Pure so the wording can be checked without a page. */
export function formatEvent(event: StreamEvent): ChatLine {
  switch (event.type) {
    case "chat-message":
      return { who: event.author.name, what: event.text, kind: event.type };
    case "chat-command":
      return { who: event.author.name, what: event.text, kind: event.type };
    case "paid-event":
      return {
        who: event.author.name,
        what: event.text ? `${event.amount.display} · ${event.text}` : event.amount.display,
        kind: event.type,
      };
    case "new-member":
      return { who: event.author.name, what: "joined", kind: event.type };
  }
}
