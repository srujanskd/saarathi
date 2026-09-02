import { afterEach, describe, expect, it } from "vitest";
import { MAX_FLAGS, MODERATION_ID, WHEEL_ID } from "@saarathi/shared";
import { MemoryStore } from "../../src/core/store.js";
import { moderation } from "../../src/modules/moderation/index.js";
import { wheel } from "../../src/modules/wheel/index.js";
import { harness, moderationState, wheelState, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
});

async function withModeration(store = new MemoryStore()): Promise<Harness> {
  live = await harness({ modules: [moderation], store });
  return live;
}

describe("watching her chat", () => {
  it("flags a scam link from a viewer and says which rule caught it", async () => {
    const kit = await withModeration();
    kit.chat({ author: "Spammer", text: "free coaching, message me on whatsapp" });

    const state = moderationState(kit.kernel);
    expect(state.flags).toHaveLength(1);
    expect(state.flags[0]).toMatchObject({
      authorName: "Spammer",
      kind: "scams",
      reason: "Asks people to message an account off-platform",
      // The handle a delete needs, carried through from the adapter. Mock chat
      // hands these out precisely so that acting on one is demoable.
      messageId: "mock:msg:1",
    });
    expect(state.caught).toBe(1);
    expect(state.seen).toBe(1);
  });

  it("counts an ordinary message and flags nothing", async () => {
    const kit = await withModeration();
    kit.chat({ author: "Regular", text: "great set, how many reps was that?" });

    const state = moderationState(kit.kernel);
    expect(state.flags).toEqual([]);
    expect(state.seen).toBe(1);
    expect(state.caught).toBe(0);
  });

  it("never flags her, and never flags a mod, but counts them both", async () => {
    const kit = await withModeration();
    // The exact line that got the viewer flagged above.
    kit.chat({ author: "Her", text: "message me on whatsapp", role: "streamer" });
    kit.chat({ author: "Mod", text: "message me on whatsapp", role: "mod" });
    kit.chat({ author: "Member", text: "message me on whatsapp", role: "member" });

    const state = moderationState(kit.kernel);
    // Only the member: membership is bought, and a bought account is exactly
    // what a determined scammer turns up on.
    expect(state.flags.map((flag) => flag.authorName)).toEqual(["Member"]);
    expect(state.seen).toBe(3);
  });

  it("inspects a command too, because a command is a message", async () => {
    // The kernel promotes "!" lines to chat-command before any module sees
    // them, so a module subscribing only to chat-message would never see this.
    const kit = await withModeration();
    kit.chat({ author: "Spammer", text: "!spin bit.ly/free-stuff" });

    expect(moderationState(kit.kernel).flags[0]).toMatchObject({ kind: "links" });
  });

  it("catches a flood once it crosses her threshold", async () => {
    const kit = await withModeration();
    // Six is the default, and the five before it are not a flood.
    for (let i = 0; i < 5; i += 1) kit.chat({ author: "Floody", text: `line ${i}` });
    expect(moderationState(kit.kernel).flags).toEqual([]);

    kit.chat({ author: "Floody", text: "line 5" });
    expect(moderationState(kit.kernel).flags[0]).toMatchObject({
      kind: "flood",
      reason: "6 messages in ten seconds",
    });
  });

  it("counts each viewer's flood separately", async () => {
    const kit = await withModeration();
    for (let i = 0; i < 5; i += 1) {
      kit.chat({ author: "Alice", text: `a${i}` });
      kit.chat({ author: "Bob", text: `b${i}` });
    }
    // Ten messages, nobody over six of their own.
    const state = moderationState(kit.kernel);
    expect(state.seen).toBe(10);
    expect(state.flags).toEqual([]);
  });

  it("says nothing to her chat about a flagged message", async () => {
    // A bot line saying a message was flagged tells the scammer which rule
    // caught them and tells everyone else something was removed.
    const kit = await withModeration();
    kit.chat({ author: "Spammer", text: "bit.ly/free-stuff" });

    expect(kit.seen.said()).toEqual([]);
    expect(kit.seen.effectsNamed("flagged")).toHaveLength(0);
  });

  it("holds the newest flags and no more than the cap", async () => {
    const kit = await withModeration();
    for (let i = 0; i < MAX_FLAGS + 5; i += 1) {
      kit.chat({ author: `Bot${i}`, text: `evil${i}.tk/x` });
    }

    const state = moderationState(kit.kernel);
    expect(state.flags).toHaveLength(MAX_FLAGS);
    expect(state.caught).toBe(MAX_FLAGS + 5);
    // Newest first, so the queue she opens is the wave that is happening now.
    expect(state.flags[0]?.authorName).toBe(`Bot${MAX_FLAGS + 4}`);
  });
});

