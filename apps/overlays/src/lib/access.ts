import type { PairedAccess, Surface } from "@saarathi/shared";

const KEY = "saarathi:control:";

export interface TokenMemory {
  read(key: string): string | null;
  write(key: string, value: string): void;
  remove(key: string): void;
}

function browserMemory(): TokenMemory {
  return {
    read(key) {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    write(key, value) {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // The token still works for this page load. A private window simply
        // pairs again next time instead of turning storage into a crash.
      }
    },
    remove(key) {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // It was not durable if storage is unavailable.
      }
    },
  };
}

export interface AccessLocation {
  search: string;
}

export interface AccessResult {
  token: string | null;
  reason?: string;
}

/** Find or exchange the one capability this page is allowed to use. */
export async function pageAccess(
  server: string,
  surface: Surface,
  location: AccessLocation = window.location,
  memory: TokenMemory = browserMemory(),
  request: typeof fetch = fetch,
): Promise<AccessResult> {
  const params = new URLSearchParams(location.search);
  if (surface === "overlay") {
    const token = params.get("access")?.trim() ?? "";
    if (token) return { token };
  }

  const key = `${KEY}${server}`;
  if (surface !== "overlay") {
    const remembered = memory.read(key);
    if (remembered) return { token: remembered };

    const code = params.get("pair")?.trim();
    if (code) {
      return pairPageAccess(server, code, memory, request);
    }
  }

  // The tray, floating deck and a browser on this PC should not ask her to
  // pair with themselves. The server only answers this route to loopback and
  // sends no CORS header, so a remote page cannot read it.
  let unreachable = false;
  try {
    const response = await request(`${server}/api/access/local`);
    if (response.ok) {
      const body = (await response.json()) as {
        controlToken?: unknown;
        overlayToken?: unknown;
      };
      const token = surface === "overlay" ? body.overlayToken : body.controlToken;
      if (typeof token === "string" && token) {
        if (surface !== "overlay") memory.write(key, token);
        return { token };
      }
    }
  } catch {
    // Remote device, or a separately hosted dev page. Pairing is the path in.
    unreachable = true;
  }
  return {
    token: null,
    reason: surface === "overlay"
      ? "This overlay URL is not paired"
      : unreachable
      ? `Cannot reach Saarathi at ${server}`
      : "Open Connect your phone from the Saarathi tray and scan again",
  };
}

export async function pairPageAccess(
  server: string,
  code: string,
  memory: TokenMemory = browserMemory(),
  request: typeof fetch = fetch,
): Promise<AccessResult> {
  const result = await post<PairedAccess>(request, `${server}/api/access/pair`, { code });
  if (!result.ok) return { token: null, reason: result.reason };
  memory.write(`${KEY}${server}`, result.body.controlToken);
  return { token: result.body.controlToken };
}

export function forgetPageAccess(server: string, memory: TokenMemory = browserMemory()): void {
  memory.remove(`${KEY}${server}`);
}

async function post<T>(
  request: typeof fetch,
  url: string,
  body: unknown,
  token?: string,
): Promise<{ ok: true; body: T } | { ok: false; reason: string }> {
  try {
    const response = await request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as T & { reason?: unknown };
    if (response.ok) return { ok: true, body: value };
    return { ok: false, reason: typeof value.reason === "string" ? value.reason : "Pairing failed" };
  } catch {
    return { ok: false, reason: "Cannot reach Saarathi" };
  }
}

export async function resetPageAccess(
  server: string,
  token: string,
  memory: TokenMemory = browserMemory(),
  request: typeof fetch = fetch,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const result = await post<{ ok: true }>(request, `${server}/api/access/reset`, {}, token);
  if (!result.ok) return result;
  forgetPageAccess(server, memory);
  return { ok: true };
}
