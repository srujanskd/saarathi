import {
  DECK_ID,
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
    for (const [index, raw] of input.entries()) {
      const slot = normalize(raw);
      if (typeof slot === "string") return { ok: false, reason: `Button ${index + 1} ${slot}.` };
      slots.push(slot);
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
 */
export function deckCommand(
  deck: DeckCommands,
  name: string,
  args: string[],
): InvokeResult | null {
  if (name !== "deckSet") return null;
  return parseSlots(deck, args[0] ?? "");
}

/**
 * `InvokeRequest.args` is `string[]` and a button is four fields, so the grid
 * travels as one JSON string and is parsed here and only here -- the same
 * boundary rule `obsSettings` follows for its port. Nothing past this line
 * carries a slot that has not been checked.
 */
function parseSlots(deck: DeckCommands, json: string): InvokeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, reason: "The deck did not arrive in one piece. Try saving again." };
  }
  return deck.setSlots(parsed);
}

/** A checked slot, or the half-sentence saying what is wrong with it. */
function normalize(raw: unknown): DeckSlot | string {
  if (typeof raw !== "object" || raw === null) return "is not a button";

  const { action, args, label, icon } = raw as Record<string, unknown>;

  const id = typeof action === "string" ? action.trim() : "";
  // The same shape `Registry.dispatch` splits on. Anything without the dot
  // could never reach an action, so it is a button that would only fail the
  // first time she pressed it, and she would be mid-workout when it did.
  if (id.indexOf(".") < 1) return `points at "${id}", which is not an action`;

  const name = typeof label === "string" ? label.trim() : "";
  if (!name) return "needs a label";

  if (args !== undefined && (!Array.isArray(args) || args.some((a) => typeof a !== "string"))) {
    return "has arguments that are not text";
  }

  return {
    action: id,
    // Not trimmed: an argument is a scene name or a challenge, and deciding
    // its edges is the action's business, not the deck's.
    args: (args as string[] | undefined) ?? [],
    label: name,
    icon: typeof icon === "string" ? icon.trim() : "",
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
  for (const raw of saved) {
    const slot = normalize(raw);
    if (typeof slot === "string") log.warn(`deck: dropped a saved button that ${slot}`);
    else slots.push(slot);
  }
  return slots;
}
