import { SERVER_PORT } from "@saarathi/shared";

/** The parts of `window.location` any of this needs. Passing them in is what
 * makes the rules below testable without a browser. */
export interface PageLocation {
  search: string;
  origin: string;
  protocol: string;
  hostname: string;
}

/**
 * Where the Saarathi server is.
 *
 * The page and the server are not the same thing and may not be on the same
 * machine: OBS loads an overlay off her PC, her phone loads the control page
 * over the LAN, and the day she streams IRL the server moves to a VPS while
 * the pages stay wherever they were built. So the address arrives as a
 * `?server=` parameter, and the only fallback is where this page came from.
 *
 * Nothing in this repo may name a host. This function is what makes that rule
 * keepable: everything else asks it instead of guessing.
 */
export function serverUrl(location: PageLocation = window.location): string {
  const param = new URLSearchParams(location.search).get("server");
  if (param && param.trim()) return normalise(param, location.protocol);

  // In production the server serves these pages, so it is the origin we came
  // from. In dev, Vite serves them from its own port, so keep the host --
  // which is the LAN address when her phone loaded it -- and move the port.
  if (!import.meta.env.DEV) return location.origin;
  return `${location.protocol}//${location.hostname}:${SERVER_PORT}`;
}

/**
 * She will paste an address, not a URL. "192.168.1.20:4400" has to work, and
 * so does a trailing slash: that is what comes out of a phone keyboard and out
 * of the QR code the control page will hand her.
 */
function normalise(value: string, protocol: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return /^https?:\/\//i.test(trimmed) ? trimmed : `${protocol}//${trimmed}`;
}

/** Which module's overlay this page renders, e.g. `?module=wheel`. */
export function moduleParam(search: string = window.location.search): string | null {
  return new URLSearchParams(search).get("module");
}
