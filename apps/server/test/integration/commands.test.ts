import { afterEach, describe, expect, it } from "vitest";
import { CORE_ID, SPIN_COOLDOWN_MS, type ChatLogState } from "@saarathi/shared";
import { harness, wheelState, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
});

async function start() {
  live = await harness();
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
    expect(state.spin!.via).toBe("chat");
    expect(state.spin!.by).toBe("TestViewer");
    expect(state.challenges).toContain(state.spin!.label);
  });

  it("records the spin in history at the same moment", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();

    const state = wheelState(h.kernel);
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ label: state.spin!.label, via: "chat" });
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

describe("the cooldown belongs to the binding", () => {
  it("refuses a second !spin and tells chat why", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();
    h.seen.clear();

    h.chat("!spin");
    await settled();

    const said = h.seen.said();
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("@TestViewer");
    expect(said[0]).toContain("cooling down");
    expect(h.seen.effectsNamed("spin-started")).toHaveLength(0);
  });

  it("applies to chat as a whole, not per viewer", async () => {
    const h = await start();
    h.chat({ author: "First", text: "!spin" });
    await settled();
    h.seen.clear();

    h.chat({ author: "Second", text: "!spin" });
    await settled();
    expect(h.seen.said()[0]).toContain("cooling down");
  });

  it("does not stand in the way of her own control page", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();

    // The wheel is busy, so this is refused by the spin rules -- but for the
    // wheel being busy, never for a cooldown she is not subject to.
    const result = await h.kernel.invoke("wheel.cancel");
    expect(result).toEqual({ ok: true });

    const second = await h.kernel.invoke("wheel.spin");
    expect(second).toEqual({ ok: true });
    expect(wheelState(h.kernel).spin!.via).toBe("control");
  });

  it("quotes the cooldown length her control page shows", async () => {
    const h = await start();
    const spin = h.kernel
      .coreState()
      .modules.find((m) => m.id === "wheel")!
      .commands.find((c) => c.name === "spin");
    expect(spin).toMatchObject({ action: "wheel.spin", cooldownMs: SPIN_COOLDOWN_MS });
  });
});

describe("refusals are legible", () => {
  it("refuses an empty challenge list rather than leaving a dead wheel", async () => {
    const h = await start();
    const result = await h.kernel.invoke("wheel.setChallenges", { args: ["  ", ""] });
    expect(result).toEqual({ ok: false, reason: "A wheel needs at least one challenge" });
    expect(wheelState(h.kernel).challenges.length).toBeGreaterThan(0);
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

  it("hides an action marked hidden from her button grids", async () => {
    const h = await start();
    const wheel = h.kernel.coreState().modules.find((m) => m.id === "wheel")!;
    expect(wheel.actions.map((a) => a.id)).not.toContain("wheel.setChallenges");
    // Still invocable by id, because her challenge editor needs it.
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
