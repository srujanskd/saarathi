import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { ACCESS_ID, type AccessLevel, type LocalAccess, type PairedAccess } from "@saarathi/shared";
import type { StateStore } from "./store.js";

const PAIRING_LIFETIME_MS = 10 * 60_000;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 5;

interface SavedAccess {
  controlToken: string;
  overlayToken: string;
}

interface Pairing {
  code: string;
  expiresAt: number;
}

interface Attempts {
  since: number;
  count: number;
}

export interface AccessOptions {
  store: StateStore;
  now?: () => number;
  token?: () => string;
  code?: () => string;
}

export type PairResult =
  | { ok: true; access: PairedAccess }
  | { ok: false; reason: string; limited?: boolean };

/**
 * The whole trust model behind four operations.
 *
 * Callers never parse, compare, persist or rotate a capability themselves.
 * A read token can render declared overlay slices. A control token can also
 * invoke. The short code only exchanges for control access and never survives
 * a restart, so a screenshot of the connect window ages out on its own.
 */
export class Access {
  private saved: SavedAccess;
  private pairing: Pairing | null = null;
  private readonly attempts = new Map<string, Attempts>();
  private readonly now: () => number;
  private readonly makeToken: () => string;
  private readonly makeCode: () => string;

  constructor(private readonly options: AccessOptions) {
    this.now = options.now ?? Date.now;
    this.makeToken = options.token ?? (() => randomBytes(32).toString("base64url"));
    this.makeCode = options.code ?? (() => String(randomInt(100_000, 1_000_000)));
    const saved = readSaved(options.store);
    this.saved = saved ?? this.fresh();
    if (!saved) this.persist();
  }

  level(token: unknown): AccessLevel | null {
    if (typeof token !== "string" || token.length === 0) return null;
    if (same(token, this.saved.controlToken)) return "control";
    if (same(token, this.saved.overlayToken)) return "read";
    return null;
  }

  local(): LocalAccess {
    return { ...this.saved, pairing: this.openPairing() };
  }

  pair(code: unknown, client: string): PairResult {
    const now = this.now();
    const attempts = this.attemptsFor(client, now);
    if (attempts.count >= MAX_ATTEMPTS) {
      return { ok: false, reason: "Too many tries. Wait a minute and scan again.", limited: true };
    }

    const pairing = this.pairing;
    if (!pairing || pairing.expiresAt <= now || typeof code !== "string" || !same(code, pairing.code)) {
      attempts.count++;
      return { ok: false, reason: "That pairing code is not current" };
    }

    this.attempts.delete(client);
    return { ok: true, access: { controlToken: this.saved.controlToken } };
  }

  rotate(): void {
    this.saved = this.fresh();
    this.pairing = null;
    this.attempts.clear();
    this.persist();
  }

  private openPairing(): Pairing {
    const now = this.now();
    if (!this.pairing || this.pairing.expiresAt <= now) {
      this.pairing = { code: this.makeCode(), expiresAt: now + PAIRING_LIFETIME_MS };
    }
    return { ...this.pairing };
  }

  private attemptsFor(client: string, now: number): Attempts {
    const found = this.attempts.get(client);
    if (found && now - found.since < ATTEMPT_WINDOW_MS) return found;
    const made = { since: now, count: 0 };
    this.attempts.set(client, made);
    return made;
  }

  private fresh(): SavedAccess {
    return { controlToken: this.makeToken(), overlayToken: this.makeToken() };
  }

  private persist(): void {
    this.options.store.write(ACCESS_ID, { ...this.saved });
    // A restart immediately after first boot must not strand every paired
    // device with tokens the state file never received.
    this.options.store.flush();
  }
}

function readSaved(store: StateStore): SavedAccess | null {
  const raw = store.read(ACCESS_ID);
  if (typeof raw?.controlToken !== "string" || typeof raw.overlayToken !== "string") return null;
  if (!raw.controlToken || !raw.overlayToken) return null;
  return { controlToken: raw.controlToken, overlayToken: raw.overlayToken };
}

function same(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** IPv4 may arrive mapped through an IPv6 socket. */
export function isLoopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/** Stops DNS rebinding from turning a hostile site's origin into loopback. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":", 1)[0];
  return name === "127.0.0.1" || name === "::1" || name === "localhost";
}

export function isLoopbackOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    return isLoopbackHost(new URL(origin).host);
  } catch {
    return false;
  }
}
