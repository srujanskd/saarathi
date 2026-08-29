import { describe, expect, it } from "vitest";
import { MAX_DECK_SLOTS, type DeckSlot, type ModuleStatus } from "@saarathi/shared";
import {
  OBS_SCENE_ACTION,
  actionChoices,
  append,
  describeAction,
  editAt,
  encodeGrid,
  gridNote,
  hasScene,
  move,
  removeAt,
  sameGrid,
  sceneSlot,
} from "../../src/core/deckDraft.js";

const slot = (over: Partial<DeckSlot> = {}): DeckSlot => ({
  action: "wheel.spin",
  args: [],
  label: "Spin",
  icon: "",
  ...over,
});

const grid = (...labels: string[]): DeckSlot[] => labels.map((label) => slot({ label }));
const labels = (slots: DeckSlot[]): string[] => slots.map((s) => s.label);

const moduleStatus = (over: Partial<ModuleStatus>): ModuleStatus => ({
  id: "wheel",
  title: "Challenge wheel",
  enabled: true,
  armed: true,
  arming: false,
  actions: [],
  commands: [],
  ...over,
});

describe("the grid she is editing", () => {
  it("travels as the one JSON string `core.deckSet` parses", () => {
    expect(JSON.parse(encodeGrid([slot({ icon: "🎡" })]))).toEqual([
      { action: "wheel.spin", args: [], label: "Spin", icon: "🎡" },
    ]);
  });
});

describe("whether she has unsaved changes", () => {
  it("says no for a draft nobody has touched", () => {
    const saved = grid("Spin", "Clear");
    expect(sameGrid([...saved], saved)).toBe(true);
  });

  it("does not depend on the order the fields were written in", () => {
    const written = [{ icon: "", label: "Spin", args: [], action: "wheel.spin" }];
    // The same button, keyed the other way round. Comparing the JSON would
    // call this a change and sit an "unsaved" badge on a grid she never edited.
    expect(sameGrid(written, [slot()])).toBe(true);
  });

  it("notices a renamed button, a new icon, and a reorder", () => {
    const saved = grid("Spin", "Clear");
    expect(sameGrid(editAt(saved, 0, { label: "Go" }), saved)).toBe(false);
    expect(sameGrid(editAt(saved, 1, { icon: "🧹" }), saved)).toBe(false);
    expect(sameGrid(move(saved, 0, 1), saved)).toBe(false);
  });

  it("notices an argument changing under an unchanged label", () => {
    const before = [slot({ action: OBS_SCENE_ACTION, args: ["BRB"], label: "Back soon" })];
    const after = [slot({ action: OBS_SCENE_ACTION, args: ["Away"], label: "Back soon" })];
    expect(sameGrid(before, after)).toBe(false);
  });
});

describe("rearranging it", () => {
  it("moves a button one place with one tap", () => {
    expect(labels(move(grid("a", "b", "c"), 2, 1))).toEqual(["a", "c", "b"]);
    expect(labels(move(grid("a", "b", "c"), 0, 1))).toEqual(["b", "a", "c"]);
  });

  it("does nothing at the ends, because those arrows are still thumb-sized", () => {
    const saved = grid("a", "b");
    expect(move(saved, 0, -1)).toBe(saved);
    expect(move(saved, 1, 2)).toBe(saved);
    expect(move(saved, 1, 1)).toBe(saved);
  });

  it("removes one button and leaves the rest in order", () => {
    expect(labels(removeAt(grid("a", "b", "c"), 1))).toEqual(["a", "c"]);
  });

  it("edits one field of one button and touches nothing else", () => {
    const next = editAt(grid("a", "b"), 1, { icon: "🎡" });
    expect(next[0]).toEqual(slot({ label: "a" }));
    expect(next[1]).toEqual(slot({ label: "b", icon: "🎡" }));
  });

  it("leaves the button it edited alone, so the draft never rewrites the socket's copy", () => {
    const saved = grid("a", "b");
    const next = editAt(saved, 0, { label: "x" });
    expect(next[0]).not.toBe(saved[0]);
    expect(saved[0]!.label).toBe("a");
  });

  it("never mutates the grid it was given", () => {
    const saved = grid("a", "b", "c");
    move(saved, 0, 2);
    removeAt(saved, 0);
    editAt(saved, 0, { label: "x" });
    append(saved, slot({ label: "d" }));
    expect(labels(saved)).toEqual(["a", "b", "c"]);
  });
});

describe("the scene button the OBS card writes", () => {
  it("labels itself with the scene, because that is what she called it in OBS", () => {
    expect(sceneSlot("BRB")).toEqual({
      action: OBS_SCENE_ACTION,
      args: ["BRB"],
      label: "BRB",
      icon: "",
    });
  });

  it("knows a scene that is already on the deck", () => {
    const saved = [sceneSlot("BRB"), slot()];
    expect(hasScene(saved, "BRB")).toBe(true);
    expect(hasScene(saved, "Workout")).toBe(false);
  });

  it("does not confuse a scene with another action that mentions it", () => {
    // Same argument, different action. Two buttons that do different things
    // are two buttons, whatever they are pointed at.
    expect(hasScene([slot({ action: "wheel.setChallenges", args: ["BRB"] })], "BRB")).toBe(false);
  });
});

describe("the action picker", () => {
  it("groups actions under the module that declared them", () => {
    expect(
      actionChoices([
        moduleStatus({ actions: [{ id: "wheel.spin", label: "Spin the wheel" }] }),
        moduleStatus({ id: "chatlog", title: "Chat", actions: [] }),
      ]),
    ).toEqual([{ title: "Challenge wheel", actions: [{ id: "wheel.spin", label: "Spin the wheel" }] }]);
  });

  it("still offers a switched-off module's actions", () => {
    // Switching a game off is reversible, and a button is a saved action id.
    // A picker that hid them would be a worse lie than the refusal she gets
    // from pressing one.
    const choices = actionChoices([
      moduleStatus({ enabled: false, actions: [{ id: "wheel.spin", label: "Spin the wheel" }] }),
    ]);
    expect(choices[0]!.actions).toHaveLength(1);
  });
});

describe("what a saved button says it does", () => {
  const groups = actionChoices([
    moduleStatus({ actions: [{ id: "wheel.spin", label: "Spin the wheel" }] }),
  ]);

  it("uses the module's own words", () => {
    expect(describeAction(slot(), groups)).toBe("Spin the wheel");
  });

  it("names a core action rather than showing her its id", () => {
    expect(describeAction(slot({ action: OBS_SCENE_ACTION, args: ["BRB"] }), groups)).toBe(
      "OBS scene · BRB",
    );
  });

  it("falls back to the id, so a button for a game that is gone can be found and removed", () => {
    expect(describeAction(slot({ action: "bingo.start" }), groups)).toBe("bingo.start");
  });
});

describe("the cap, in the fold", () => {
  it("counts what she has, singular and plural", () => {
    expect(gridNote(0)).toBe("0 buttons");
    expect(gridNote(1)).toBe("1 button");
    expect(gridNote(3)).toBe("3 buttons");
  });

  it("says the refusal itself once she is over it", () => {
    expect(gridNote(MAX_DECK_SLOTS)).toBe(`${MAX_DECK_SLOTS} buttons`);
    expect(gridNote(MAX_DECK_SLOTS + 1)).toContain(`A deck holds ${MAX_DECK_SLOTS} buttons`);
    expect(gridNote(MAX_DECK_SLOTS + 1)).toContain(`has ${MAX_DECK_SLOTS + 1}`);
  });
});
