import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUEUE, SPIN_COST, SPIN_DURATION_MS, type QueuedSpin } from "@saarathi/shared";
import { SETTLE_MS } from "../../src/modules/wheel/rules.js";
import { mockAuthorId } from "../../src/chat/mock.js";
import { affordsSpins } from "../helpers/balances.js";
import { MemoryStore } from "../../src/core/store.js";
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

/** !spin is priced, so a chat trigger needs somebody who can afford it. */
async function start(balances: Record<string, number> = {}) {
  live = await harness({ balances });
  return live;
}

/** Let queued microtasks run without advancing the fake clock. */
const settled = () => vi.advanceTimersByTimeAsync(0);

describe("free triggers are refused when the wheel is busy", () => {
  // Her own surfaces are the free ones now: !spin costs gains, so a chat
  // trigger is paid and waits its turn in the block below. Hers does not wait
  // -- she is standing there, and a spin arriving forty seconds later is worse
  // than one that says no now.
  it("refuses a free trigger by name once the wheel is busy", async () => {
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

  it("refuses her deck button too, and never queues it", async () => {
    const h = await start();
    await h.kernel.invoke("wheel.spin");
    const result = await h.kernel.invoke("wheel.spin", { via: "deck", by: "Deck" });
    expect(result).toEqual({ ok: false, reason: "The wheel is still spinning" });
    expect(wheelState(h.kernel).queue).toEqual([]);
  });
});

describe("gains buy a spin, and a bought spin waits", () => {
  it("spins straight away when the wheel is free, and takes the gains", async () => {
    const h = await start(affordsSpins(1, "Asha"));
    h.chat({ author: "Asha", text: "!spin" });
    await settled();

    expect(wheelState(h.kernel).spin).toMatchObject({ by: "Asha", via: "gains" });
    expect(h.balance("Asha")).toBe(0);
  });

  it("queues one that arrives mid-spin rather than taking gains for nothing", async () => {
    const h = await start(affordsSpins(1, "Asha"));
    await h.kernel.invoke("wheel.spin");
    h.seen.clear();

    h.chat({ author: "Asha", text: "!spin" });
    await settled();

    expect(wheelState(h.kernel).queue).toEqual([
      // The entry carries what it is holding, because whoever drops it owes
      // that back and the queue outlives the process that charged it.
      {
        by: "Asha",
        via: "gains",
        at: expect.any(Number),
        charge: { userId: mockAuthorId("Asha"), amount: SPIN_COST },
      },
    ]);
    expect(h.seen.effectsNamed("spin-queued")[0]!.payload).toEqual({ by: "Asha", position: 1 });
    expect(h.balance("Asha")).toBe(0);

    // And the spin they bought actually happens, which is the whole reason it
    // queued instead of being turned away.
    await vi.advanceTimersByTimeAsync(BUSY_MS);
    expect(wheelState(h.kernel).spin).toMatchObject({ by: "Asha", via: "gains" });
  });

  it("gives the gains back when the queue is too full to take the spin", async () => {
    const h = await start(affordsSpins(1, "Asha"));
    await h.kernel.invoke("wheel.spin");
    for (let i = 0; i < MAX_QUEUE; i++) {
      h.chat({ author: `Tipper${i}`, text: "money", type: "superchat" });
    }
    await settled();

    h.chat({ author: "Asha", text: "!spin" });
    await settled();

    expect(wheelState(h.kernel).queue).toHaveLength(MAX_QUEUE);
    expect(h.balance("Asha")).toBe(SPIN_COST);
    expect(h.seen.said().join(" ")).toContain("queue is full");
  });

  it("takes nothing from someone who cannot afford it", async () => {
    const h = await start({ Asha: SPIN_COST - 1 });
    h.chat({ author: "Asha", text: "!spin" });
    await settled();

    expect(wheelState(h.kernel).spin).toBeNull();
    expect(wheelState(h.kernel).queue).toEqual([]);
    expect(h.balance("Asha")).toBe(SPIN_COST - 1);
  });

  it("gives the gains back to everyone whose spin she drops", async () => {
    const h = await start(affordsSpins(1, "Asha", "Bo"));
    await h.kernel.invoke("wheel.spin");
    h.chat({ author: "Asha", text: "!spin" });
    h.chat({ author: "Bo", text: "!spin" });
    h.chat({ author: "Tipper", text: "money", type: "superchat" });
    await settled();

    expect(wheelState(h.kernel).queue).toHaveLength(3);
    expect(h.balance("Asha")).toBe(0);

    await h.kernel.invoke("wheel.clearQueue");
    await settled();

    // She may clear the queue; nobody may be charged for a spin she has just
    // decided will never run. Real money is a different question -- there is no
    // path back for the superchat, which is why it carries no charge.
    expect(h.balance("Asha")).toBe(SPIN_COST);
    expect(h.balance("Bo")).toBe(SPIN_COST);
    expect(h.log.text()).toContain("gave Asha back");
  });

  it("writes the charge to disk with the queue, so a restart still owes it", async () => {
    const store = new MemoryStore();
    const first = await harness({ store, balances: affordsSpins(1, "Asha") });
    await first.kernel.invoke("wheel.spin");
    first.chat({ author: "Asha", text: "!spin" });
    await settled();
    expect(first.balance("Asha")).toBe(0);
    await first.stop();

    // The charge is data on the entry rather than a closure for exactly this:
    // the process that took Asha's gains is gone, and whichever one inherits
    // her spin is the one that owes them back if it never runs it.
    const saved = store.read("wheel")!.queue as QueuedSpin[];
    expect(saved[0]!.charge).toEqual({ userId: mockAuthorId("Asha"), amount: SPIN_COST });

    // And the next boot pays out the spin she bought rather than the gains.
    live = await harness({ store });
    await settled();
    expect(wheelState(live.kernel).spin).toMatchObject({ by: "Asha", via: "gains" });
    expect(live.balance("Asha")).toBe(0);
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

  it("costs no gains, because she was paid real money for it", async () => {
    const h = await start();
    h.chat({ author: "Tipper", text: "take it", type: "superchat" });
    await settled();

    expect(wheelState(h.kernel).spin).toMatchObject({ via: "paid" });
    // The price is on the !spin binding, not on the action, so a superchat
    // reaches the wheel without an account to draw on at all.
    expect(h.balance("Tipper")).toBe(0);
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
    ["chat", async (h: Harness) => void h.chat({ author: "Asha", text: "!spin" })],
    ["paid", async (h: Harness) => void h.chat({ text: "money", type: "superchat" })],
    ["control", async (h: Harness) => void (await h.kernel.invoke("wheel.spin"))],
    [
      "deck",
      async (h: Harness) => void (await h.kernel.invoke("wheel.spin", { via: "deck", by: "Deck" })),
    ],
  ] as const;

  for (const [name, trigger] of cases) {
    it(`${name} produces a spin, a history entry and one effect`, async () => {
      const h = await start(affordsSpins(1, "Asha"));
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
