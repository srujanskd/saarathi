import { afterEach, describe, expect, it, vi } from "vitest";
import type { GameModuleDef } from "@saarathi/shared";
import { MemoryStore } from "../../src/core/store.js";
import { SETTLE_MS } from "../../src/modules/wheel/rules.js";
import { harness, wheelState, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

const settled = () => new Promise((resolve) => setImmediate(resolve));

describe("what survives a restart", () => {
  it("keeps her challenge list", async () => {
    const store = new MemoryStore();
    const first = await harness({ store });
    await first.kernel.invoke("wheel.setChallenges", { args: ["her own", "list"] });
    await first.stop();

    live = await harness({ store });
    expect(wheelState(live.kernel).challenges).toEqual(["her own", "list"]);
  });

  it("keeps the history of what chat has made her do", async () => {
    const store = new MemoryStore();
    const first = await harness({ store });
    await first.kernel.invoke("wheel.spin");
    const label = wheelState(first.kernel).spin!.label;
    await first.stop();

    live = await harness({ store });
    expect(wheelState(live.kernel).history).toHaveLength(1);
    expect(wheelState(live.kernel).history[0]!.label).toBe(label);
  });

  it("does not leave a stale spin on the overlay", async () => {
    const store = new MemoryStore();
    const first = await harness({ store });
    await first.kernel.invoke("wheel.spin");
    expect(wheelState(first.kernel).spin).not.toBeNull();
    await first.stop();

    live = await harness({ store });
    expect(wheelState(live.kernel).spin).toBeNull();
  });

  it("still owes a spin that was paid for before the shutdown", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const first = await harness({ store });
    await first.kernel.invoke("wheel.spin");
    first.chat({ author: "Tipper", text: "money", type: "superchat" });
    await vi.advanceTimersByTimeAsync(0);
    expect(wheelState(first.kernel).queue).toHaveLength(1);
    await first.stop();

    // The spin in flight is gone, so setup's drain should run it right away.
    live = await harness({ store });
    await vi.advanceTimersByTimeAsync(0);

    expect(wheelState(live.kernel).queue).toEqual([]);
    expect(wheelState(live.kernel).spin).toMatchObject({ by: "Tipper", via: "paid" });
  });

  it("holds a queued spin until there is something on the wheel", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    // Pre-seed the shape a stopped server would have left behind.
    store.write("wheel", {
      challenges: [],
      queue: [{ by: "Tipper", via: "paid", at: 1 }],
      history: [],
    });

    live = await harness({ store });
    await vi.advanceTimersByTimeAsync(60_000);
    // Nobody's money is dropped: it waits rather than being spent on nothing.
    expect(wheelState(live.kernel).queue).toHaveLength(1);
    expect(wheelState(live.kernel).spin).toBeNull();

    await live.kernel.invoke("wheel.setChallenges", { args: ["20 squats"] });
    await vi.advanceTimersByTimeAsync(0);
    expect(wheelState(live.kernel).queue).toEqual([]);
    expect(wheelState(live.kernel).spin).toMatchObject({ by: "Tipper" });
  });

  it("does not keep last week's chat log", async () => {
    const store = new MemoryStore();
    const first = await harness({ store });
    first.chat("hello");
    await settled();
    await first.stop();

    live = await harness({ store });
    expect(live.kernel.snapshot().modules.chatlog).toEqual({ events: [] });
  });

  it("writes only the keys the module declared durable", async () => {
    live = await harness();
    await live.kernel.invoke("wheel.spin");
    const saved = live.store.read("wheel")!;
    expect(Object.keys(saved).sort()).toEqual(["challenges", "history", "queue"]);
    expect(saved).not.toHaveProperty("spin");
  });

  it("writes nothing for a module that declared no durable keys", async () => {
    live = await harness();
    live.chat("hello");
    await settled();
    expect(live.store.read("chatlog")).toBeUndefined();
  });

  it("ignores a saved key the module no longer declares", async () => {
    const store = new MemoryStore();
    store.write("wheel", { challenges: ["kept"], gone: "should not appear" });
    live = await harness({ store });
    const state = wheelState(live.kernel);
    expect(state.challenges).toEqual(["kept"]);
    expect(state).not.toHaveProperty("gone");
  });

  it("falls back to the module's own defaults for a key that was never saved", async () => {
    const store = new MemoryStore();
    store.write("wheel", { challenges: ["kept"] });
    live = await harness({ store });
    expect(wheelState(live.kernel).history).toEqual([]);
    expect(wheelState(live.kernel).queue).toEqual([]);
  });

  it("does not share initial state between two kernels", async () => {
    const a = await harness();
    await a.kernel.invoke("wheel.setChallenges", { args: ["only a"] });
    live = await harness();
    expect(wheelState(live.kernel).challenges.length).toBeGreaterThan(1);
    await a.stop();
  });

  it("flushes the store on the way out", async () => {
    const store = new MemoryStore();
    const flush = vi.spyOn(store, "flush");
    const h = await harness({ store });
    await h.stop();
    expect(flush).toHaveBeenCalled();
  });
});

