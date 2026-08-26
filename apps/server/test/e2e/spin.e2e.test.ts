import { rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { SPIN_DURATION_MS, type ChatLogState, type WheelState } from "@saarathi/shared";
import { startServer, type RunningServer } from "./helpers/server.js";

let server: RunningServer | null = null;
/** Directories a restart test kept alive across two processes. */
let carried: string[] = [];

afterEach(async () => {
  await server?.stop();
  server = null;
  for (const dir of carried) rmSync(dir, { recursive: true, force: true });
  carried = [];
});

/**
 * Stop a run but keep its state file, so the next process reads what she would
 * have on disk. The directory is cleaned up after the test, not before.
 */
async function restart(first: RunningServer): Promise<string> {
  const { stateFile, stateDir } = first;
  if (stateDir) carried.push(stateDir);
  await first.stop({ keepState: true });
  return stateFile;
}

const wheelOf = (state: unknown) => state as WheelState;

describe("a spin, end to end", () => {
  it("reaches the overlay when chat types !spin", async () => {
    server = await startServer();
    const overlay = await server.connect({ surface: "overlay", modules: ["wheel"] });

    await server.mockChat({ author: "Viewer", text: "!spin" });
    await overlay.waitFor("a wheel patch", (c) => c.patches.some((p) => p.module === "wheel"));

    const state = wheelOf(overlay.latest("wheel"));
    expect(state.spin).not.toBeNull();
    expect(state.spin!.by).toBe("Viewer");
    expect(state.spin!.via).toBe("chat");
    expect(state.spin!.durationMs).toBe(SPIN_DURATION_MS);
    expect(state.challenges).toContain(state.spin!.label);
  });

  it("sends the effect the overlay animates on, alongside the state", async () => {
    server = await startServer();
    const overlay = await server.connect({ surface: "overlay", modules: ["wheel"] });

    await server.mockChat({ text: "!spin" });
    await overlay.waitFor("spin-started", (c) =>
      c.effects.some((e) => e.name === "spin-started"),
    );

    const effect = overlay.effects.find((e) => e.name === "spin-started")!;
    expect(effect.module).toBe("wheel");
    // The state carrying that label must already be in hand, or the sound
    // plays a frame before there is anything to show with it.
    const state = wheelOf(overlay.latest("wheel"));
    expect(effect.payload).toEqual({ label: state.spin!.label });
  });

  it("reaches her control page and the overlay at the same time", async () => {
    server = await startServer();
    const overlay = await server.connect({ surface: "overlay", modules: ["wheel"] });
    const control = await server.connect({ surface: "control" });

    await server.mockChat({ text: "!spin" });
    await overlay.waitFor("overlay patch", (c) => c.patches.some((p) => p.module === "wheel"));
    await control.waitFor("control patch", (c) => c.patches.some((p) => p.module === "wheel"));

    expect(wheelOf(overlay.latest("wheel")).spin!.label).toBe(
      wheelOf(control.latest("wheel")).spin!.label,
    );
  });

  it("does not send the chat log to an overlay that never subscribed", async () => {
    server = await startServer();
    const overlay = await server.connect({ surface: "overlay", modules: ["wheel"] });
    const control = await server.connect({ surface: "control", modules: ["chatlog"] });

    await server.mockChat({ text: "hello" });
    await control.waitFor("chatlog patch", (c) => c.patches.some((p) => p.module === "chatlog"));

    expect(overlay.patches.some((p) => p.module === "chatlog")).toBe(false);
    expect((control.latest("chatlog") as ChatLogState).events).toHaveLength(1);
  });

  it("runs from her control page over the socket, with an ack", async () => {
    server = await startServer();
    const control = await server.connect({ surface: "control" });

    expect(await control.invoke({ action: "wheel.spin" })).toEqual({ ok: true });
    await control.waitFor("wheel patch", (c) => c.patches.some((p) => p.module === "wheel"));
    expect(wheelOf(control.latest("wheel")).spin!.via).toBe("control");
  });

  it("acks a refusal rather than going silent", async () => {
    server = await startServer();
    const control = await server.connect({ surface: "control" });
    expect(await control.invoke({ action: "wheel.cancel" })).toEqual({
      ok: false,
      reason: "Nothing is on the wheel right now",
    });
    expect(await control.invoke({ action: "nope.nope" })).toMatchObject({ ok: false });
  });

  it("runs from HTTP too, for a hotkey or a script", async () => {
    server = await startServer();
    expect(await server.invoke({ action: "wheel.spin" })).toEqual({ ok: true });
    const state = wheelOf((await server.get("/api/state") as { modules: Record<string, unknown> }).modules.wheel);
    expect(state.spin).not.toBeNull();
  });

  it("tells chat why, when the cooldown turns a second !spin away", async () => {
    server = await startServer();
    const control = await server.connect({ surface: "control" });

    await server.mockChat({ author: "First", text: "!spin" });
    await control.waitFor("first spin", (c) => c.patches.some((p) => p.module === "wheel"));
    control.clear();

    await server.mockChat({ author: "Second", text: "!spin" });
    await control.waitFor("a say", (c) => c.effects.some((e) => e.name === "say"));

    const said = control.effects.find((e) => e.name === "say")!.payload as { text: string };
    expect(said.text).toContain("@Second");
    expect(said.text).toContain("cooling down");
  });

  it("queues a superchat spin and shows chat where in line it is", async () => {
    server = await startServer();
    const control = await server.connect({ surface: "control" });

    await control.invoke({ action: "wheel.spin" });
    await control.waitFor("first spin", (c) => c.patches.some((p) => p.module === "wheel"));
    control.clear();

    await server.mockChat({ author: "Tipper", text: "burpees please", type: "superchat" });
    await control.waitFor("queued", (c) => c.effects.some((e) => e.name === "spin-queued"));

    expect(control.effects.find((e) => e.name === "spin-queued")!.payload).toEqual({
      by: "Tipper",
      position: 1,
    });
    expect(wheelOf(control.latest("wheel")).queue).toHaveLength(1);
  });
});

describe("an overlay that reloads mid-stream", () => {
  it("lands mid-spin with everything it needs to render, no replay", async () => {
    server = await startServer();
    const first = await server.connect({ surface: "overlay", modules: ["wheel"] });

    await server.mockChat({ author: "Viewer", text: "!spin" });
    await first.waitFor("spin", (c) => c.patches.some((p) => p.module === "wheel"));
    const label = wheelOf(first.latest("wheel")).spin!.label;

    // OBS reloading the browser source: the old socket is simply gone.
    await first.close();

    const reloaded = await server.connect({ surface: "overlay", modules: ["wheel"] });
    const state = wheelOf(reloaded.snapshots.at(-1)!.modules.wheel);

    expect(state.spin).not.toBeNull();
    expect(state.spin!.label).toBe(label);
    // It can work out how far through the animation it is from these two alone.
    expect(state.spin!.startedAt).toBeTypeOf("number");
    expect(state.spin!.durationMs).toBe(SPIN_DURATION_MS);
  });

  it("keeps receiving patches after the reconnect", async () => {
    server = await startServer();
    const first = await server.connect({ surface: "overlay", modules: ["wheel"] });
    await first.close();

    const reloaded = await server.connect({ surface: "overlay", modules: ["wheel"] });
    await server.invoke({ action: "wheel.spin" });
    await reloaded.waitFor("a patch", (c) => c.patches.some((p) => p.module === "wheel"));
    expect(wheelOf(reloaded.latest("wheel")).spin).not.toBeNull();
  });

  it("sees a queue it was not present for", async () => {
    server = await startServer();
    await server.invoke({ action: "wheel.spin" });
    await server.mockChat({ author: "Tipper", text: "money", type: "superchat" });

    const late = await server.connect({ surface: "control" });
    const state = wheelOf(late.snapshots.at(-1)!.modules.wheel);
    expect(state.queue.map((q) => q.by)).toEqual(["Tipper"]);
  });
});

describe("a server that restarts", () => {
  it("still owes the spin somebody paid for", async () => {
    const first = await startServer();
    await first.invoke({ action: "wheel.spin" });
    await first.mockChat({ author: "Tipper", text: "money", type: "superchat" });

    const before = wheelOf(
      ((await first.get("/api/state")) as { modules: Record<string, unknown> }).modules.wheel,
    );
    expect(before.queue).toHaveLength(1);

    // Same file, new process: the queue is hers, the spin in flight was not.
    const stateFile = await restart(first);
    server = await startServer({ stateFile });
    const control = await server.connect({ surface: "control" });

    // Nothing is on the wheel after a restart, so the drain runs straight away.
    await control.waitFor("the owed spin", (c) => {
      const state = wheelOf(c.latest("wheel"));
      return state?.spin !== null && state?.queue.length === 0;
    });

    const after = wheelOf(control.latest("wheel"));
    expect(after.spin).toMatchObject({ by: "Tipper", via: "paid" });
    expect(after.queue).toEqual([]);
  });

  it("keeps her challenge list and her history", async () => {
    const first = await startServer();
    await first.invoke({ action: "wheel.setChallenges", args: ["10 burpees", "30s plank"] });
    await first.invoke({ action: "wheel.spin" });
    const stateFile = await restart(first);

    server = await startServer({ stateFile });
    const state = wheelOf(
      ((await server.get("/api/state")) as { modules: Record<string, unknown> }).modules.wheel,
    );
    expect(state.challenges).toEqual(["10 burpees", "30s plank"]);
    expect(state.history).toHaveLength(1);
    expect(["10 burpees", "30s plank"]).toContain(state.history[0]!.label);
  });

  it("does not leave a stale spin frozen on the overlay", async () => {
    const first = await startServer();
    await first.invoke({ action: "wheel.spin" });
    const stateFile = await restart(first);

    server = await startServer({ stateFile });
    const state = wheelOf(
      ((await server.get("/api/state")) as { modules: Record<string, unknown> }).modules.wheel,
    );
    expect(state.spin).toBeNull();
  });

  it("keeps the module switches she set", async () => {
    const first = await startServer();
    await first.invoke({ action: "core.disable", args: ["wheel"] });
    const stateFile = await restart(first);

    server = await startServer({ stateFile });
    expect(await server.invoke({ action: "wheel.spin" })).toEqual({
      ok: false,
      reason: "Challenge wheel is switched off",
    });
  });
});
