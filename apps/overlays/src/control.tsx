import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  connect,
  useConnected,
  useCoreState,
  type Connection,
} from "./lib/connection.js";
import { serverUrl } from "./lib/serverUrl.js";
import { cards, GenericCard } from "./modules/cards.js";
import "./control.css";

/**
 * Her phone. Same socket as the overlay, different surface, every module.
 *
 * The connection lives outside React for the same reason the overlay's does:
 * there is one of it for the life of the page, and a re-mount must not make a
 * second one.
 */

/** Long enough that a blip between two frames is "connecting", not a failure. */
const COMPLAIN_AFTER_MS = 3_000;

function Control({ url, connection }: { url: string; connection: Connection }) {
  const connected = useConnected(connection);
  const core = useCoreState(connection);

  return (
    <div className="page">
      <header className="top">
        <div className="brand">
          <span className="mark" aria-hidden="true" />
          <div>
            <h1>Saarathi</h1>
            <Status url={url} connected={connected} />
          </div>
        </div>
        {core ? <Connections connections={core.connections} /> : null}
      </header>

      <main className="cards">
        {(core?.modules ?? []).map((status) => {
          const Card = cards[status.id] ?? GenericCard;
          return <Card key={status.id} connection={connection} status={status} />;
        })}
      </main>
    </div>
  );
}

function Status({ url, connected }: { url: string; connected: boolean }) {
  const [complain, setComplain] = useState(false);
  const [wasConnected, setWasConnected] = useState(connected);
  if (wasConnected !== connected) {
    setWasConnected(connected);
    setComplain(false);
  }

  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setComplain(true), COMPLAIN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  const text = connected
    ? "Connected"
    : complain
      ? `Cannot reach Saarathi at ${url}. Retrying`
      : "Connecting…";

  return (
    <p
      className="status"
      data-connected={connected}
      data-complain={complain}
      data-testid="status"
    >
      {text}
    </p>
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
const connection = connect({ url, surface: "control" });

createRoot(root).render(
  <StrictMode>
    <Control url={url} connection={connection} />
  </StrictMode>,
);
