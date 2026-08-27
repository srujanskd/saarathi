import type { ComponentType } from "react";
import { CHATLOG_ID, WHEEL_ID } from "@saarathi/shared";
import { ChatCard } from "./chatlog/ChatCard.js";
import type { CardProps } from "./types.js";
import { WheelCard } from "./wheel/WheelCard.js";

/**
 * Control-page half of the module contract. A new game adds a card here the
 * same way it adds an overlay. Modules without a custom card still get their
 * title and declared actions, so a game that only has buttons does not have
 * to invent a layout to show up on her phone.
 */
export const cards: Record<string, ComponentType<CardProps>> = {
  [WHEEL_ID]: WheelCard,
  [CHATLOG_ID]: ChatCard,
};

export function GenericCard({ connection, status }: CardProps) {
  if (status.actions.length === 0) {
    return (
      <section className="card">
        <h2>{status.title}</h2>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>{status.title}</h2>
      <div className="btn-row">
        {status.actions.map((action) => (
          <button
            key={action.id}
            type="button"
            className="btn"
            onClick={() => void connection.invoke({ action: action.id })}
          >
            {action.label}
          </button>
        ))}
      </div>
    </section>
  );
}
