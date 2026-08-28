import { SERVER_PORT } from "@saarathi/shared";

/** The parts of `window.location` any of this needs. Passing them in is what
 * makes the rules below testable without a browser. */
export interface PageLocation {
  search: string;
  origin: string;
  protocol: string;
  hostname: string;
}

/** Where an explicit `?server=` is kept between loads. Scoped to the page's
 * own origin by the browser, so a copy served from her PC and a copy served
 * from a pages host never overwrite each other. */
const REMEMBERED = "saarathi:server";

export interface ServerMemory {
  read(): string | null;
  write(url: string): void;
}

/** localStorage, or nothing at all. A private window and a browser with site
 * data blocked both throw on the way in, and neither is a reason to fail. */
function browserMemory(): ServerMemory {
  return {
    read() {
      try {
        return window.localStorage.getItem(REMEMBERED);
      } catch {
        return null;
      }
    },
    write(url) {
      try {
        window.localStorage.setItem(REMEMBERED, url);
      } catch {
        // Nothing to do and nothing worth saying: the parameter still worked.
      }
    },
  };
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
 *
 * A `?server=` she typed is also remembered, because the installed PWA is
 * launched from the manifest's `start_url` and a manifest is a static file
 * that cannot carry her address. Without this, installing the control page
 * from a pages host gives her an app that looks for a server on the pages
 * host. The way back out is the way in: load it once with a new `?server=`.
 */
export function serverUrl(
  location: PageLocation = window.location,
  memory: ServerMemory = browserMemory(),
): string {
  const param = new URLSearchParams(location.search).get("server");
  if (param && param.trim()) {
    const url = normalise(param, location.protocol);
    memory.write(url);
    return url;
  }

  const remembered = memory.read();
  if (remembered) return remembered;

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
