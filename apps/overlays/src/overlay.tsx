import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { connect, type Connection } from "./lib/connection.js";
import { moduleParam, serverUrl } from "./lib/serverUrl.js";
import { useUnreachable } from "./lib/unreachable.js";
import { clients, overlayIds } from "./modules/registry.js";
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

function Overlay({ id, url, connection }: { id: string; url: string; connection: Connection }) {
  const Module = clients[id]?.overlay;
  if (!Module) {
    return (
      <Status visible>
        Nothing renders “{id}”. Known overlays: {overlayIds().join(", ")}
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
  const unreachable = useUnreachable(connection);
  return (
    <Status visible={unreachable} testId="status">
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
