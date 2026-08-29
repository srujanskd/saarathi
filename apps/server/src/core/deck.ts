import {
  CORE_ACTIONS,
  DECK_ID,
  hotkeyChoice,
  MAX_DECK_SLOTS,
  type DeckSlot,
  type DeckView,
  type InvokeResult,
  type Logger,
} from "@saarathi/shared";
import type { StateStore } from "./store.js";

/** Everything her surfaces can ask of the deck, and all `deckCommand` needs. */
export interface DeckCommands {
  /** `unknown` on purpose: this is the validation boundary, not past it. */
  setSlots(input: unknown): InvokeResult;
}

/**
 * Her button grid, and nothing else.
 *
 * The deck is deliberately not a module and does not dispatch anything: a
 * button is a saved `{action, args}` pair, and pressing one is the client
 * invoking that action directly with `via: "deck"`. Adding a `deck.press(n)`
 * here would put an index between her finger and the action for no gain, and
 * would mean a slot that is out of date on one client presses the wrong thing.
 */
export class Deck implements DeckCommands {
  private slots: DeckSlot[];

  constructor(
    private readonly store: StateStore,
    private readonly log: Logger,
    /** The grid changed, so the core slice needs republishing. */
    private readonly onChange: () => void,
  ) {
    this.slots = readSaved(store, log);
  }

  view(): DeckView {
    return { slots: this.slots.map((slot) => ({ ...slot, args: [...slot.args] })) };
  }

  setSlots(input: unknown): InvokeResult {
    if (!Array.isArray(input)) return { ok: false, reason: "That is not a list of buttons." };
    if (input.length > MAX_DECK_SLOTS) {
      return {
        ok: false,
        reason: `That is ${input.length} buttons. The deck holds ${MAX_DECK_SLOTS}.`,
      };
    }

    const slots: DeckSlot[] = [];
    // Two buttons on one key is a press with no answer, so it is refused here
    // rather than left for the tray to resolve by arriving first. Named by the
    // key she recognises and the button she can see, because "slot 7" is not
    // something on her screen.
    const taken = new Map<string, string>();
    for (const [index, raw] of input.entries()) {
      const checked = checkSlot(raw);
      if (!checked.ok) return { ok: false, reason: `Button ${index + 1} ${checked.problem}.` };
      const { hotkey } = checked.slot;
      if (hotkey) {
        // Checked here rather than in checkSlot, because the two callers want
        // opposite things from a key they do not recognise: a save is refused
        // to her face, and a state file already on disk keeps the button and
        // loses only the key.
        const choice = hotkeyChoice(hotkey);
        if (!choice) {
          return { ok: false, reason: `Button ${index + 1} wants a key this app cannot register.` };
        }
        const owner = taken.get(hotkey);
        if (owner) {
          return {
            ok: false,
            reason: `${choice.label} is on "${owner}" already. One key, one button.`,
          };
        }
        taken.set(hotkey, checked.slot.label);
      }
      slots.push(checked.slot);
    }

    this.slots = slots;
    this.store.write(DECK_ID, { slots });
    this.log.info(`deck: saved ${slots.length} button${slots.length === 1 ? "" : "s"}`);
    this.onChange();
    return { ok: true };
  }
}

/**
 * Her deck actions, routed here rather than in the registry, the way OBS's are:
 * knowing that a grid arrives as JSON is knowledge about the deck, and the
 * registry's job is modules. `null` means "not one of ours".
 *
 * The id it answers to comes from `CORE_ACTIONS`, the same constant her pages
 * send, so the two ends of one string cannot drift apart.
 *
 * `InvokeRequest.args` is `string[]` and a button is four fields, so the grid
 * travels as one JSON string and is parsed here and only here -- the same
 * boundary rule `obsSettings` follows for its port. Nothing past this line
 * carries a slot that has not been checked.
 */
export function deckCommand(
  deck: DeckCommands,
  actionId: string,
  args: string[],
): InvokeResult | null {
  if (actionId !== CORE_ACTIONS.deckSet) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(args[0] ?? "");
  } catch {
    return { ok: false, reason: "The deck did not arrive in one piece. Try saving again." };
  }
  return deck.setSlots(parsed);
}

/**
 * A checked slot, or the fragment saying what is wrong with it. The fragment is
 * a predicate and never a whole sentence, because the two callers are talking
 * to different people: one is refusing a save to her face, the other is a line
 * in a log about something already on disk.
 */
type SlotCheck = { ok: true; slot: DeckSlot } | { ok: false; problem: string };

function checkSlot(raw: unknown): SlotCheck {
  const no = (problem: string): SlotCheck => ({ ok: false, problem });

  if (typeof raw !== "object" || raw === null) return no("is not a button");

  const { action, args, label, icon, hotkey } = raw as Record<string, unknown>;

  const id = typeof action === "string" ? action.trim() : "";
  // The same shape `Registry.dispatch` splits on. Anything without the dot
  // could never reach an action, so it is a button that would only fail the
  // first time she pressed it, and she would be mid-workout when it did.
  if (id.indexOf(".") < 1) return no(`points at "${id}", which is not an action`);

  const name = typeof label === "string" ? label.trim() : "";
  if (!name) return no("needs a label");

  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
    return no("has arguments that are not text");
  }

  // Shape only, like everything else here: whether this is a key we can
  // actually register is the caller's question, and the two callers answer it
  // differently. Blank is how the picker says "no key", and it is stored as
  // absent rather than as "" -- the editor compares the field directly to
  // decide whether Save has anything to do.
  const key = typeof hotkey === "string" ? hotkey.trim() : "";

  return {
    ok: true,
    slot: {
      action: id,
      // Not trimmed: an argument is a scene name or a challenge, and deciding
      // its edges is the action's business, not the deck's.
      args: (args as string[] | undefined) ?? [],
      label: name,
      icon: typeof icon === "string" ? icon.trim() : "",
      ...(key ? { hotkey: key } : {}),
    },
  };
}

/**
 * What was saved, checked for shape only. A grid already over the cap keeps
 * working and is stopped the next time she saves, which is the call the
 * challenge cap made and for the same reason: a clamp on load edits her setup
 * at a moment she cannot see. A structurally broken button is different -- it
 * would render as a hole or crash the page -- so those are dropped and logged.
 */
function readSaved(store: StateStore, log: Logger): DeckSlot[] {
  const saved = store.read(DECK_ID)?.slots;
  if (!Array.isArray(saved)) return [];

  const slots: DeckSlot[] = [];
  for (const [index, raw] of saved.entries()) {
    const checked = checkSlot(raw);
    if (!checked.ok) {
      log.warn(`deck: dropped saved button ${index + 1}, it ${checked.problem}`);
      continue;
    }
    const { hotkey, ...rest } = checked.slot;
    // A key this build no longer offers costs her the key, never the button.
    // Her grid outlives a list of accelerators, and a button she made and can
    // still press is worth more than a shortcut she has forgotten setting.
    if (hotkey && !hotkeyChoice(hotkey)) {
      log.warn(`deck: dropped the key on saved button ${index + 1}, it is not one we register`);
      slots.push(rest);
      continue;
    }
    slots.push(checked.slot);
  }
  return slots;
}
