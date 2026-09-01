import { describe, expect, it } from "vitest";
import type { Author, CommandSpec, GainsLedger } from "@saarathi/shared";
import { CommandGate, decideCommand, parseCommand, triggerVia } from "../../src/core/triggers.js";

const viewer: Author = { id: "u1", name: "Viewer" };
const member: Author = { id: "u2", name: "Member", isMember: true };
const mod: Author = { id: "u3", name: "Mod", isMod: true };
const streamer: Author = { id: "u4", name: "Her", isStreamer: true };

const spec = (extra: Partial<CommandSpec> = {}): CommandSpec => ({
  name: "spin",
  action: "spin",
  ...extra,
});

describe("parseCommand", () => {
  it("reads a bare command", () => {
    expect(parseCommand("!spin")).toEqual({ command: "spin", args: [] });
  });

  it("lowercases the command but not the arguments", () => {
    expect(parseCommand("!SPEND 500 Spin")).toEqual({
      command: "spend",
      args: ["500", "Spin"],
    });
  });

  it("collapses runs of whitespace and ignores the edges", () => {
    expect(parseCommand("   !spin   a    b  ")).toEqual({ command: "spin", args: ["a", "b"] });
  });

  it("is not a command", () => {
    for (const text of ["", " ", "spin", "!", "  !  ", "hello !spin"]) {
      expect(parseCommand(text), text).toBeNull();
    }
  });
});