/** A priced command whose action refuses, to prove the gate is released. */
function pricedRefuser(): GameModuleDef<Record<string, never>> {
  return {
    id: "priced",
    title: "Priced",
    initialState: {},
    commands: [{ name: "buy", action: "buy", cost: 500, cooldownMs: 10_000 }],
    actions: {
      buy: {
        label: "Buy",
        run(_input, ctx) {
          ctx.refuse("Not right now");
        },
      },
    },
  };
}

describe("a refused trigger costs the viewer nothing", () => {
  // Gains loads balances at startup, so the balance goes in before the harness.
  const VIEWER = "mock:TestViewer";
  const withBalance = (amount: number) => {
    const store = new MemoryStore();
    store.write("gains", { balances: { [VIEWER]: amount } });
    return store;
  };

  it("charges before dispatch and refunds when the action refuses", async () => {
    const store = withBalance(500);
    live = await harness({ modules: [pricedRefuser()], store });

    live.chat("!buy");
    await settled();

    expect(store.read("gains")).toEqual({ balances: { [VIEWER]: 500 } });
    expect(live.log.text()).toContain("refund !buy");
    expect(live.seen.said()[0]).toContain("Not right now");
  });

  it("clears the cooldown the refused trigger stamped", async () => {
    live = await harness({ modules: [pricedRefuser()], store: withBalance(5_000) });

    live.chat("!buy");
    await settled();
    live.seen.clear();

    // Well inside the 10s cooldown: it must not be cooling down, because the
    // first attempt never happened as far as the viewer is concerned.
    live.chat("!buy");
    await settled();
    expect(live.seen.said()[0]).toContain("Not right now");
    expect(live.seen.said().join(" ")).not.toContain("cooling down");
  });

  it("refuses outright when they cannot afford it, and says both numbers", async () => {
    const store = withBalance(100);
    live = await harness({ modules: [pricedRefuser()], store });

    live.chat("!buy");
    await settled();
    const said = live.seen.said()[0]!;
    expect(said).toContain("500");
    expect(said).toContain("100");
    expect(store.read("gains")).toEqual({ balances: { [VIEWER]: 100 } });
  });
});

describe("the settle window is not a persisted concern", () => {
  it("is a rule, not state, so nothing about it is written down", async () => {
    live = await harness();
    await live.kernel.invoke("wheel.spin");

    const saved = live.store.read("wheel") as Record<string, unknown>;
    // The declared durable keys and no fourth one. This used to search the
    // stringified slice for "1000" and was flaky for it: a spin writes a
    // history entry stamped with epoch milliseconds, and roughly one
    // timestamp in fifty contains those four digits somewhere in the middle.
    expect(Object.keys(saved).sort()).toEqual(["challenges", "history", "queue"]);
    // And no number under any of them is the window itself. Exact rather than
    // textual, so a timestamp that merely reads like it cannot fail this.
    expect(numbersIn(saved)).not.toContain(SETTLE_MS);
  });
});

/** Every number anywhere in a saved slice, however deeply nested. */
function numbersIn(value: unknown): number[] {
  if (typeof value === "number") return [value];
  if (Array.isArray(value)) return value.flatMap(numbersIn);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(numbersIn);
  return [];
}
