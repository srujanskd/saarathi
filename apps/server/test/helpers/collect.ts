import type { Effect } from "@saarathi/shared";
import type { Kernel } from "../../src/core/kernel.js";

export interface Collected {
  patches: { module: string; state: unknown }[];
  effects: Effect[];
  /** Effects from one module, by name. */
  effectsNamed(name: string): Effect[];
  /** Text of every core "say" -- what chat would have been told. */
  said(): string[];
  clear(): void;
}

/**
 * Taps the two things a client ever receives. Asserting on these instead of on
 * a socket keeps integration tests honest about the contract without booting a
 * server: sync.ts forwards exactly this, and nothing else.
 */
export function collect(kernel: Kernel): Collected {
  const patches: Collected["patches"] = [];
  const effects: Effect[] = [];

  kernel.onPatch((module, state) => patches.push({ module, state }));
  kernel.onEffect((effect) => effects.push(effect));

  return {
    patches,
    effects,
    effectsNamed: (name) => effects.filter((e) => e.name === name),
    said: () =>
      effects
        .filter((e) => e.name === "say")
        .map((e) => (e.payload as { text: string }).text),
    clear() {
      patches.length = 0;
      effects.length = 0;
    },
  };
}
