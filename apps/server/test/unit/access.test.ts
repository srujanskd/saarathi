import { describe, expect, it } from "vitest";
import { Access, isLoopback, isLoopbackHost, isLoopbackOrigin } from "../../src/core/access.js";
import { MemoryStore } from "../../src/core/store.js";

function accessAt(now: { value: number }, store = new MemoryStore()) {
  const tokens = ["control-one", "overlay-one", "control-two", "overlay-two"];
  return {
    access: new Access({
      store,
      now: () => now.value,
      token: () => tokens.shift()!,
      code: () => "123456",
    }),
    store,
  };
}

describe("Access", () => {
  it("persists separate read and control capabilities", () => {
    const now = { value: 1_000 };
    const first = accessAt(now);
    const local = first.access.local();
    expect(first.access.level(local.controlToken)).toBe("control");
    expect(first.access.level(local.overlayToken)).toBe("read");

    const restarted = new Access({ store: first.store, token: () => "should-not-be-used" });
    expect(restarted.level(local.controlToken)).toBe("control");
    expect(restarted.level(local.overlayToken)).toBe("read");
  });

  it("exchanges only a current pairing code for control access", () => {
    const now = { value: 1_000 };
    const { access } = accessAt(now);
    expect(access.pair("123456", "phone")).toMatchObject({ ok: false });

    const local = access.localPairing();
    expect(access.pair(local.pairing.code, "phone")).toEqual({
      ok: true,
      access: { controlToken: local.controlToken },
    });

    now.value = local.pairing.expiresAt;
    expect(access.pair(local.pairing.code, "other-phone")).toMatchObject({ ok: false });
  });

  it("limits guesses per client and opens again after the window", () => {
    const now = { value: 1_000 };
    const { access } = accessAt(now);
    access.localPairing();
    for (let i = 0; i < 5; i++) expect(access.pair("000000", "phone").ok).toBe(false);
    expect(access.pair("123456", "phone")).toMatchObject({ ok: false, limited: true });

    now.value += 60_000;
    expect(access.pair("123456", "phone").ok).toBe(true);
  });

  it("rotates both capabilities and the pairing code together", () => {
    const now = { value: 1_000 };
    const { access } = accessAt(now);
    const before = access.local();
    access.rotate();
    const after = access.local();
    expect(access.level(before.controlToken)).toBeNull();
    expect(access.level(before.overlayToken)).toBeNull();
    expect(after.controlToken).toBe("control-two");
    expect(after.overlayToken).toBe("overlay-two");
  });

  it("starts a fresh ten-minute window only when pairing is requested", () => {
    const now = { value: 1_000 };
    const { access } = accessAt(now);
    access.local();
    now.value += 9 * 60_000;

    const opened = access.localPairing();
    expect(opened.pairing.expiresAt).toBe(now.value + 10 * 60_000);
  });
});

describe("isLoopback", () => {
  it("accepts Node's three loopback spellings and no LAN address", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("192.168.1.24")).toBe(false);
  });

  it("requires a literal local Host header as well as a local peer", () => {
    expect(isLoopbackHost("127.0.0.1:4400")).toBe(true);
    expect(isLoopbackHost("localhost:4400")).toBe(true);
    expect(isLoopbackHost("[::1]:4400")).toBe(true);
    expect(isLoopbackHost("attacker.example:4400")).toBe(false);
  });

  it("recognises only literal loopback browser origins", () => {
    expect(isLoopbackOrigin("http://localhost:5173")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:5173")).toBe(true);
    expect(isLoopbackOrigin("https://attacker.example")).toBe(false);
    expect(isLoopbackOrigin("not a URL")).toBe(false);
  });
});
