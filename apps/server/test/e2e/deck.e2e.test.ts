import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { CORE_ID, type CoreState, type DeckSlot, type WheelState } from "@saarathi/shared";
import { startServer, type RunningServer } from "./helpers/server.js";

let server: RunningServer | null = null;
let carried: string[] = [];

afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of carried) rmSync(dir, { recursive: true, force: true });
  carried = [];
});

async function restart(first: RunningServer): Promise<string> {
  const { stateFile, stateDir } = first;
  if (stateDir) carried.push(stateDir);
  await first.stop({ keepState: true });
  return stateFile;
}

const grid = (slots: Partial<DeckSlot>[]) => ({
  action: "core.deckSet",
  args: [JSON.stringify(slots)],
});

const coreOf = (state: unknown) => state as CoreState;

describe("her deck over a socket", () => {
  it("reaches her other phone the moment she saves it", async () => {
    server = await startServer();
    const deck = await server.connect({ surface: "deck" });
    const control = await server.connect({ surface: "control" });

    await control.invoke(grid([{ action: "wheel.spin", label: "Spin", icon: "🎡" }]));

    // The deck page was not the one that edited it, which is the point: she
    // arranges the grid on the control page and the deck redraws itself.
    await deck.waitFor("the new grid", (c) =>
      c.patches.some((p) => p.module === CORE_ID && coreOf(p.state).deck.slots.length === 1),
    );
    expect(coreOf(deck.latest(CORE_ID)).deck.slots[0]).toEqual({
      action: "wheel.spin",
      args: [],
      label: "Spin",
      icon: "🎡",
    });

    await deck.close();
    await control.close();
  });

  it("is in the snapshot a page gets before it has asked for anything", async () => {
    server = await startServer();
    await server.invoke(grid([{ action: "wheel.spin", label: "Spin" }]));

    // A browser source reloading mid-stream never saw the save happen.
    const fresh = await server.connect({ surface: "deck" });
    expect(fresh.snapshots[0]!.core.deck.slots[0]!.label).toBe("Spin");
    await fresh.close();
  });

  it("survives the restart she does not think about", async () => {
    const first = await startServer();
    await first.invoke(grid([{ action: "core.obsScene", args: ["BRB"], label: "Back soon" }]));
    const stateFile = await restart(first);

    server = await startServer({ stateFile });
    const state = (await server.get("/api/state")) as { core: CoreState };
    expect(state.core.deck.slots).toEqual([
      { action: "core.obsScene", args: ["BRB"], label: "Back soon", icon: "" },
    ]);
  });
});

/**
 * Only reachable here. `via` comes from what the client said in `hello`, which
 * a kernel test has no way to say -- and the history she reads back is the only
 * place the answer shows up.
 */
describe("a spin she started from the deck", () => {
  it("is recorded as the deck, not as the control page", async () => {
    server = await startServer();
    const deck = await server.connect({ surface: "deck", modules: ["wheel"] });

    expect(await deck.invoke({ action: "wheel.spin" })).toEqual({ ok: true });
    await deck.waitFor("the spin", (c) => (c.latest("wheel") as WheelState)?.spin !== null);

    expect((deck.latest("wheel") as WheelState).spin!.via).toBe("deck");
    await deck.close();
  });

  it("is recorded as the control page when that is where she tapped", async () => {
    server = await startServer();
    const control = await server.connect({ surface: "control", modules: ["wheel"] });

    await control.invoke({ action: "wheel.spin" });
    await control.waitFor("the spin", (c) => (c.latest("wheel") as WheelState)?.spin !== null);

    expect((control.latest("wheel") as WheelState).spin!.via).toBe("control");
    await control.close();
  });
});
