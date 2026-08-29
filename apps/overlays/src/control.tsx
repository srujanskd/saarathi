import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { OBS_ID } from "@saarathi/shared";
import { DeckCard } from "./core/DeckCard.js";
import { ObsCard } from "./core/ObsCard.js";
import { Status } from "./core/Status.js";
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

  return (
    <div className="page">
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
        {/* Wired by hand rather than through modules/registry.ts: OBS is a core
            service every module shares, not a game. It leads because it is the
            one card that explains why nothing else is working. */}
        {core ? (
          <ObsCard
            connection={connection}
            obs={core.obs}
            status={core.connections[OBS_ID]}
            deck={core.deck}
          />
        ) : null}
        {/* Also core rather than a module, and for the same reason: every
            surface renders the grid and no module owns it. */}
        {core ? (
          <DeckCard
            connection={connection}
            deck={core.deck}
            modules={core.modules}
            href={pageHref("deck.html")}
          />
        ) : null}
        {(core?.modules ?? []).map((status) => {
          const Card = clients[status.id]?.card ?? GenericCard;
          return <Card key={status.id} connection={connection} status={status} />;
        })}
      </main>
    </div>
  );
}

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