describe("her rules", () => {
  it("stops catching a kind she switches off", async () => {
    const kit = await withModeration();
    expect(
      await kit.kernel.invoke(`${MODERATION_ID}.setRule`, { args: ["links", "off", ""] }),
    ).toEqual({ ok: true });

    kit.chat({ author: "Linker", text: "bit.ly/whatever" });
    expect(moderationState(kit.kernel).flags).toEqual([]);
  });

  it("catches what she adds to her word list", async () => {
    const kit = await withModeration();
    await kit.kernel.invoke(`${MODERATION_ID}.setRule`, {
      args: ["words", "on", "peloton, treadmill"],
    });

    kit.chat({ author: "Viewer", text: "my Treadmill broke" });
    expect(moderationState(kit.kernel).flags[0]).toMatchObject({
      kind: "words",
      reason: "Said “treadmill”",
    });
  });

  it("refuses a pattern that could hang the server and keeps the old one", async () => {
    const kit = await withModeration();
    await kit.kernel.invoke(`${MODERATION_ID}.setRule`, {
      args: ["pattern", "on", "free\\s+iphone"],
    });

    const refused = await kit.kernel.invoke(`${MODERATION_ID}.setRule`, {
      args: ["pattern", "on", "(a+)+b"],
    });
    expect(refused.ok).toBe(false);

    // Hers is still the one running, which is the point of refusing before
    // writing rather than after.
    kit.chat({ author: "Viewer", text: "FREE iPhone giveaway" });
    expect(moderationState(kit.kernel).flags[0]).toMatchObject({ kind: "pattern" });
  });

  it("puts the rules back the way they started", async () => {
    const kit = await withModeration();
    await kit.kernel.invoke(`${MODERATION_ID}.setRule`, { args: ["links", "off", ""] });
    await kit.kernel.invoke(`${MODERATION_ID}.resetRules`);

    kit.chat({ author: "Linker", text: "bit.ly/whatever" });
    expect(moderationState(kit.kernel).flags[0]).toMatchObject({ kind: "links" });
  });
});

describe("the way out", () => {
  it("leaves one flag and refuses one that is already gone", async () => {
    const kit = await withModeration();
    kit.chat({ author: "Spammer", text: "bit.ly/x" });
    const id = moderationState(kit.kernel).flags[0]!.id;

    expect(await kit.kernel.invoke(`${MODERATION_ID}.dismiss`, { args: [id] })).toEqual({
      ok: true,
    });
    expect(moderationState(kit.kernel).flags).toEqual([]);

    const again = await kit.kernel.invoke(`${MODERATION_ID}.dismiss`, { args: [id] });
    expect(again).toEqual({ ok: false, reason: "That one is gone" });
  });

  it("clears the queue, and says so when there is nothing to clear", async () => {
    const kit = await withModeration();
    kit.chat({ author: "Spammer", text: "bit.ly/x" });

    expect(await kit.kernel.invoke(`${MODERATION_ID}.clear`)).toEqual({ ok: true });
    expect(moderationState(kit.kernel).flags).toEqual([]);
    expect(await kit.kernel.invoke(`${MODERATION_ID}.clear`)).toEqual({
      ok: false,
      reason: "Nothing in the queue",
    });
  });

  it("stops watching entirely when she switches the module off", async () => {
    const kit = await withModeration();
    await kit.kernel.invoke("core.disable", { args: [MODERATION_ID] });

    kit.chat({ author: "Spammer", text: "bit.ly/x" });
    expect(moderationState(kit.kernel).seen).toBe(0);
  });
});

describe("across a restart", () => {
  it("keeps her rules and the queue she has not dealt with", async () => {
    const store = new MemoryStore();
    const first = await withModeration(store);
    await first.kernel.invoke(`${MODERATION_ID}.setRule`, {
      args: ["words", "on", "treadmill"],
    });
    first.chat({ author: "Spammer", text: "bit.ly/x" });
    expect(moderationState(first.kernel).flags).toHaveLength(1);
    await first.stop();

    // The restart she does not think about: a crash mid-stream is not a reason
    // she stops needing to see the scam link that arrived before it.
    const second = await withModeration(store);
    const state = moderationState(second.kernel);
    expect(state.flags).toHaveLength(1);
    expect(state.flags[0]).toMatchObject({ authorName: "Spammer", kind: "links" });
    expect(state.rules.find((rule) => rule.kind === "words")).toMatchObject({
      enabled: true,
      value: "treadmill",
    });

    // And the counters do not survive, because they are about this run.
    expect(state.seen).toBe(0);
    expect(state.caught).toBe(0);
  });

  it("leaves the rest of the pipeline alone", async () => {
    // Registered beside a game, since that is how she will run it. A flagged
    // message is watched and queued and stops nothing: the wheel she asked for
    // in the same moment still turns.
    live = await harness({ modules: [wheel, moderation] });
    live.chat({ author: "Spammer", text: "bit.ly/free-stuff" });
    expect(await live.kernel.invoke(`${WHEEL_ID}.spin`)).toEqual({ ok: true });

    expect(wheelState(live.kernel).spin).not.toBeNull();
    expect(moderationState(live.kernel).flags).toHaveLength(1);
  });
});
