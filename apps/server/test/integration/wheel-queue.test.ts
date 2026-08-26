import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUE, SPIN_DURATION_MS } from "@saarathi/shared";
import { SETTLE_MS } from "../../src/modules/wheel/rules.js";
import { harness, wheelState, type Harness } from "../helpers/kernel.js";

/** How long the wheel stays busy after a spin starts. */
const BUSY_MS = SPIN_DURATION_MS + SETTLE_MS;

let live: Harness | null = null;

beforeEach(() => {
  // Fake timers so a 6s spin does not cost 6s, and so drain's rescheduling is
  // observable rather than a race.
  vi.useFakeTimers();
});

afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

async function start() {
  live = await harness();
  return live;
}

/** Let queued microtasks run without advancing the fake clock. */
const settled = () => vi.advanceTimersByTimeAsync(0);

describe("free triggers are refused when the wheel is busy", () => {
  // The !spin cooldown (45s) outlasts the busy window (7s), so a chat trigger
  // is turned away by the gate long before the wheel itself would refuse it.
  // Either way it must not end up in the paid queue.
  it("refuses a second chat spin outright rather than queueing it", async () => {
    const h = await start();
    h.chat({ author: "A", text: "!spin" });
    await settled();

    h.chat({ author: "B", text: "!spin" });
    await settled();

    expect(wheelState(h.kernel).queue).toEqual([]);
    expect(h.seen.said().join(" ")).toContain("cooling down");
  });

  it("refuses a free gains-style trigger by name once the wheel is busy", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    const result = await h.kernel.invoke("wheel.spin", { via: "auto", by: "timer" });
    expect(result).toEqual({ ok: false, reason: "The wheel is still spinning" });
    expect(wheelState(h.kernel).queue).toEqual([]);
  });

  it("refuses her own control-page spin while the wheel is busy", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    const result = await h.kernel.invoke("wheel.spin");
    expect(result).toEqual({ ok: false, reason: "The wheel is still spinning" });
    expect(wheelState(h.kernel).queue).toEqual([]);
  });
});

