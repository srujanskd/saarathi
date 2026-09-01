import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CORE_ID,
  DECK_ID,
  LEDGER_ID,
  OBS_ID,
  type GameModuleDef,
} from "@saarathi/shared";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { MemoryStore } from "../../src/core/store.js";
import { harness, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

interface Kept {
  open: string;
  shut: string;
}

function module(over: Partial<GameModuleDef<Kept>> = {}): GameModuleDef<Kept> {
  return {
    id: "secretive",
    title: "Secretive",
    initialState: { open: "", shut: "" },
    persist: ["open", "shut"],
    serverOnly: ["shut"],
    actions: {
      tell: { label: "Tell", run: (input, ctx) => ctx.setState({ open: input.args[0] ?? "" }) },
      hide: { label: "Hide", run: (input, ctx) => ctx.setState({ shut: input.args[0] ?? "" }) },
    },
    ...over,
  };
}

const slice = (h: Harness) => h.kernel.snapshot().modules.secretive as Record<string, unknown>;
const patches = (h: Harness) => h.seen.patches.filter((p) => p.module === "secretive");

/**
 * Past the coalescing window, so "no patch" means no patch and not "not yet".
 * Without this every assertion below that counts patches passes against a
 * registry that publishes everything, which is how the first version of this
 * file was wrong.
 */
const flush = () => vi.advanceTimersByTimeAsync(1_000);

describe("state a client may not see", () => {
  it("leaves a server-only key out of the snapshot", async () => {
    vi.useFakeTimers();
    live = await harness({ modules: [module()] });
    await live.kernel.invoke("secretive.hide", { args: ["her chat's names"] });
    expect(slice(live)).toEqual({ open: "" });
  });

  it("leaves it out of a patch too, which is the half a page actually reads", async () => {
    vi.useFakeTimers();
    live = await harness({ modules: [module()] });
    await live.kernel.invoke("secretive.hide", { args: ["not fine"] });
    await live.kernel.invoke("secretive.tell", { args: ["fine"] });
    await flush();

    expect(patches(live)).toEqual([{ module: "secretive", state: { open: "fine" } }]);
  });

  it("sends no patch at all for a write that only moved private keys", async () => {
    vi.useFakeTimers();
    live = await harness({ modules: [module()] });
    live.seen.clear();

    await live.kernel.invoke("secretive.hide", { args: ["quietly"] });
    await flush();
    expect(patches(live)).toEqual([]);

    // The other half of the same claim: a public write on the same module does
    // arrive, so the silence above is the rule working and not the tap missing.
    await live.kernel.invoke("secretive.tell", { args: ["out loud"] });
    await flush();
    expect(patches(live)).toHaveLength(1);
  });

  it("still persists it, because private is not the same as transient", async () => {
    vi.useFakeTimers();
    const store = new MemoryStore();
    const first = await harness({ modules: [module()], store });
    await first.kernel.invoke("secretive.hide", { args: ["kept"] });
    await first.stop();

    live = await harness({ modules: [module()], store });
    // Not through the snapshot, which is exactly the point: the module sees it,
    // and nothing on a socket does.
    expect(store.read("secretive")).toEqual({ open: "", shut: "kept" });
  });

  it("publishes everything for a module that declares nothing private", async () => {
    vi.useFakeTimers();
    live = await harness({ modules: [module({ serverOnly: undefined })] });
    await live.kernel.invoke("secretive.hide", { args: ["shared"] });
    await flush();

    expect(slice(live)).toEqual({ open: "", shut: "shared" });
    expect(patches(live)).toEqual([
      { module: "secretive", state: { open: "", shut: "shared" } },
    ]);
  });
});

describe("namespaces the core owns", () => {
  /**
   * A module's id is the key its persisted slice lives under, so an id the core
   * already writes there is two things owning one key -- which is not a name
   * clash, it is one of them silently overwriting the other's data on the first
   * save. The ledger and the module that ranks it very nearly shipped that way.
   */
  it.each([CORE_ID, LEDGER_ID, DECK_ID, OBS_ID, "mock"])("refuses %s", async (id) => {
    await expect(
      harness({ modules: [module({ id })], chat: [new MockChatAdapter()] }),
    ).rejects.toThrow(/reserved/);
  });

  it("still refuses a duplicate", async () => {
    await expect(harness({ modules: [module(), module()] })).rejects.toThrow(/Duplicate/);
  });
});
