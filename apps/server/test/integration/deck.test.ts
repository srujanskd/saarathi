import { afterEach, describe, expect, it } from "vitest";
import { CORE_ID, type CoreState, type DeckSlot } from "@saarathi/shared";
import { MemoryStore } from "../../src/core/store.js";
import { harness, wheelState, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
});

const save = (h: Harness, slots: Partial<DeckSlot>[]) =>
  h.kernel.invoke("core.deckSet", { args: [JSON.stringify(slots)] });

const deckOf = (h: Harness) => h.kernel.snapshot().core.deck.slots;

describe("the deck her surfaces render", () => {
  it("rides in the core slice, so every client already has it", async () => {
    live = await harness();
    await save(live, [{ action: "wheel.spin", label: "Spin", icon: "🎡" }]);

    expect(deckOf(live)).toEqual([{ action: "wheel.spin", args: [], label: "Spin", icon: "🎡" }]);
  });

  it("republishes core when it changes, so her other phone sees the edit", async () => {
    live = await harness();
    live.seen.clear();
    await save(live, [{ action: "wheel.spin", label: "Spin" }]);

    const core = live.seen.patches.filter((patch) => patch.module === CORE_ID);
    expect(core).toHaveLength(1);
    expect((core[0]!.state as CoreState).deck.slots[0]!.label).toBe("Spin");
  });

  it("adds no socket event of its own", async () => {
    live = await harness();
    live.seen.clear();
    await save(live, [{ action: "wheel.spin", label: "Spin" }]);

    expect(live.seen.effects).toEqual([]);
  });

  it("comes back after a restart", async () => {
    const store = new MemoryStore();
    const first = await harness({ store });
    await save(first, [{ action: "wheel.spin", label: "Spin" }]);
    await first.stop();

    live = await harness({ store });
    expect(deckOf(live)[0]!.label).toBe("Spin");
  });

  it("tells her which button is wrong rather than saving a broken grid", async () => {
    live = await harness();
    await save(live, [{ action: "wheel.spin", label: "Spin" }]);

    const result = await save(live, [
      { action: "wheel.spin", label: "Spin" },
      { action: "wheel.clear", label: "" },
    ]);

    expect(result).toEqual({ ok: false, reason: "Button 2 needs a label." });
    expect(deckOf(live)).toHaveLength(1);
  });
});

describe("pressing a button", () => {
  /**
   * There is no `deck.press(n)`: a button is a saved `{action, args}` pair and
   * a client invokes it directly. So the thing worth proving is that what the
   * deck stores is exactly what `invoke` takes -- the two agreeing is the whole
   * feature, and the day they stop agreeing every button dies at once.
   */
  it("is the same invoke every other surface makes", async () => {
    live = await harness();
    await save(live, [{ action: "wheel.spin", label: "Spin" }]);

    const [slot] = deckOf(live);
    const result = await live.kernel.invoke(slot!.action, { args: slot!.args, via: "deck" });

    expect(result).toEqual({ ok: true });
    expect(wheelState(live.kernel).spin).not.toBeNull();
    expect(wheelState(live.kernel).spin!.via).toBe("deck");
  });

  it("carries the arguments she saved with it", async () => {
    live = await harness();
    live.obs.arrive(["Workout", "BRB"]);
    await save(live, [{ action: "core.obsScene", args: ["BRB"], label: "Back soon", icon: "☕" }]);

    const [slot] = deckOf(live);
    expect(await live.kernel.invoke(slot!.action, { args: slot!.args, via: "deck" })).toEqual({
      ok: true,
    });
    expect(live.obs.scenes).toEqual(["BRB"]);
  });

  it("refuses in words when it points somewhere that is gone", async () => {
    live = await harness();
    await save(live, [{ action: "boss.hit", label: "Hit" }]);

    const [slot] = deckOf(live);
    const result = await live.kernel.invoke(slot!.action, { args: slot!.args, via: "deck" });

    expect(result).toEqual({ ok: false, reason: 'There is no "boss"' });
  });
});
