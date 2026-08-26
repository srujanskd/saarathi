import { describe, expect, it } from "vitest";
import { Gains } from "../../src/core/gains.js";
import { MemoryStore } from "../../src/core/store.js";
import { testLogger } from "../helpers/logger.js";

function ledger(saved?: Record<string, unknown>) {
  const store = new MemoryStore();
  if (saved) store.write("gains", saved);
  const log = testLogger();
  return { gains: new Gains(store, log), store, log };
}

describe("Gains", () => {
  it("starts everyone at zero", () => {
    expect(ledger().gains.balance("nobody")).toBe(0);
  });

  it("grants and accumulates", () => {
    const { gains } = ledger();
    expect(gains.grant("u1", 100, "minute")).toBe(100);
    expect(gains.grant("u1", 50, "minute")).toBe(150);
    expect(gains.balance("u1")).toBe(150);
  });

  it("ignores a grant of zero or less rather than draining a balance", () => {
    const { gains } = ledger();
    gains.grant("u1", 100, "minute");
    expect(gains.grant("u1", 0, "noop")).toBe(100);
    expect(gains.grant("u1", -50, "not a debit")).toBe(100);
  });

  it("spends when affordable", () => {
    const { gains } = ledger();
    gains.grant("u1", 500, "minute");
    expect(gains.spend("u1", 500, "!spin")).toBe(true);
    expect(gains.balance("u1")).toBe(0);
  });

  it("refuses a spend it cannot cover, with no partial debit", () => {
    const { gains } = ledger();
    gains.grant("u1", 499, "minute");
    expect(gains.spend("u1", 500, "!spin")).toBe(false);
    expect(gains.balance("u1")).toBe(499);
  });

  it("treats a free spend as always successful", () => {
    const { gains } = ledger();
    expect(gains.spend("broke", 0, "free")).toBe(true);
    expect(gains.balance("broke")).toBe(0);
  });

  it("keeps balances separate per viewer", () => {
    const { gains } = ledger();
    gains.grant("u1", 100, "minute");
    expect(gains.spend("u2", 50, "!spin")).toBe(false);
    expect(gains.balance("u1")).toBe(100);
  });

  it("writes through to the store on every change", () => {
    const { gains, store } = ledger();
    gains.grant("u1", 100, "minute");
    expect(store.read("gains")).toEqual({ balances: { u1: 100 } });
    gains.spend("u1", 40, "!spin");
    expect(store.read("gains")).toEqual({ balances: { u1: 60 } });
  });

  it("reads balances back after a restart", () => {
    const { gains } = ledger({ balances: { u1: 250 } });
    expect(gains.balance("u1")).toBe(250);
  });

  it("survives junk in the saved file instead of refusing to boot", () => {
    const { gains } = ledger({
      balances: { good: 10, str: "500", nan: Number.NaN, inf: Number.POSITIVE_INFINITY, nil: null },
    });
    expect(gains.balance("good")).toBe(10);
    for (const key of ["str", "nan", "inf", "nil"]) {
      expect(gains.balance(key), key).toBe(0);
    }
  });

  it("survives a saved slice that is not an object at all", () => {
    expect(() => ledger({ balances: 5 as never })).not.toThrow();
  });

  it("says who and why in the log, since gains are hers to audit", () => {
    const { gains, log } = ledger();
    gains.grant("u1", 100, "active minute");
    gains.spend("u1", 40, "!spin");
    expect(log.text()).toContain("+100 to u1 (active minute)");
    expect(log.text()).toContain("-40 from u1 (!spin)");
  });
});