describe("paid triggers wait their turn", () => {
  it("spins straight away when the wheel is free", async () => {
    const h = await start();
    h.chat({ author: "Tipper", text: "thanks", type: "superchat" });
    await settled();

    const state = wheelState(h.kernel);
    expect(state.spin).toMatchObject({ by: "Tipper", via: "paid" });
    expect(state.queue).toEqual([]);
  });

  it("ignores the !spin cooldown, because she was paid for it", async () => {
    const h = await start();
    h.chat("!spin");
    await settled();
    await h.kernel.invoke("wheel.cancel");

    h.chat({ author: "Tipper", text: "again", type: "superchat" });
    await settled();
    expect(wheelState(h.kernel).spin).toMatchObject({ via: "paid" });
  });

  it("queues a paid spin that arrives mid-spin, and says where in line it is", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    h.seen.clear();

    h.chat({ author: "Tipper", text: "take it", type: "superchat" });
    await settled();

    expect(wheelState(h.kernel).queue).toEqual([
      { by: "Tipper", via: "paid", at: expect.any(Number) },
    ]);
    expect(h.seen.effectsNamed("spin-queued")[0]!.payload).toEqual({ by: "Tipper", position: 1 });
  });

  it("runs the queued spin the moment the wheel frees up, with nobody watching", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    h.chat({ author: "Tipper", text: "take it", type: "superchat" });
    await settled();

    await vi.advanceTimersByTimeAsync(BUSY_MS);

    const state = wheelState(h.kernel);
    expect(state.queue).toEqual([]);
    expect(state.spin).toMatchObject({ by: "Tipper", via: "paid" });
    expect(state.history).toHaveLength(2);
  });

  it("does not run it early", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    h.chat({ author: "Tipper", text: "take it", type: "superchat" });
    await settled();

    await vi.advanceTimersByTimeAsync(BUSY_MS - 1);
    expect(wheelState(h.kernel).queue).toHaveLength(1);
  });

  it("drains several in order, one spin apart", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    for (const author of ["First", "Second", "Third"]) {
      h.chat({ author, text: "money", type: "superchat" });
    }
    await settled();
    expect(wheelState(h.kernel).queue.map((q) => q.by)).toEqual(["First", "Second", "Third"]);

    await vi.advanceTimersByTimeAsync(BUSY_MS);
    expect(wheelState(h.kernel).spin!.by).toBe("First");

    await vi.advanceTimersByTimeAsync(BUSY_MS);
    expect(wheelState(h.kernel).spin!.by).toBe("Second");

    await vi.advanceTimersByTimeAsync(BUSY_MS);
    expect(wheelState(h.kernel).spin!.by).toBe("Third");
    expect(wheelState(h.kernel).queue).toEqual([]);
  });

  it("caps the queue, so a spammer cannot commit her to an hour of burpees", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    for (let i = 0; i < MAX_QUEUE + 5; i++) {
      h.chat({ author: `Tipper${i}`, text: "money", type: "superchat" });
    }
    await settled();

    expect(wheelState(h.kernel).queue).toHaveLength(MAX_QUEUE);
    expect(h.log.text()).toContain("queue is full");
  });

  it("cancelling the current spin lets the queue move immediately", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    h.chat({ author: "Tipper", text: "money", type: "superchat" });
    await settled();

    await h.kernel.invoke("wheel.cancel");
    await settled();

    expect(wheelState(h.kernel).queue).toEqual([]);
    expect(wheelState(h.kernel).spin).toMatchObject({ by: "Tipper" });
  });

  it("lets her drop the queue, and the way out is reversible from her page", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    h.chat({ author: "Tipper", text: "money", type: "superchat" });
    await settled();

    expect(await h.kernel.invoke("wheel.clearQueue")).toEqual({ ok: true });
    expect(wheelState(h.kernel).queue).toEqual([]);

    // Dropped means dropped: the drain must not resurrect it later.
    await vi.advanceTimersByTimeAsync(BUSY_MS * 2);
    expect(wheelState(h.kernel).queue).toEqual([]);
  });
});

describe("every trigger lands in the same action", () => {
  const cases = [
    ["chat", async (h: Harness) => void h.chat("!spin")],
    ["paid", async (h: Harness) => void h.chat({ text: "money", type: "superchat" })],
    ["control", async (h: Harness) => void (await h.kernel.invoke("wheel.spin"))],
    [
      "deck",
      async (h: Harness) => void (await h.kernel.invoke("wheel.spin", { via: "deck", by: "Deck" })),
    ],
  ] as const;

  for (const [name, trigger] of cases) {
    it(`${name} produces a spin, a history entry and one effect`, async () => {
      const h = await start();
      await trigger(h);
      await settled();

      const state = wheelState(h.kernel);
      expect(state.spin, name).not.toBeNull();
      expect(state.history, name).toHaveLength(1);
      expect(h.seen.effectsNamed("spin-started"), name).toHaveLength(1);
    });
  }

  it("records which trigger it was, for her history page", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin", { via: "deck", by: "Deck" });
    expect(wheelState(h.kernel).history[0]).toMatchObject({ via: "deck", by: "Deck" });
  });
});

describe("a spin the overlay can join late", () => {
  it("leaves enough in state for a browser source to work out where it is", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");

    const spin = wheelState(h.kernel).spin!;
    expect(spin.startedAt).toBeTypeOf("number");
    expect(spin.durationMs).toBe(SPIN_DURATION_MS);
    expect(spin.index).toBeGreaterThanOrEqual(0);
    expect(spin.index).toBeLessThan(wheelState(h.kernel).challenges.length);
  });

  it("keeps the finished spin on screen rather than nulling it out", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    await vi.advanceTimersByTimeAsync(BUSY_MS * 2);
    expect(wheelState(h.kernel).spin).not.toBeNull();
  });
});
