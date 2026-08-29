import { MAX_DECK_SLOTS, type DeckSlot, type ModuleStatus } from "@saarathi/shared";

/**
 * The deck editor's half of the deck, kept out of React so it can be tested
 * without one.
 *
 * Everything here is copy-on-write: a new array, new objects for whatever it
 * touched, and the argument left exactly as it was. That is what lets the
 * draft start as the server's own array rather than a copy of it -- it shadows
 * the server only while it exists, the way the challenge editor's textarea
 * does, and a helper that edited in place would leave the two impossible to
 * tell apart and the socket's state quietly rewritten.
 */

/** The action an OBS scene button is made of. Named once, because the OBS card
 * writes these buttons and the editor has to recognise them when it reads them
 * back. */
export const OBS_SCENE_ACTION = "core.obsScene";

/**
 * Core actions worth naming in words, which today is exactly one.
 *
 * The picker lists module actions only, on purpose: core actions are added
 * from where she is already looking at the thing they act on, which for scenes
 * is the OBS card. But a row that came back reading "core.obsScene" is jargon
 * on the one page that is meant to have none, so a saved button still gets a
 * name. When a second core action earns a button, it gets a line here.
 */
const CORE_ACTION_NAMES: Record<string, string> = {
  [OBS_SCENE_ACTION]: "OBS scene",
};

/**
 * The grid as `core.deckSet` takes it: one JSON string in `args[0]`, because
 * `InvokeRequest.args` is `string[]` and a button is four fields. The server
 * parses it at exactly one boundary, and this is the other end of that.
 */
export function encodeGrid(slots: DeckSlot[]): string {
  return JSON.stringify(slots);
}

/**
 * Whether two grids say the same thing. Field by field rather than by
 * comparing the JSON, because two objects with the same contents in a
 * different key order encode differently -- and that would show her "unsaved"
 * on a grid she has not touched.
 */
export function sameGrid(a: DeckSlot[], b: DeckSlot[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((slot, index) => {
    const other = b[index]!;
    return (
      slot.action === other.action &&
      slot.label === other.label &&
      slot.icon === other.icon &&
      slot.args.length === other.args.length &&
      slot.args.every((arg, at) => arg === other.args[at])
    );
  });
}

/**
 * Reordering, as two taps rather than a drag.
 *
 * A move that goes nowhere returns the array it was given, so the up arrow on
 * the first button is a button that does nothing rather than an error. That
 * matters more than it sounds: these are thumb-sized targets and she will hit
 * the end of the list without looking.
 */
export function move(slots: DeckSlot[], from: number, to: number): DeckSlot[] {
  if (from === to) return slots;
  if (from < 0 || to < 0 || from >= slots.length || to >= slots.length) return slots;
  const next = [...slots];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function removeAt(slots: DeckSlot[], index: number): DeckSlot[] {
  if (index < 0 || index >= slots.length) return slots;
  return slots.filter((_, at) => at !== index);
}

/** One field of one button, without disturbing the rest of the grid. */
export function editAt(slots: DeckSlot[], index: number, patch: Partial<DeckSlot>): DeckSlot[] {
  if (index < 0 || index >= slots.length) return slots;
  return slots.map((slot, at) => (at === index ? { ...slot, ...patch } : slot));
}

/**
 * A new button on the end. Args come from the caller because the caller is
 * what knows them: the picker adds an action that takes none, the OBS card
 * adds a scene. The editor never asks her to type an argument, which is the
 * no-terminal rule in the one place it would be easiest to break.
 */
export function append(slots: DeckSlot[], slot: DeckSlot): DeckSlot[] {
  return [...slots, slot];
}

/**
 * Whether that scene is already a button. Adding it twice would only give her
 * two identical keys to hunt through mid-workout, and the grid has no ids, so
 * "the same button" means the same action pointed at the same scene.
 */
export function hasScene(slots: DeckSlot[], scene: string): boolean {
  return slots.some((slot) => slot.action === OBS_SCENE_ACTION && slot.args[0] === scene);
}

/** The button the OBS card writes. Here rather than there because the shape of
 * a slot is this file's business, and because it is the one place a deck
 * button is built out of something she picked rather than something a module
 * declared. */
export function sceneSlot(scene: string): DeckSlot {
  return { action: OBS_SCENE_ACTION, args: [scene], label: scene, icon: "" };
}

export interface ActionGroup {
  title: string;
  actions: { id: string; label: string }[];
}

/**
 * What the picker offers, grouped by the module that declared it.
 *
 * Modules that are switched off are still listed. A button is a saved action
 * id, switching a module off is reversible, and a picker that hid half her
 * deck's actions the moment she paused a game would be a worse lie than a
 * button that refuses in words when she presses it.
 */
export function actionChoices(modules: ModuleStatus[]): ActionGroup[] {
  return modules
    .filter((status) => status.actions.length > 0)
    .map((status) => ({ title: status.title, actions: status.actions }));
}

/**
 * What a saved button actually does, in the plainest words available: the
 * label the module declared, the name of a core action, or failing both the id
 * itself, which at least tells her what to remove. Arguments come after it,
 * because "OBS scene · BRB" is the difference between four identical rows and
 * four buttons.
 */
export function describeAction(slot: DeckSlot, groups: ActionGroup[]): string {
  const declared = groups
    .flatMap((group) => group.actions)
    .find((action) => action.id === slot.action);
  const name = declared?.label ?? CORE_ACTION_NAMES[slot.action] ?? slot.action;
  return slot.args.length > 0 ? `${name} · ${slot.args.join(" · ")}` : name;
}

/**
 * What the fold says about the size of the grid she is editing. It counts the
 * draft rather than the saved list, so the cap turns up while she is adding
 * buttons instead of only when the server turns the save down.
 *
 * Over the cap it says the refusal itself, so the fold and the notice are one
 * sentence rather than two descriptions of one rule. It reports; it does not
 * decide -- Save stays live and the server's answer is the authority, because
 * a button that greys itself out explains nothing at arm's length.
 */
export function gridNote(count: number): string {
  if (count > MAX_DECK_SLOTS) {
    return `A deck holds ${MAX_DECK_SLOTS} buttons — that grid has ${count}`;
  }
  return `${count} ${count === 1 ? "button" : "buttons"}`;
}
