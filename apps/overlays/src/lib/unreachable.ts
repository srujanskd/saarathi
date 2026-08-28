import { useEffect, useState } from "react";
import { useConnected, type Connection } from "./connection.js";

/** Long enough that a blip between two frames -- an OBS source reloading, her
 * phone waking up -- is "connecting", not a failure worth telling her about. */
const COMPLAIN_AFTER_MS = 3_000;

/**
 * Whether the socket has been down long enough to say so out loud.
 *
 * Both surfaces need exactly this and they need it identically: the overlay so
 * a reconnect between two OBS frames never reaches her stream, the control
 * page so a button that will not work says why. It lives here rather than
 * twice because the subtlety below is easy to get wrong once and impossible to
 * keep right in two copies.
 */
export function useUnreachable(connection: Connection): boolean {
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

  return complain;
}
