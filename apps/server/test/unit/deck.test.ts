import { describe, expect, it } from "vitest";
import { CORE_ACTIONS, DECK_ID, MAX_DECK_SLOTS, type DeckSlot } from "@saarathi/shared";
import { Deck, deckCommand } from "../../src/core/deck.js";
import { MemoryStore } from "../../src/core/store.js";
import { testLogger } from "../helpers/logger.js";

interface Built {
  deck: Deck;
  store: MemoryStore;
  log: ReturnType<typeof testLogger>;
  changes: number;
}

function build(saved?: unknown): Built {
  const store = new MemoryStore();
  if (saved !== undefined) store.write(DECK_ID, { slots: saved });
  const log = testLogger();
  const built = { store, log, changes: 0 } as Built;
  built.deck = new Deck(store, log, () => (built.changes += 1));
  return built;
}

const spin = { action: "wheel.spin", label: "Spin", icon: "🎡" };

/** What `deckSet` actually receives: one JSON string in `args[0]`. */
const save = (deck: Deck, slots: unknown) =>
  deckCommand(deck, CORE_ACTIONS.deckSet, [JSON.stringify(slots)]);

describe("saving her deck", () => {
  it("keeps the buttons in the order she put them in", () => {
    const { deck } = build();
    expect(save(deck, [spin, { action: CORE_ACTIONS.obsScene, args: ["BRB"], label: "BRB" }])).toEqual({
      ok: true,
    });
    expect(deck.view().slots.map((slot) => slot.label)).toEqual(["Spin", "BRB"]);
  });

  it("fills in the parts she left out", () => {
    const { deck } = build();
    save(deck, [{ action: "wheel.spin", label: "  Spin  " }]);
    expect(deck.view().slots[0]).toEqual({ action: "wheel.spin", args: [], label: "Spin", icon: "" });
  });

  it("leaves arguments exactly as they came, spaces and all", () => {
    const { deck } = build();
    save(deck, [{ action: CORE_ACTIONS.obsScene, args: [" Just Chatting "], label: "Chat" }]);
    expect(deck.view().slots[0]!.args).toEqual([" Just Chatting "]);
  });

  it("lets her empty the grid, because that is the way out of a full one", () => {
    const { deck } = build([spin]);
    expect(save(deck, [])).toEqual({ ok: true });
    expect(deck.view().slots).toEqual([]);
  });

  it("says so when a button has no label", () => {
    const { deck } = build();
    const result = save(deck, [spin, { action: "wheel.spin", label: "   " }]);
    expect(result).toMatchObject({ ok: false });
    expect(result!.ok ? "" : result!.reason).toBe("Button 2 needs a label.");
  });

  it("refuses something that could never be an action", () => {
    const { deck } = build();
    const result = save(deck, [{ action: "spin", label: "Spin" }]);
    expect(result!.ok ? "" : result!.reason).toContain('points at "spin", which is not an action');
  });

  it("refuses arguments that are not text", () => {
    const { deck } = build();
    const result = save(deck, [{ action: "wheel.spin", args: [7], label: "Spin" }]);
    expect(result!.ok ? "" : result!.reason).toContain("arguments that are not text");
  });

  it("refuses a grid past the cap, and says how far past", () => {
    const { deck } = build();
    const tooMany = Array.from({ length: MAX_DECK_SLOTS + 1 }, () => spin);
    const result = save(deck, tooMany);
    expect(result!.ok ? "" : result!.reason).toBe(
      `That is ${MAX_DECK_SLOTS + 1} buttons. The deck holds ${MAX_DECK_SLOTS}.`,
    );
    expect(deck.view().slots).toEqual([]);
  });

  it("changes nothing at all when one button is bad", () => {
    const built = build([spin]);
    save(built.deck, [
      { action: "wheel.clear", label: "Clear" },
      { action: "nope", label: "Nope" },
    ]);
    expect(built.deck.view().slots.map((slot) => slot.action)).toEqual(["wheel.spin"]);
    // Nothing republished either: a client that was told the grid changed and
    // then handed the old one back is a client that flickers for no reason.
    expect(built.changes).toBe(0);
  });

  it("survives a save that arrived as something other than a list", () => {
    const { deck } = build();
    expect(deckCommand(deck, CORE_ACTIONS.deckSet, ["not json at all"])).toMatchObject({ ok: false });
    expect(deckCommand(deck, CORE_ACTIONS.deckSet, ['{"slots":[]}'])).toMatchObject({ ok: false });
    expect(deck.view().slots).toEqual([]);
  });

  it("is not the one to answer for an action it does not own", () => {
    const { deck } = build();
    expect(deckCommand(deck, CORE_ACTIONS.obsScene, ["Workout"])).toBeNull();
  });

  it("hands out a copy, so nothing outside can edit the grid in place", () => {
    const { deck } = build([{ ...spin, args: ["one"] }]);
    deck.view().slots[0]!.args.push("two");
    expect(deck.view().slots[0]!.args).toEqual(["one"]);
  });
});

