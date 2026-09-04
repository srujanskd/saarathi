import { describe, expect, it } from "vitest";
import {
  CORE_ACTIONS,
  MAX_DECK_SLOTS,
  type DeckSlot,
  type ModuleStatus,
} from "@saarathi/shared";
import {
  actionChoices,
  appendSlot,
  coughMicrophoneSlot,
  deckSizeNote,
  describeAction,
  editSlot,
  encodeGrid,
  findAction,
  hasCoughMicrophone,
  hasMicrophoneAction,
  hasScene,
  hotkeyChoices,
  moveSlot,
  microphoneSlot,
  removeSlot,
  sameGrid,
  sceneSlot,
  setHotkey,
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
  overlay: true,
  enabled: true,
  armed: true,
  arming: false,
  actions: [],
  commands: [],
  ...over,
});

describe("the grid she is editing", () => {
  it("travels as the one JSON string `CORE_ACTIONS.deckSet` parses", () => {
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
    expect(sameGrid(editSlot(saved, 0, { label: "Go" }), saved)).toBe(false);
    expect(sameGrid(editSlot(saved, 1, { icon: "🧹" }), saved)).toBe(false);
    expect(sameGrid(moveSlot(saved, 0, 1), saved)).toBe(false);
  });

  it("notices an argument changing under an unchanged label", () => {
    const before = [slot({ action: CORE_ACTIONS.obsScene, args: ["BRB"], label: "Back soon" })];
    const after = [slot({ action: CORE_ACTIONS.obsScene, args: ["Away"], label: "Back soon" })];
    expect(sameGrid(before, after)).toBe(false);
  });
});

describe("rearranging it", () => {
  it("moves a button one place with one tap", () => {
    expect(labels(moveSlot(grid("a", "b", "c"), 2, 1))).toEqual(["a", "c", "b"]);
    expect(labels(moveSlot(grid("a", "b", "c"), 0, 1))).toEqual(["b", "a", "c"]);
  });

  it("does nothing at the ends, because those arrows are still thumb-sized", () => {
    const saved = grid("a", "b");
    expect(moveSlot(saved, 0, -1)).toBe(saved);
    expect(moveSlot(saved, 1, 2)).toBe(saved);
    expect(moveSlot(saved, 1, 1)).toBe(saved);
  });

  it("removes one button and leaves the rest in order", () => {
    expect(labels(removeSlot(grid("a", "b", "c"), 1))).toEqual(["a", "c"]);
  });

  it("edits one field of one button and touches nothing else", () => {
    const next = editSlot(grid("a", "b"), 1, { icon: "🎡" });
    expect(next[0]).toEqual(slot({ label: "a" }));
    expect(next[1]).toEqual(slot({ label: "b", icon: "🎡" }));
  });

  it("leaves the button it edited alone, so the draft never rewrites the socket's copy", () => {
    const saved = grid("a", "b");
    const next = editSlot(saved, 0, { label: "x" });
    expect(next[0]).not.toBe(saved[0]);
    expect(saved[0]!.label).toBe("a");
  });

  it("never mutates the grid it was given", () => {
    const saved = grid("a", "b", "c");
    moveSlot(saved, 0, 2);
    removeSlot(saved, 0);
    editSlot(saved, 0, { label: "x" });
    appendSlot(saved, slot({ label: "d" }));
    expect(labels(saved)).toEqual(["a", "b", "c"]);
  });
});

