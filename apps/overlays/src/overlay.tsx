import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { connect, useConnected, type Connection } from "./lib/connection.js";
import { moduleParam, serverUrl } from "./lib/serverUrl.js";
import { overlays } from "./modules/registry.js";
import "./overlay.css";

/**
 * One page, any module: `overlay.html?module=wheel`. OBS wants a URL per
 * browser source, and this is that URL. The page subscribes to the one module
 * it renders and nothing else, so a wheel on a phone tether is not paying to
 * receive a chat log it never draws.
 *
 * The socket is created below, outside React, because there is exactly one of
 * it for the life of the page. Hanging it off a component would mean deciding
 * what a remount does to a connection that should never be remounted.
 */

/** Long enough that a reconnect between two OBS frames never reaches chat. */
const COMPLAIN_AFTER_MS = 3_000;

function Overlay({ id, url, connection }: { id: string; url: string; connection: Connection }) {
  const Module = overlays[id];
  if (!Module) {
    return (
      <Status visible>
        Nothing renders “{id}”. Known overlays: {Object.keys(overlays).join(", ")}
      </Status>
    );
  }
  return (
    <>
      <Module connection={connection} />
      <ConnectionStatus connection={connection} url={url} />
    </>
  );
}

function ConnectionStatus({ connection, url }: { connection: Connection; url: string }) {
  const connected = useConnected(connection);
  const [complain, setComplain] = useState(false);

  // Cleared during the render the change arrives on rather than in the effect
  // below, which is the same trick the wheel uses for its phase. In an effect
  // it commits a frame of the old answer first -- and the old answer here is a
  // "cannot reach Saarathi" that stays on her stream for a frame after it can.
  const [wasConnected, setWasConnected] = useState(connected);
  if (wasConnected !== connected) {
    setWasConnected(connected);
    // Either direction: a fresh disconnect starts its three seconds over.
    setComplain(false);
  }

  useEffect(() => {
    if (connected) return;
    const timer = setTimeout(() => setComplain(true), COMPLAIN_AFTER_MS);
    return () => clearTimeout(timer);
  }, [connected]);

  return (
    <Status visible={complain} testId="status">
      Cannot reach Saarathi at {url} — retrying
    </Status>
  );
}

function Status({
  visible,
  testId,
  children,
}: {
  visible: boolean;
  testId?: string;
  children: ReactNode;
}) {
  return (
    <p className="status" data-visible={visible} data-testid={testId}>
      {children}
    </p>
  );
}

const root = document.getElementById("root")!;
const id = moduleParam();
const url = serverUrl();

if (!id) {
  createRoot(root).render(
    <Status visible>No module in the URL. Try overlay.html?module=wheel</Status>,
  );
} else {
  const connection = connect({ url, surface: "overlay", modules: [id] });
  createRoot(root).render(
    <StrictMode>
      <Overlay id={id} url={url} connection={connection} />
    </StrictMode>,
  );
}
