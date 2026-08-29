import { hotkeyChoice, type DeckSlot } from "@saarathi/shared";

/**
 * The deck's second face: her grid, pressed by a key while OBS has focus.
 *
 * Nothing here touches Electron. `globalShortcut` is two calls -- register and
 * unregisterAll -- and every decision around them is in this file, because the
 * ones that matter are the ones no test can reach otherwise: which keys we
 * claim, what happens when Windows has already given one away, and when a
 * change to the grid is a change to the keys at all.
 *
 * A binding is a saved action and its arguments, exactly as the deck page
 * presses one. There is no `deck.press(n)` here for the same reason there is
 * none on the server: the key stands for the button, not for its position.
 */

export interface HotkeyBinding {
  /** Electron accelerator, already known to be one of ours. */
  readonly accelerator: string;
  /** What she reads in the menu: "Ctrl+Alt+1". */
  readonly key: string;
  readonly action: string;
  readonly args: string[];
  /** The button's label, so a failure can name something she can see. */
  readonly label: string;
}

/**
 * The keys to claim for a grid.
 *
 * The server refuses a duplicate on save, so first-wins here is not the rule
 * she meets -- it is what happens to a `state.json` edited by hand or written
 * by an older build. Silently claiming one of the two beats registering
 * neither, which would look like the feature being broken.
 *
 * An accelerator that is not in `HOTKEYS` is dropped rather than passed on:
 * `globalShortcut.register` throws on a string it cannot parse, and a throw
 * here takes the tray down over a line in a config file.
 */
export function hotkeyPlan(slots: readonly DeckSlot[]): HotkeyBinding[] {
  const bindings: HotkeyBinding[] = [];
  const claimed = new Set<string>();
  for (const slot of slots) {
    if (!slot.hotkey) continue;
    const choice = hotkeyChoice(slot.hotkey);
    if (!choice || claimed.has(choice.accelerator)) continue;
    claimed.add(choice.accelerator);
    bindings.push({
      accelerator: choice.accelerator,
      key: choice.label,
      action: slot.action,
      args: [...slot.args],
      label: slot.label,
    });
  }
  return bindings;
}

/**
 * Whether two plans claim the same keys for the same things.
 *
 * Re-registering is not free and it is not silent: unregisterAll drops every
 * key for as long as it takes to claim them again, and a press that lands in
 * that gap does nothing. The core slice is republished for reasons that have
 * nothing to do with the deck -- OBS changing scene is the common one, and she
 * does that mid-workout -- so without this every scene switch would blink her
 * hotkeys off.
 */
export function sameBindings(a: readonly HotkeyBinding[], b: readonly HotkeyBinding[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((binding, index) => {
    const other = b[index]!;
    return (
      binding.accelerator === other.accelerator &&
      binding.action === other.action &&
      binding.label === other.label &&
      binding.args.length === other.args.length &&
      binding.args.every((arg, at) => arg === other.args[at])
    );
  });
}

/**
 * How often to ask again for a key something else already owns.
 *
 * Windows hands a shortcut to whoever asked first, but it hands it back when
 * that app closes -- and she will close it, because the fix she is told to
 * apply is "something else has that key". Without a retry the only way back is
 * editing the grid, which is a one-way door dressed up as a state.
 */
export const HOTKEY_RETRY_MS = 30_000;

/**
 * What to hand `globalShortcut` for a plan, given what is already claimed.
 *
 * Two cases, and the difference between them is the whole reason this is not
 * one `register` loop. A grid that changed has to drop everything first,
 * because a key that moved to another button would otherwise fire the old one.
 * A grid that did not change must not: `unregisterAll` blinks every working
 * key off for as long as it takes to claim them again, and the core slice is
 * republished for reasons that have nothing to do with the deck -- OBS
 * changing scene is the common one, and she does that mid-workout.
 *
 * What is left in the unchanged case is the keys that never landed. Re-asking
 * costs one call each and is the only way she gets them back without editing
 * a grid she has no reason to think is wrong.
 */
export function hotkeyClaim(
  plan: readonly HotkeyBinding[],
  current: readonly HotkeyBinding[],
  failed: readonly HotkeyBinding[],
): { readonly unregisterAll: boolean; readonly claim: readonly HotkeyBinding[] } {
  if (!sameBindings(plan, current)) return { unregisterAll: true, claim: plan };
  return { unregisterAll: false, claim: failed };
}

/**
 * The menu's one line about hotkeys. It is always there, whatever the answer,
 * because an item that appears only when something is wrong moves every item
 * below it under her finger at the worst possible moment -- and because "she
 * set one and it is not working" and "she never set one" are the two states
 * she will actually be trying to tell apart.
 *
 * Failures are named, up to a point. Windows hands a shortcut to whoever asked
 * first, so this is a real state and not an error: something else already owns
 * that key, and the fix is to pick a different one on the control page.
 */
export function hotkeyNote(
  bindings: readonly HotkeyBinding[],
  failed: readonly HotkeyBinding[],
): string {
  if (bindings.length === 0) return "No hotkeys set";

  const working = bindings.length - failed.length;
  if (failed.length === 0) {
    return `${working} hotkey${working === 1 ? "" : "s"} active`;
  }
  const names = failed.map((binding) => binding.key);
  const taken =
    names.length <= 2 ? names.join(" and ") : `${names.length} keys, including ${names[0]}`;
  return working === 0
    ? `${taken} in use by something else`
    : `${working} active · ${taken} in use by something else`;
}