describe("the scene button the OBS card writes", () => {
  it("labels itself with the scene, because that is what she called it in OBS", () => {
    expect(sceneSlot("BRB")).toEqual({
      action: CORE_ACTIONS.obsScene,
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

describe("the microphone buttons the OBS card writes", () => {
  it("keeps the microphone name in the saved arguments", () => {
    expect(microphoneSlot("Mic/Aux", true)).toEqual({
      action: CORE_ACTIONS.obsMute,
      args: ["Mic/Aux"],
      label: "Mute Mic/Aux",
      icon: "",
    });
    expect(microphoneSlot("Mic/Aux", false)).toEqual({
      action: CORE_ACTIONS.obsUnmute,
      args: ["Mic/Aux"],
      label: "Unmute Mic/Aux",
      icon: "",
    });
  });

  it("distinguishes mute from unmute for the same microphone", () => {
    const saved = [microphoneSlot("Mic/Aux", true)];
    expect(hasMicrophoneAction(saved, "Mic/Aux", true)).toBe(true);
    expect(hasMicrophoneAction(saved, "Mic/Aux", false)).toBe(false);
    expect(hasMicrophoneAction(saved, "Guest mic", true)).toBe(false);
  });

  it("builds a separate timed cough button", () => {
    const saved = coughMicrophoneSlot("Mic/Aux");
    expect(saved).toEqual({
      action: CORE_ACTIONS.obsCoughMute,
      args: ["Mic/Aux"],
      label: "Cough mute Mic/Aux",
      icon: "",
    });
    expect(hasCoughMicrophone([saved], "Mic/Aux")).toBe(true);
    expect(hasCoughMicrophone([saved], "Guest mic")).toBe(false);
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

  it("finds one action by the id a saved button carries", () => {
    // The picker offers an action and a saved row reads it back. Same walk,
    // so the same function does both.
    const groups = actionChoices([
      moduleStatus({ actions: [{ id: "wheel.spin", label: "Spin the wheel" }] }),
      moduleStatus({ id: "bingo", title: "Bingo", actions: [{ id: "bingo.go", label: "Start" }] }),
    ]);
    expect(findAction(groups, "bingo.go")?.label).toBe("Start");
    expect(findAction(groups, "wheel.gone")).toBeUndefined();
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
    expect(describeAction(slot({ action: CORE_ACTIONS.obsScene, args: ["BRB"] }), groups)).toBe(
      "OBS scene · BRB",
    );
  });

  it("falls back to the id, so a button for a game that is gone can be found and removed", () => {
    expect(describeAction(slot({ action: "bingo.start" }), groups)).toBe("bingo.start");
  });
});

describe("the cap, in the fold", () => {
  it("counts what she has, singular and plural", () => {
    expect(deckSizeNote(0)).toBe("0 buttons");
    expect(deckSizeNote(1)).toBe("1 button");
    expect(deckSizeNote(3)).toBe("3 buttons");
  });

  it("says the refusal itself once she is over it", () => {
    expect(deckSizeNote(MAX_DECK_SLOTS)).toBe(`${MAX_DECK_SLOTS} buttons`);
    expect(deckSizeNote(MAX_DECK_SLOTS + 1)).toContain(`A deck holds ${MAX_DECK_SLOTS} buttons`);
    expect(deckSizeNote(MAX_DECK_SLOTS + 1)).toContain(`has ${MAX_DECK_SLOTS + 1}`);
  });
});

describe("the key on a button", () => {
  const grid: DeckSlot[] = [
    { action: "wheel.spin", args: [], label: "Spin", icon: "", hotkey: "F13" },
    { action: "core.obsScene", args: ["BRB"], label: "BRB", icon: "" },
  ];

  it("offers the keys nobody else has taken", () => {
    const free = hotkeyChoices(grid, 1).map((choice) => choice.accelerator);
    expect(free).not.toContain("F13");
    expect(free).toContain("F14");
    expect(free).toContain("Control+Alt+1");
  });

  it("still offers a button its own key, or reopening the picker would blank it", () => {
    expect(hotkeyChoices(grid, 0).map((choice) => choice.accelerator)).toContain("F13");
  });

  it("clears to absent, not to blank, so Save eventually goes quiet", () => {
    // The draft is compared to the server's grid field by field. A "" here
    // against an undefined there reads as unsaved forever.
    const cleared = setHotkey(grid, 0, "");
    expect("hotkey" in cleared[0]!).toBe(false);
    expect(sameGrid(cleared, [{ ...grid[0]!, hotkey: undefined }, grid[1]!])).toBe(true);
  });

  it("counts a key she changed as unsaved", () => {
    expect(sameGrid(grid, setHotkey(grid, 1, "F14"))).toBe(false);
    expect(sameGrid(grid, setHotkey(grid, 0, "F13"))).toBe(true);
  });

  it("leaves the grid it was given alone, like every other helper here", () => {
    const before = JSON.stringify(grid);
    setHotkey(grid, 0, "Control+Alt+5");
    expect(JSON.stringify(grid)).toBe(before);
  });
});
