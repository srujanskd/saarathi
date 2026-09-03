import { useAccess, useConnected, type Connection } from "../lib/connection.js";
import { useUnreachable } from "../lib/unreachable.js";

/**
 * Whether this page is talking to the server, and where it is looking.
 *
 * Both of her pages need this and they need it identically -- the address is
 * in the sentence because when it is wrong, the address is the answer, and she
 * may be reading this on a phone that is on the wrong network. It lives here
 * rather than twice for the same reason `useUnreachable` does.
 */
export function Status({ url, connection }: { url: string; connection: Connection }) {
  const connected = useConnected(connection);
  const access = useAccess(connection);
  const complain = useUnreachable(connection);

  const text = access.phase === "unpaired"
    ? access.reason ?? "Pair this device from the Saarathi tray"
    : connected
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
