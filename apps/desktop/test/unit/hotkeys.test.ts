import { describe, expect, it } from "vitest";
import type { DeckSlot } from "@saarathi/shared";
import { hotkeyNote, hotkeyPlan, sameBindings } from "../../src/hotkeys.js";

const slot = (over: Partial<DeckSlot> = {}): DeckSlot => ({
  action: "wheel.spin",
  args: [],
  label: "Spin",
  icon: "",
  ...over,
});

describe("hotkeyPlan", () => {
  it("claims a key for the button that carries it, with its arguments", () => {
    const plan = hotkeyPlan([
      slot(),
      slot({ action: "core.obsScene", args: ["BRB"], label: "BRB", hotkey: "Control+Alt+2" }),
    ]);
    expect(plan).toEqual([
      {
        accelerator: "Control+Alt+2",
        key: "Ctrl+Alt+2",
        action: "core.obsScene",
        args: ["BRB"],
        label: "BRB",
      },
    ]);
  });

  it("drops a key this app cannot register instead of handing it to Electron", () => {
    // globalShortcut.register throws on a string it cannot parse, and a throw
    // in the shell is a tray icon that never appears.
    expect(hotkeyPlan([slot({ hotkey: "Ctrl+Shift+Meta+Whatever" })])).toEqual([]);
  });

  it("gives a duplicate to the first button, rather than to neither", () => {
    // The server refuses this on save, so it only reaches here out of a
    // hand-edited state file -- and one working key beats none.
    const plan = hotkeyPlan([
      slot({ label: "First", hotkey: "F13" }),
      slot({ label: "Second", hotkey: "F13" }),
    ]);
    expect(plan.map((binding) => binding.label)).toEqual(["First"]);
  });

  it("copies the arguments, so a later edit to the grid cannot rewrite a live key", () => {
    const args = ["BRB"];
    const [binding] = hotkeyPlan([slot({ action: "core.obsScene", args, hotkey: "F14" })]);
    args[0] = "Live";
    expect(binding!.args).toEqual(["BRB"]);
  });
});

describe("sameBindings", () => {
  const grid = [slot({ hotkey: "F13" }), slot({ label: "BRB", args: ["BRB"], hotkey: "F14" })];

  it("is true for a core slice republished for some other reason", () => {
    // The whole core state is patched when OBS changes scene, which she does
    // mid-workout. Re-registering there would blink every key off.
    expect(sameBindings(hotkeyPlan(grid), hotkeyPlan([...grid]))).toBe(true);
  });

  it("notices a key moving to another button", () => {
    const moved = [slot({ hotkey: "F14" }), slot({ label: "BRB", args: ["BRB"], hotkey: "F13" })];
    expect(sameBindings(hotkeyPlan(grid), hotkeyPlan(moved))).toBe(false);
  });

  it("notices the same key pointing somewhere new", () => {
    const rescened = [grid[0]!, slot({ label: "BRB", args: ["Live"], hotkey: "F14" })];
    expect(sameBindings(hotkeyPlan(grid), hotkeyPlan(rescened))).toBe(false);
  });

  it("notices a button she renamed, because the menu quotes the label", () => {
    const renamed = [slot({ label: "SPIN IT", hotkey: "F13" }), grid[1]!];
    expect(sameBindings(hotkeyPlan(grid), hotkeyPlan(renamed))).toBe(false);
  });
});

describe("hotkeyNote", () => {
  const bindings = hotkeyPlan([
    slot({ hotkey: "F13" }),
    slot({ label: "BRB", hotkey: "F14" }),
    slot({ label: "Live", hotkey: "Control+Alt+1" }),
  ]);

  it("tells her nothing is set apart from something being wrong", () => {
    expect(hotkeyNote([], [])).toBe("No hotkeys set");
  });

  it("counts what is working", () => {
    expect(hotkeyNote(bindings, [])).toBe("3 hotkeys active");
    expect(hotkeyNote(bindings.slice(0, 1), [])).toBe("1 hotkey active");
  });

  it("names the key another app took, because the fix is to pick a different one", () => {
    expect(hotkeyNote(bindings, [bindings[2]!])).toBe(
      "2 active · Ctrl+Alt+1 in use by something else",
    );
    expect(hotkeyNote(bindings, bindings)).toBe(
      "3 keys, including F13 in use by something else",
    );
  });

  it("does not say 0 active when nothing landed", () => {
    const one = bindings.slice(0, 1);
    expect(hotkeyNote(one, one)).toBe("F13 in use by something else");
  });
});
