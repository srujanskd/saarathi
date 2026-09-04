import {
  CORE_ACTIONS,
  HOTKEYS,
  MAX_DECK_SLOTS,
  type DeckSlot,
  type HotkeyChoice,
  type ModuleStatus,
} from "@saarathi/shared";

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
  [CORE_ACTIONS.obsScene]: "OBS scene",
  [CORE_ACTIONS.obsMute]: "Mute microphone",
  [CORE_ACTIONS.obsUnmute]: "Unmute microphone",
  [CORE_ACTIONS.obsCoughMute]: "Cough mute",
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
      slot.hotkey === other.hotkey &&
      slot.args.length === other.args.length &&
      slot.args.every((arg, at) => arg === other.args[at])
    );
  });
}

/**
 * Reordering, as two taps rather than a drag.
 *
 * The card greys the two arrows at the ends of the list, which is what she
 * sees. A move that goes nowhere still returns the array it was given, so
 * whether an arrow is reachable stays a rendering decision: nothing here
 * throws, marks a grid unsaved, or reorders anything if the card ever offers
 * one of those taps -- and these are thumb-sized targets on a phone.
 */
export function moveSlot(slots: DeckSlot[], from: number, to: number): DeckSlot[] {
  if (from === to) return slots;
  if (from < 0 || to < 0 || from >= slots.length || to >= slots.length) return slots;
  const next = [...slots];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function removeSlot(slots: DeckSlot[], index: number): DeckSlot[] {
  if (index < 0 || index >= slots.length) return slots;
  return slots.filter((_, at) => at !== index);
}

/** One field of one button, without disturbing the rest of the grid. */
export function editSlot(slots: DeckSlot[], index: number, patch: Partial<DeckSlot>): DeckSlot[] {
  if (index < 0 || index >= slots.length) return slots;
  return slots.map((slot, at) => (at === index ? { ...slot, ...patch } : slot));
}

/**
 * A new button on the end. Args come from the caller because the caller is
 * what knows them: the picker adds an action that takes none, the OBS card
 * adds a scene. The editor never asks her to type an argument, which is the
 * no-terminal rule in the one place it would be easiest to break.
 */
export function appendSlot(slots: DeckSlot[], slot: DeckSlot): DeckSlot[] {
  return [...slots, slot];
}

/**
 * Whether that scene is already a button. Adding it twice would only give her
 * two identical keys to hunt through mid-workout, and the grid has no ids, so
 * "the same button" means the same action pointed at the same scene.
 */
export function hasScene(slots: DeckSlot[], scene: string): boolean {
  return slots.some((slot) => slot.action === CORE_ACTIONS.obsScene && slot.args[0] === scene);
}

/** The button the OBS card writes. Here rather than there because the shape of
 * a slot is this file's business, and because it is the one place a deck
 * button is built out of something she picked rather than something a module
 * declared. */
export function sceneSlot(scene: string): DeckSlot {
  return { action: CORE_ACTIONS.obsScene, args: [scene], label: scene, icon: "" };
}

export type MicrophoneToggleAction =
  | typeof CORE_ACTIONS.obsMute
  | typeof CORE_ACTIONS.obsUnmute;

/** A microphone button built where she can pick the named OBS input. */
export function microphoneSlot(name: string, action: MicrophoneToggleAction): DeckSlot {
  return {
    action,
    args: [name],
    label: `${action === CORE_ACTIONS.obsMute ? "Mute" : "Unmute"} ${name}`,
    icon: "",
  };
}

/** Whether this exact microphone operation is already on her deck. */
export function hasMicrophoneAction(
  slots: DeckSlot[],
  name: string,
  action: MicrophoneToggleAction,
): boolean {
  return slots.some((slot) => slot.action === action && slot.args[0] === name);
}

/** A timed mute that restores the microphone without a second tap. */
export function coughMicrophoneSlot(name: string): DeckSlot {
  return {
    action: CORE_ACTIONS.obsCoughMute,
    args: [name],
    label: `Cough mute ${name}`,
    icon: "",
  };
}

export function hasCoughMicrophone(slots: DeckSlot[], name: string): boolean {
  return slots.some(
    (slot) => slot.action === CORE_ACTIONS.obsCoughMute && slot.args[0] === name,
  );
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
  const name = findAction(groups, slot.action)?.label ?? CORE_ACTION_NAMES[slot.action] ?? slot.action;
  return slot.args.length > 0 ? `${name} · ${slot.args.join(" · ")}` : name;
}

/** One action out of the picker, by the id a saved button carries. The picker
 * offers it and a saved row has to read it back, and those are the same walk. */
export function findAction(
  groups: ActionGroup[],
  id: string,
): { id: string; label: string } | undefined {
  return groups.flatMap((group) => group.actions).find((action) => action.id === id);
}

/**
 * The keys this button may be given: the free ones, plus the one it already
 * holds so that reopening the picker does not show it as unset.
 *
 * Taken keys are removed rather than shown disabled, because the server
 * refuses a duplicate and a picker that offers a choice it knows will be
 * refused is a refusal she meets one tap later than she had to. This is the
 * opposite call from the action picker, which lists switched-off modules --
 * there the refusal is honest and the alternative was hiding half her deck.
 */
export function hotkeyChoices(slots: DeckSlot[], index: number): HotkeyChoice[] {
  const taken = new Set(
    slots.flatMap((slot, at) => (at === index || !slot.hotkey ? [] : [slot.hotkey])),
  );
  return HOTKEYS.filter((choice) => !taken.has(choice.accelerator));
}

/**
 * Setting or clearing a button's key. Blank clears it to *absent* rather than
 * to "", because the server stores it that way and `sameGrid` compares the
 * field directly -- a draft holding "" against a saved slot holding nothing
 * would read as unsaved forever and she would never get Save to go quiet.
 */
export function setHotkey(slots: DeckSlot[], index: number, accelerator: string): DeckSlot[] {
  if (index < 0 || index >= slots.length) return slots;
  return slots.map((slot, at) => {
    if (at !== index) return slot;
    const { hotkey: _dropped, ...rest } = slot;
    return accelerator ? { ...rest, hotkey: accelerator } : rest;
  });
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
export function deckSizeNote(count: number): string {
  if (count > MAX_DECK_SLOTS) {
    return `A deck holds ${MAX_DECK_SLOTS} buttons — that grid has ${count}`;
  }
  return `${count} ${count === 1 ? "button" : "buttons"}`;
}