describe("what was saved last time", () => {
  it("comes back", () => {
    const { deck, store } = build();
    save(deck, [spin]);
    const again = new Deck(store, testLogger(), () => {});
    expect(again.view().slots[0]).toMatchObject({ action: "wheel.spin", label: "Spin" });
  });

  it("keeps a grid already over the cap until the next time she saves", () => {
    const saved: DeckSlot[] = Array.from({ length: MAX_DECK_SLOTS + 5 }, () => ({
      ...spin,
      args: [],
    }));
    const { deck } = build(saved);
    expect(deck.view().slots).toHaveLength(MAX_DECK_SLOTS + 5);
  });

  it("drops a button that would render as a hole, and says which", () => {
    const { deck, log } = build([spin, { action: "wheel.spin" }, null]);
    expect(deck.view().slots).toHaveLength(1);
    expect(log.lines.filter((line) => line.startsWith("warn"))).toHaveLength(2);
  });

  it("starts empty when the file has nothing to say about a deck", () => {
    expect(build().deck.view().slots).toEqual([]);
    expect(build("not a list").deck.view().slots).toEqual([]);
  });
});

describe("the key she puts on a button", () => {
  it("saves one of ours and reads it back", () => {
    const { deck } = build();
    expect(save(deck, [{ ...spin, hotkey: "Control+Alt+1" }])).toEqual({ ok: true });
    expect(deck.view().slots[0]!.hotkey).toBe("Control+Alt+1");
  });

  it("leaves the field absent rather than blank when she picks no key", () => {
    // The editor compares the field directly to decide whether Save has
    // anything to do, so "" against undefined would read as unsaved forever.
    const { deck } = build();
    save(deck, [{ ...spin, hotkey: "  " }]);
    expect("hotkey" in deck.view().slots[0]!).toBe(false);
  });

  it("refuses a key the tray could not register, before the tray has to try", () => {
    // globalShortcut.register throws on a string it cannot parse, and the
    // shell is the one place a throw has nowhere to be reported.
    const { deck } = build();
    const result = save(deck, [{ ...spin, hotkey: "Ctrl+Shift+Banana" }]);
    expect(result).toEqual({
      ok: false,
      reason: "Button 1 wants a key this app cannot register.",
    });
    expect(deck.view().slots).toEqual([]);
  });

  it("refuses two buttons on one key, naming both in words she can see", () => {
    const { deck } = build();
    expect(
      save(deck, [
        { ...spin, hotkey: "F13" },
        { action: CORE_ACTIONS.obsScene, args: ["BRB"], label: "BRB", hotkey: "F13" },
      ]),
    ).toEqual({ ok: false, reason: 'F13 is on "Spin" already. One key, one button.' });
  });

  it("lets her move a key from one button to another in one save", () => {
    const { deck } = build();
    save(deck, [{ ...spin, hotkey: "F13" }]);
    expect(
      save(deck, [spin, { action: CORE_ACTIONS.obsScene, args: ["BRB"], label: "BRB", hotkey: "F13" }]),
    ).toEqual({ ok: true });
    expect(deck.view().slots.map((slot) => slot.hotkey)).toEqual([undefined, "F13"]);
  });

  it("drops a saved key it no longer knows, and keeps the button", () => {
    // Her buttons outlive a build that stopped offering a key. Losing the
    // button over it would be losing something she made.
    const { deck } = build([{ ...spin, hotkey: "Control+Alt+Nope" }]);
    expect(deck.view().slots).toEqual([{ action: "wheel.spin", args: [], label: "Spin", icon: "🎡" }]);
  });
});
