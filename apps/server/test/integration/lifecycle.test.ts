import { afterEach, describe, expect, it, vi } from "vitest";
import { CORE_ID, type GameModuleDef, type ModuleContext } from "@saarathi/shared";
import { MemoryStore } from "../../src/core/store.js";
import { chatlog } from "../../src/modules/chatlog/index.js";
import { wheel } from "../../src/modules/wheel/index.js";
import { harness, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
  vi.useRealTimers();
});

const settled = () => new Promise((resolve) => setImmediate(resolve));

const status = (h: Harness, id: string) =>
  h.kernel.coreState().modules.find((m) => m.id === id)!;

describe("enable and disable", () => {
  it("starts enabled", async () => {
    live = await harness();
    expect(status(live, "wheel").enabled).toBe(true);
  });

  it("stops taking chat commands once switched off", async () => {
    live = await harness();
    expect(await live.kernel.invoke("core.disable", { args: ["wheel"] })).toEqual({ ok: true });

    live.chat("!spin");
    await settled();
    // No module claims !spin any more, so nothing is said and nothing spins.
    expect(live.seen.said()).toEqual([]);
    expect((live.kernel.snapshot().modules.wheel as { spin: unknown }).spin).toBeNull();
  });

  it("refuses a direct invoke with a reason she can read", async () => {
    live = await harness();
    await live.kernel.invoke("core.disable", { args: ["wheel"] });
    expect(await live.kernel.invoke("wheel.spin")).toEqual({
      ok: false,
      reason: "Challenge wheel is switched off",
    });
  });

  it("has a way back in", async () => {
    live = await harness();
    await live.kernel.invoke("core.disable", { args: ["wheel"] });
    await live.kernel.invoke("core.enable", { args: ["wheel"] });
    expect(await live.kernel.invoke("wheel.spin")).toEqual({ ok: true });
  });

  it("is idempotent, so a double tap on her phone is harmless", async () => {
    live = await harness();
    expect(await live.kernel.invoke("core.enable", { args: ["wheel"] })).toEqual({ ok: true });
    await live.kernel.invoke("core.disable", { args: ["wheel"] });
    expect(await live.kernel.invoke("core.disable", { args: ["wheel"] })).toEqual({ ok: true });
    expect(status(live, "wheel").enabled).toBe(false);
  });

  it("republishes core state so her page reflects the switch", async () => {
    live = await harness();
    live.seen.clear();
    await live.kernel.invoke("core.disable", { args: ["wheel"] });
    const core = live.seen.patches.filter((p) => p.module === CORE_ID);
    expect(core.length).toBeGreaterThan(0);
  });

  it("names the module it could not find", async () => {
    live = await harness();
    expect(await live.kernel.invoke("core.disable", { args: ["nope"] })).toEqual({
      ok: false,
      reason: 'There is no "nope"',
    });
    expect(await live.kernel.invoke("core.disable")).toMatchObject({ ok: false });
  });

  it("refuses a core action that does not exist", async () => {
    live = await harness();
    expect(await live.kernel.invoke("core.explode", { args: ["wheel"] })).toEqual({
      ok: false,
      reason: 'There is no core action "explode"',
    });
  });

  it("survives a restart", async () => {
    const store = new MemoryStore();
    const first = await harness({ store });
    await first.kernel.invoke("core.disable", { args: ["wheel"] });
    await first.stop();

    live = await harness({ store });
    expect(status(live, "wheel").enabled).toBe(false);
  });
});

describe("arming is opt-in", () => {
  it("reports a module that never asked for it as armed, always", async () => {
    live = await harness();
    expect(status(live, "wheel")).toMatchObject({ arming: false, armed: true });
  });

  it("refuses arm and disarm, so her page never shows a dead button", async () => {
    live = await harness();
    expect(await live.kernel.invoke("core.arm", { args: ["wheel"] })).toEqual({
      ok: false,
      reason: "Challenge wheel does not use arming",
    });
    expect(await live.kernel.invoke("core.disarm", { args: ["wheel"] })).toMatchObject({
      ok: false,
    });
  });
});

/** A module that does opt in, so the armed path is covered by something. */
function armable(): GameModuleDef<{ ran: number }> {
  return {
    id: "armable",
    title: "Armable",
    arming: true,
    initialState: { ran: 0 },
    actions: {
      go: {
        label: "Go",
        run(_input, ctx: ModuleContext<{ ran: number }>) {
          ctx.setState((state) => ({ ran: state.ran + 1 }));
        },
      },
    },
    commands: [{ name: "go", action: "go" }],
  };
}

