import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OBS_ID } from "@saarathi/shared";
import { ChatSourceCard } from "./core/ChatSourceCard.js";
import { AccessCard } from "./core/AccessCard.js";
import { DeckCard } from "./core/DeckCard.js";
import { ObsCard } from "./core/ObsCard.js";
import { ReadinessPanel } from "./core/ReadinessPanel.js";
import { Status } from "./core/Status.js";
import { useDeckDraft } from "./core/useDeckDraft.js";
import { connect, useCoreState, type Connection } from "./lib/connection.js";
import { pageHref, serverUrl } from "./lib/serverUrl.js";
import { GenericCard } from "./modules/GenericCard.js";
import { clients } from "./modules/registry.js";
import "./control.css";

/**
 * Her phone. Same socket as the overlay, different surface, every module.
 *
 * The connection lives outside React for the same reason the overlay's does:
 * there is one of it for the life of the page, and a re-mount must not make a
 * second one.
 */

function Control({ url, connection }: { url: string; connection: Connection }) {
  const core = useCoreState(connection);
  // Held here rather than in the deck card because two cards write buttons:
  // the deck card arranges them and the OBS card adds a scene. One draft, so
  // neither can save away what the other just added.
  const deck = useDeckDraft(core?.deck.slots ?? EMPTY_GRID);

  return (
    <div className="page" data-surface="control">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Saarathi</h1>
            <Status url={url} connection={connection} />
          </div>
        </div>
        {core ? <Connections connections={core.connections} /> : null}
      </header>

      <main className="cards">
        {core ? <ReadinessPanel core={core} /> : null}
        <AccessCard connection={connection} />
        {/* Wired by hand rather than through modules/registry.ts: OBS is a core
            service every module shares, not a game. It leads because it is the
            one card that explains why nothing else is working. */}
        {core ? (
          <ObsCard
            connection={connection}
            obs={core.obs}
            status={core.connections[OBS_ID]}
            deck={deck}
            modules={core.modules}
            serverUrl={url}
          />
        ) : null}
        {/* One per adapter that has anything to set up, which today is
            YouTube and never mock chat. Core rather than a module for the same
            reason OBS is: every module reads the events these produce, and no
            module owns one. */}
        {Object.entries(core?.chat ?? {}).map(([name, view]) => (
          <ChatSourceCard
            key={name}
            connection={connection}
            name={name}
            view={view}
            status={core!.connections[name]}
            stats={core!.stats[name]}
            writes={core!.writes}
          />
        ))}
        {/* Also core rather than a module, and for the same reason: every
            surface renders the grid and no module owns it. */}
        {core ? (
          <DeckCard
            connection={connection}
            deck={deck}
            modules={core.modules}
            href={pageHref("deck.html")}
          />
        ) : null}
        {(core?.modules ?? []).map((status) => {
          const Card = clients[status.id]?.card ?? GenericCard;
          return (
            <Card key={status.id} connection={connection} status={status} deck={deck} />
          );
        })}
      </main>
    </div>
  );
}

/** One array, so a snapshot that has not arrived does not look like a change
 * of grid on every render. */
const EMPTY_GRID: never[] = [];

function Connections({
  connections,
}: {
  connections: NonNullable<ReturnType<typeof useCoreState>>["connections"];
}) {
  const entries = Object.entries(connections);
  if (entries.length === 0) return null;
  return (
    <ul className="connections" data-testid="connections">
      {entries.map(([name, status]) => (
        <li key={name} data-state={status.state}>
          {status.detail}
        </li>
      ))}
    </ul>
  );
}

const root = document.getElementById("root")!;
const url = serverUrl();
const connection = connect({ url, surface: "control", botReplies: true });

createRoot(root).render(
  <StrictMode>
    <Control url={url} connection={connection} />
  </StrictMode>,
);