describe("decideCommand permissions", () => {
  const cases: [CommandSpec["allow"], Author, boolean][] = [
    ["everyone", viewer, true],
    [undefined, viewer, true],
    ["members", viewer, false],
    ["members", member, true],
    ["members", mod, true],
    ["members", streamer, true],
    ["mods", member, false],
    ["mods", mod, true],
    ["mods", streamer, true],
    ["streamer", mod, false],
    ["streamer", streamer, true],
  ];

  for (const [allow, author, ok] of cases) {
    it(`allow:${allow ?? "default"} ${author.name} -> ${ok ? "yes" : "no"}`, () => {
      const result = decideCommand({
        spec: spec({ allow }),
        author,
        now: 0,
        lastUsedAt: undefined,
        balance: 0,
      });
      expect(result.ok).toBe(ok);
    });
  }

  it("names the tier it wanted when it refuses", () => {
    const result = decideCommand({
      spec: spec({ allow: "mods" }),
      author: viewer,
      now: 0,
      lastUsedAt: undefined,
      balance: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("mods");
  });
});

describe("decideCommand cooldown", () => {
  const cooling = spec({ cooldownMs: 45_000 });

  it("allows the first use", () => {
    expect(decideCommand({ spec: cooling, author: viewer, now: 0, lastUsedAt: undefined, balance: 0 }).ok).toBe(true);
  });

  it("refuses inside the window and says how long is left", () => {
    const result = decideCommand({ spec: cooling, author: viewer, now: 1_000, lastUsedAt: 0, balance: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.retryInMs).toBe(44_000);
      expect(result.reason).toContain("44s");
    }
  });

  it("allows the tick the window closes on", () => {
    expect(decideCommand({ spec: cooling, author: viewer, now: 45_000, lastUsedAt: 0, balance: 0 }).ok).toBe(true);
  });

  it("rounds the wait up, so it never says 0s", () => {
    const result = decideCommand({ spec: cooling, author: viewer, now: 44_999, lastUsedAt: 0, balance: 0 });
    if (!result.ok) expect(result.reason).toContain("1s");
  });

  it("ignores a cooldown the spec does not declare", () => {
    expect(decideCommand({ spec: spec(), author: viewer, now: 1, lastUsedAt: 0, balance: 0 }).ok).toBe(true);
  });
});

describe("decideCommand price", () => {
  it("refuses when the balance is short, and quotes both numbers", () => {
    const result = decideCommand({
      spec: spec({ cost: 500 }),
      author: viewer,
      now: 0,
      lastUsedAt: undefined,
      balance: 499,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("500");
      expect(result.reason).toContain("499");
    }
  });

  it("allows an exact balance", () => {
    expect(
      decideCommand({ spec: spec({ cost: 500 }), author: viewer, now: 0, lastUsedAt: undefined, balance: 500 }).ok,
    ).toBe(true);
  });

  it("checks permission before price, so a refusal names the real reason", () => {
    const result = decideCommand({
      spec: spec({ allow: "mods", cost: 500 }),
      author: viewer,
      now: 0,
      lastUsedAt: undefined,
      balance: 0,
    });
    if (!result.ok) expect(result.reason).toContain("mods");
  });
});

/** A ledger with no store behind it, so the gate's charging is observable. */
function fakeLedger(initial: Record<string, number> = {}): GainsLedger & { log: string[] } {
  const balances = new Map(Object.entries(initial));
  const log: string[] = [];
  return {
    log,
    balance: (id) => balances.get(id) ?? 0,
    grant(id, amount, reason) {
      const next = (balances.get(id) ?? 0) + amount;
      balances.set(id, next);
      log.push(`+${amount} ${id} ${reason}`);
      return next;
    },
    spend(id, amount, reason) {
      const current = balances.get(id) ?? 0;
      if (current < amount) return false;
      balances.set(id, current - amount);
      log.push(`-${amount} ${id} ${reason}`);
      return true;
    },
  };
}

describe("triggerVia", () => {
  it("calls a priced command a gains trigger", () => {
    expect(triggerVia(spec({ cost: 500 }))).toBe("gains");
  });

  it("calls a free one chat, however else it is configured", () => {
    expect(triggerVia(spec())).toBe("chat");
    expect(triggerVia(spec({ cooldownMs: 1_000, allow: "mods" }))).toBe("chat");
  });

  it("treats a price of zero as free, because nothing was spent", () => {
    expect(triggerVia(spec({ cost: 0 }))).toBe("chat");
  });
});

describe("CommandGate", () => {
  it("reports how the trigger was paid for, so nothing downstream has to guess", () => {
    const gate = new CommandGate(fakeLedger({ u1: 500 }));

    const paid = gate.consume("wheel.spin", spec({ cost: 500 }), viewer, 0);
    expect(paid).toMatchObject({ ok: true, via: "gains" });

    const free = gate.consume("other.thing", spec(), viewer, 0);
    expect(free).toMatchObject({ ok: true, via: "chat" });
  });

  it("charges before dispatch, so two triggers in one tick cannot both pass", () => {
    const ledger = fakeLedger({ u1: 500 });
    const gate = new CommandGate(ledger);
    const priced = spec({ cost: 500 });

    expect(gate.consume("wheel.spin", priced, viewer, 0).ok).toBe(true);
    expect(ledger.balance("u1")).toBe(0);
    expect(gate.consume("wheel.spin", priced, viewer, 0).ok).toBe(false);
  });

  it("stamps the cooldown on the way through", () => {
    const gate = new CommandGate(fakeLedger());
    const cooling = spec({ cooldownMs: 1_000 });

    expect(gate.consume("wheel.spin", cooling, viewer, 0).ok).toBe(true);
    expect(gate.consume("wheel.spin", cooling, viewer, 500).ok).toBe(false);
    expect(gate.consume("wheel.spin", cooling, viewer, 1_000).ok).toBe(true);
  });

  it("holds cooldowns per binding key, not per author", () => {
    const gate = new CommandGate(fakeLedger());
    const cooling = spec({ cooldownMs: 1_000 });

    expect(gate.consume("wheel.spin", cooling, viewer, 0).ok).toBe(true);
    // Same binding: chat as a whole shares the wheel's cooldown.
    expect(gate.consume("wheel.spin", cooling, mod, 100).ok).toBe(false);
    // Different binding: untouched.
    expect(gate.consume("other.thing", cooling, viewer, 100).ok).toBe(true);
  });

  it("release refunds the gains and puts the cooldown back to first use", () => {
    const ledger = fakeLedger({ u1: 500 });
    const gate = new CommandGate(ledger);
    const priced = spec({ cost: 500, cooldownMs: 1_000 });

    const result = gate.consume("wheel.spin", priced, viewer, 0);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    result.release();
    expect(ledger.balance("u1")).toBe(500);
    // The refused trigger cost nothing, so the next one is not cooling down.
    expect(gate.consume("wheel.spin", priced, viewer, 1).ok).toBe(true);
  });

  it("release restores the previous cooldown rather than clearing it", () => {
    const gate = new CommandGate(fakeLedger());
    const cooling = spec({ cooldownMs: 1_000 });

    expect(gate.consume("wheel.spin", cooling, viewer, 0).ok).toBe(true);
    const second = gate.consume("wheel.spin", cooling, viewer, 1_000);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    second.release();
    // Back to the first use's stamp, not to no stamp at all.
    expect(gate.consume("wheel.spin", cooling, viewer, 1_001).ok).toBe(true);
    expect(gate.consume("wheel.spin", cooling, viewer, 1_002).ok).toBe(false);
  });

  it("a failed charge leaves the cooldown exactly as it was", () => {
    const rich: Author = { id: "rich", name: "Rich" };
    const ledger = fakeLedger({ u1: 100, rich: 500 });
    const gate = new CommandGate(ledger);
    const priced = spec({ cost: 500, cooldownMs: 1_000 });

    expect(gate.consume("wheel.spin", priced, viewer, 0).ok).toBe(false);
    expect(ledger.log).toEqual([]);
    // Being too poor must not start a cooldown that blocks everyone else.
    expect(gate.consume("wheel.spin", priced, rich, 1).ok).toBe(true);
    expect(ledger.balance("rich")).toBe(0);
  });

  it("release is a no-op for a free command with no cooldown", () => {
    const ledger = fakeLedger({ u1: 10 });
    const gate = new CommandGate(ledger);
    const result = gate.consume("wheel.spin", spec(), viewer, 0);
    expect(result.ok).toBe(true);
    if (result.ok) result.release();
    expect(ledger.balance("u1")).toBe(10);
    expect(ledger.log).toEqual([]);
  });
});