describe("a module that opted into arming", () => {
  it("starts disarmed, and refuses until she arms it", async () => {
    live = await harness({ modules: [armable()] });
    expect(status(live, "armable")).toMatchObject({ arming: true, armed: false });
    expect(await live.kernel.invoke("armable.go")).toEqual({
      ok: false,
      reason: "Armable is not armed yet",
    });
  });

  it("runs once armed", async () => {
    live = await harness({ modules: [armable()] });
    await live.kernel.invoke("core.arm", { args: ["armable"] });
    expect(await live.kernel.invoke("armable.go")).toEqual({ ok: true });
    expect(live.kernel.snapshot().modules.armable).toEqual({ ran: 1 });
  });

  it("disarms again", async () => {
    live = await harness({ modules: [armable()] });
    await live.kernel.invoke("core.arm", { args: ["armable"] });
    await live.kernel.invoke("core.disarm", { args: ["armable"] });
    expect(await live.kernel.invoke("armable.go")).toMatchObject({ ok: false });
  });

  it("gates a chat command too, and tells chat why", async () => {
    live = await harness({ modules: [armable()] });
    live.chat("!go");
    await settled();
    expect(live.seen.said()[0]).toContain("not armed");
  });

  it("survives a restart, armed", async () => {
    const store = new MemoryStore();
    const first = await harness({ modules: [armable()], store });
    await first.kernel.invoke("core.arm", { args: ["armable"] });
    await first.stop();

    live = await harness({ modules: [armable()], store });
    expect(status(live, "armable").armed).toBe(true);
  });
});

describe("registration rules", () => {
  it("refuses two modules with the same id", async () => {
    await expect(harness({ modules: [wheel, { ...wheel }] })).rejects.toThrow(/Duplicate/);
  });

  it("refuses a module that calls itself core", async () => {
    await expect(harness({ modules: [{ ...chatlog, id: CORE_ID }] })).rejects.toThrow(/reserved/);
  });
});

describe("teardown", () => {
  it("cancels timers a module set, so a stopped module goes quiet", async () => {
    vi.useFakeTimers();
    let ticks = 0;
    const ticker: GameModuleDef<Record<string, never>> = {
      id: "ticker",
      title: "Ticker",
      initialState: {},
      actions: {},
      setup(ctx) {
        ctx.every(100, () => void ticks++);
      },
    };

    const h = await harness({ modules: [ticker] });
    await vi.advanceTimersByTimeAsync(250);
    expect(ticks).toBe(2);

    await h.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ticks).toBe(2);
  });

  it("stops delivering events to a disabled module", async () => {
    const seen: string[] = [];
    const listener: GameModuleDef<Record<string, never>> = {
      id: "listener",
      title: "Listener",
      initialState: {},
      actions: {},
      setup(ctx) {
        ctx.on("chat-message", (event) => void seen.push(event.text));
      },
    };

    live = await harness({ modules: [listener] });
    live.chat("before");
    await settled();
    await live.kernel.invoke("core.disable", { args: ["listener"] });
    live.chat("after");
    await settled();

    expect(seen).toEqual(["before"]);
  });

  it("resubscribes when she switches it back on", async () => {
    const seen: string[] = [];
    const listener: GameModuleDef<Record<string, never>> = {
      id: "listener",
      title: "Listener",
      initialState: {},
      actions: {},
      setup(ctx) {
        ctx.on("chat-message", (event) => void seen.push(event.text));
      },
    };

    live = await harness({ modules: [listener] });
    await live.kernel.invoke("core.disable", { args: ["listener"] });
    await live.kernel.invoke("core.enable", { args: ["listener"] });
    live.chat("again");
    await settled();

    expect(seen).toEqual(["again"]);
  });

  it("keeps a module that throws in setup from taking the server down", async () => {
    const bad: GameModuleDef<Record<string, never>> = {
      id: "bad",
      title: "Bad",
      initialState: {},
      actions: {},
      setup() {
        throw new Error("boom");
      },
    };

    live = await harness({ modules: [bad, wheel] });
    expect(live.log.text()).toContain("setup failed");
    expect(await live.kernel.invoke("wheel.spin")).toEqual({ ok: true });
  });

  it("keeps a handler that throws from stopping the other modules", async () => {
    const bad: GameModuleDef<Record<string, never>> = {
      id: "bad",
      title: "Bad",
      initialState: {},
      actions: {},
      setup(ctx) {
        ctx.on("chat-message", () => {
          throw new Error("boom");
        });
      },
    };

    live = await harness({ modules: [bad, chatlog] });
    live.chat("hello");
    await settled();

    expect(live.log.text()).toContain("handler for chat-message threw");
    expect((live.kernel.snapshot().modules.chatlog as { events: unknown[] }).events).toHaveLength(1);
  });

  it("turns a thrown action into a refusal instead of a crash", async () => {
    const bad: GameModuleDef<Record<string, never>> = {
      id: "bad",
      title: "Bad",
      initialState: {},
      actions: {
        go: {
          label: "Go",
          run() {
            throw new Error("boom");
          },
        },
      },
    };

    live = await harness({ modules: [bad] });
    expect(await live.kernel.invoke("bad.go")).toEqual({
      ok: false,
      reason: "That did not work. Check the log.",
    });
    expect(live.log.text()).toContain("bad.go failed");
  });
});
