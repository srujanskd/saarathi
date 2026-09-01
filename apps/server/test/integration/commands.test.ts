import { afterEach, describe, expect, it } from "vitest";
import { CORE_ID, GAINS, MAX_CHALLENGES, SPIN_COST, type ChatLogState } from "@saarathi/shared";
import { harness, wheelState, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
});

/**
 * !spin is priced, so a viewer with an empty ledger cannot reach the action at
 * all. Every test here that chats one starts them able to afford a few.
 */
async function start(balances: Record<string, number> = { TestViewer: SPIN_COST * 4 }) {
  live = await harness({ balances });
  return live;
}

/** The kernel dispatches on a microtask, so give it one before asserting. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("chat commands reach the action", () => {
  it("spins the wheel on !spin", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();

    const state = wheelState(h.kernel);
    expect(state.spin).not.toBeNull();
    // "gains", not "chat": the gate charged for it, so downstream it is a paid
    // trigger and the wheel treats it like one.
    expect(state.spin!.via).toBe("gains");
    expect(state.spin!.by).toBe("TestViewer");
    expect(state.challenges).toContain(state.spin!.label);
  });

  it("records the spin in history at the same moment", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();

    const state = wheelState(h.kernel);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ label: state.spin!.label, via: "gains" });
  });

  it("announces the spin as an effect the overlay can hear", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();

    const started = h.seen.effectsNamed("spin-started");
    expect(started).toHaveLength(1);
    expect(started[0]!.module).toBe("wheel");
    expect(started[0]!.payload).toEqual({ label: wheelState(h.kernel).spin!.label });
  });

  it("is case-insensitive about the command", async () => {
    const h = await start();
    h.chat("!SPIN");
    await settled();
    expect(wheelState(h.kernel).spin).not.toBeNull();
  });

  it("ignores a command no module claims, silently", async () => {
    const h = await start();
    h.chat("!nonsense");
    await settled();
    expect(h.seen.said()).toEqual([]);
    expect(wheelState(h.kernel).spin).toBeNull();
  });

  it("ignores ordinary chat", async () => {
    const h = await start();
    h.chat("spin the wheel please");
    await settled();
    expect(wheelState(h.kernel).spin).toBeNull();
  });
});

describe("a command is not also a message", () => {
  const events = (h: Harness) => (h.kernel.snapshot().modules.chatlog as ChatLogState).events;

  it("logs a command once, as a command", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();

    const logged = events(h);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ type: "chat-command", command: "spin", args: [] });
  });

  it("keeps the original text on the promoted event", async () => {
    const h = await start();
    h.chat("!spend 500 spin");
    await settled();
    expect(events(h)[0]).toMatchObject({
      type: "chat-command",
      command: "spend",
      args: ["500", "spin"],
      text: "!spend 500 spin",
    });
  });

  it("logs plain chat as a message", async () => {
    const h = await start();
    h.chat("hello");
    await settled();
    expect(events(h)[0]).toMatchObject({ type: "chat-message", text: "hello" });
  });

  it("keeps the newest first", async () => {
    const h = await start();
    h.chat("first");
    h.chat("second");
    await settled();
    expect(events(h).map((e) => (e as { text: string }).text)).toEqual(["second", "first"]);
  });
});

describe("the price belongs to the binding", () => {
  it("takes the gains and spins", async () => {
    const h = await start({ TestViewer: SPIN_COST });
    h.chat("!spin");
    await settled();

    expect(wheelState(h.kernel).spin).not.toBeNull();
    expect(h.balance("TestViewer")).toBe(0);
  });

  it("refuses a viewer who cannot afford it, and says both numbers", async () => {
    const h = await start({ TestViewer: SPIN_COST - 1 });
    h.chat("!spin");
    await settled();

    const said = h.seen.said();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("@TestViewer");
    expect(said[0]).toContain(String(SPIN_COST));
    expect(said[0]).toContain(String(SPIN_COST - 1));
    expect(said[0]).toContain(GAINS.plural);
    expect(wheelState(h.kernel).spin).toBeNull();
    // Refused means not charged. A viewer who was told no still has their gains.
    expect(h.balance("TestViewer")).toBe(SPIN_COST - 1);
  });

  it("charges the spender and nobody else, unlike the cooldown it replaced", async () => {
    const h = await start({ First: SPIN_COST, Second: SPIN_COST });
    h.chat({ author: "First", text: "!spin" });
    await settled();

    expect(h.balance("First")).toBe(0);
    expect(h.balance("Second")).toBe(SPIN_COST);

    // And the second viewer is not locked out by the first one's turn: their
    // own balance is the only thing standing between them and the wheel.
    await h.kernel.invoke("wheel.cancel");
    h.chat({ author: "Second", text: "!spin" });
    await settled();
    expect(h.balance("Second")).toBe(0);
    expect(wheelState(h.kernel).spin!.by).toBe("Second");
  });

  it("does not stand in the way of her own control page", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();

    // The wheel is busy, so this is refused by the spin rules -- but for the
    // wheel being busy, never for a price she is not subject to.
    const result = await h.kernel.invoke("wheel.cancel");
    expect(result).toEqual({ ok: true });

    const second = await h.kernel.invoke("wheel.spin");
    expect(second).toEqual({ ok: true });
    expect(wheelState(h.kernel).spin!.via).toBe("control");
  });

  it("quotes the price her control page shows, and no cooldown beside it", async () => {
    const h = await start();
    const spin = h.kernel
      .coreState()
      .modules.find((m) => m.id === "wheel")!
      .commands.find((c) => c.name === "spin");
    expect(spin).toMatchObject({ action: "wheel.spin", cost: SPIN_COST });
    expect(spin!.cooldownMs).toBeUndefined();
  });
});

describe("refusals are legible", () => {
  it("refuses an empty challenge list rather than leaving a dead wheel", async () => {
    const h = await start();
    const result = await h.kernel.invoke("wheel.setChallenges", { args: ["  ", ""] });
    expect(result).toEqual({ ok: false, reason: "A wheel needs at least one challenge" });
    expect(wheelState(h.kernel).challenges.length).toBeGreaterThan(0);
  });

  it("refuses a list past the cap, and keeps the one she is running", async () => {
    const h = await start();
    const before = wheelState(h.kernel).challenges;
    const tooMany = Array.from({ length: MAX_CHALLENGES + 1 }, (_, i) => `challenge ${i}`);
    const result = await h.kernel.invoke("wheel.setChallenges", { args: tooMany });
    expect(result).toEqual({
      ok: false,
      reason: `A wheel holds ${MAX_CHALLENGES} challenges \u2014 that list has ${tooMany.length}`,
    });
    expect(wheelState(h.kernel).challenges).toEqual(before);
  });

  it("takes a list that is exactly the cap, so the limit is not off by one", async () => {
    const h = await start();
    const full = Array.from({ length: MAX_CHALLENGES }, (_, i) => `challenge ${i}`);
    expect(await h.kernel.invoke("wheel.setChallenges", { args: full })).toEqual({ ok: true });
    expect(wheelState(h.kernel).challenges).toEqual(full);
  });

  it("counts what it saves, so blank lines do not spend the budget", async () => {
    const h = await start();
    const padded = Array.from({ length: MAX_CHALLENGES }, (_, i) => `challenge ${i}`).flatMap(
      (line) => [line, "   "],
    );
    expect(await h.kernel.invoke("wheel.setChallenges", { args: padded })).toEqual({ ok: true });
    expect(wheelState(h.kernel).challenges).toHaveLength(MAX_CHALLENGES);
  });

  it("refuses cancel with nothing on the wheel", async () => {
    const h = await start();
    const result = await h.kernel.invoke("wheel.cancel");
    expect(result).toEqual({ ok: false, reason: "Nothing is on the wheel right now" });
  });

  it("refuses clearQueue with nothing queued", async () => {
    const h = await start();
    const result = await h.kernel.invoke("wheel.clearQueue");
    expect(result).toEqual({ ok: false, reason: "Nothing is queued" });
  });

  it("names the module and action it could not find", async () => {
    const h = await start();
    expect(await h.kernel.invoke("nope.spin")).toEqual({ ok: false, reason: 'There is no "nope"' });
    expect(await h.kernel.invoke("wheel.nope")).toMatchObject({ ok: false });
    expect(await h.kernel.invoke("spin")).toMatchObject({ ok: false });
    expect(await h.kernel.invoke(".spin")).toMatchObject({ ok: false });
  });
});

describe("core state a client renders", () => {
  it("lists every module with its actions and commands", async () => {
    const h = await start();
    const core = h.kernel.coreState();
    expect(core.modules.map((m) => m.id).sort()).toEqual(["chatlog", "wheel"]);

    const wheel = core.modules.find((m) => m.id === "wheel")!;
    expect(wheel.actions.map((a) => a.id)).toEqual([
      "wheel.spin",
      "wheel.cancel",
      "wheel.clearQueue",
    ]);
    expect(wheel.actions.every((a) => a.label.length > 0)).toBe(true);
  });

  it("keeps an action that needs arguments off her button grids", async () => {
    const h = await start();
    const wheel = h.kernel.coreState().modules.find((m) => m.id === "wheel")!;
    // `ModuleStatus.actions` is what the deck picker and the control page
    // press with no arguments, so an action that needs one cannot be in it:
    // saved as a button it would be a refusal she meets by pressing it.
    expect(wheel.actions.map((a) => a.id)).not.toContain("wheel.setChallenges");
    // Still invocable by id, because her challenge editor knows what to pass.
    expect(await h.kernel.invoke("wheel.setChallenges", { args: ["a"] })).toEqual({ ok: true });
  });

  it("reports mock chat connected, keyed by adapter name", async () => {
    const h = await start();
    expect(h.kernel.coreState().connections.mock).toEqual({
      state: "connected",
      detail: "Mock chat ready",
    });
  });

  it("patches core when a connection changes", async () => {
    const h = await start();
    expect(h.seen.patches.some((p) => p.module === CORE_ID)).toBe(true);
  });

  it("says nothing about a module having a spin in flight: that is the slice's job", async () => {
    const h = await start();
    expect(JSON.stringify(h.kernel.coreState())).not.toContain("squats");
  });
});
