import { SPIN_COST } from "@saarathi/shared";

/**
 * A ledger where each named viewer can afford `spins` spins.
 *
 * !spin is priced, and every viewer starts empty, so any test that drives one
 * through chat has to fund somebody first. Four different name lists doing that
 * four different ways is how the fifth one ends up funding a viewer who never
 * chats, so both seeders -- `harness` and `startServer` -- take what this
 * returns, keyed by the display name the test chats under.
 *
 * Deliberately in terms of `SPIN_COST` rather than a number: a test that says
 * "can afford two" keeps meaning that the day the price moves.
 */
export function affordsSpins(spins: number, ...names: string[]): Record<string, number> {
  return Object.fromEntries(names.map((name) => [name, SPIN_COST * spins]));
}
