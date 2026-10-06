import { afterEach, describe, expect, it } from "vitest";
import { MAX_MOD_USERS, type BoardRow, type ModUser } from "@saarathi/shared";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { gains } from "../../src/modules/gains/index.js";
import { moderation } from "../../src/modules/moderation/index.js";
import { harness, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => { await live?.stop(); live = null; });

function users<T>(query: string, text: string): T[] {
  const result = live!.kernel.registry.query(query, [text]);
  expect(result.ok).toBe(true);
  return result.ok ? result.value as T[] : [];
}

describe("points user search", () => {
  it("finds a zero-balance viewer outside the board by full name and id, then gives and takes points", async () => {
    live = await harness({ modules: [gains] });
    await live.kernel.invoke("gains.rate", { args: ["0"] });
    const name = "A very long viewer name beyond the board";
    live.chat({ author: name, text: "hello" });
    const [row] = users<BoardRow>("gains.users", "  BEYOND THE BOARD ");
    expect(row).toEqual({ id: `mock:${name}`, name, balance: 0, streak: 1 });
    expect(users<BoardRow>("gains.users", `mock:${name}`)).toEqual([row]);
    expect(await live.kernel.invoke("gains.give", { args: [row!.id, "250"] })).toEqual({ ok: true });
    expect(users<BoardRow>("gains.users", "beyond")[0]!.balance).toBe(250);
    expect(await live.kernel.invoke("gains.give", { args: [row!.id, "-250"] })).toEqual({ ok: true });
    expect(users<BoardRow>("gains.users", "beyond")[0]!.balance).toBe(0);
    expect(users("gains.users", "nobody")).toEqual([]);
    expect(users("gains.users", " ")).toEqual([]);
    expect(live.kernel.snapshot().modules.gains).not.toHaveProperty("roster");
  });

  it("limits results, finds users below the top ten, and keeps them over restart", async () => {
    live = await harness({ modules: [gains] });
    await live.kernel.invoke("gains.rate", { args: ["0"] });
    for (let i = 0; i < 25; i += 1) {
      live.chat({ author: `Viewer ${i}`, text: "hello" });
      await live.kernel.invoke("gains.give", { args: [`mock:Viewer ${i}`, String(i + 1)] });
    }
    expect(users("gains.users", "Viewer")).toHaveLength(20);
    expect(users<BoardRow>("gains.users", "Viewer 0")[0]!.balance).toBe(1);
    const store = live.store;
    await live.stop();
    live = await harness({ modules: [gains], store });
    expect(users<BoardRow>("gains.users", "Viewer 0")[0]!.balance).toBe(1);
  });
});

describe("recent chatter moderation search", () => {
  it("finds an unflagged chatter and removes the actual latest message", async () => {
    const mock = new MockChatAdapter();
    live = await harness({ modules: [moderation], chat: [mock] });
    live.chat({ author: "Asha", text: "hello" });
    const [user] = users<ModUser>("moderation.users", " ASHA ");
    expect(user!.text).toBe("hello");
    expect(user!.messageId).toBeTruthy();
    expect(await live.kernel.invoke("moderation.removeUser", { args: [user!.author.id, user!.messageId!] })).toEqual({ ok: true });
    expect(mock.deleted).toEqual([user!.messageId]);
    expect(users("moderation.users", "asha")).toEqual([]);
  });

  it("refuses stale removals and bans the searched user through the adapter", async () => {
    const mock = new MockChatAdapter();
    live = await harness({ modules: [moderation], chat: [mock] });
    live.chat({ author: "Asha", text: "hello" });
    const [old] = users<ModUser>("moderation.users", "mock:Asha");
    live.chat({ author: "Asha", text: "newer" });
    expect(await live.kernel.invoke("moderation.removeUser", { args: [old!.author.id, old!.messageId!] })).toEqual({ ok: false, reason: "They sent a newer message. Search again" });
    expect(mock.deleted).toEqual([]);
    expect(users<ModUser>("moderation.users", "asha")[0]!.text).toBe("newer");
    expect(await live.kernel.invoke("moderation.banUser", { args: [old!.author.id] })).toEqual({ ok: true });
    expect(mock.banned).toEqual([old!.author.id]);
    expect(users("moderation.users", "asha")).toEqual([]);
  });

  it.each(["mod", "streamer"] as const)("protects a %s from searched-user actions", async (role) => {
    const mock = new MockChatAdapter();
    live = await harness({ modules: [moderation], chat: [mock] });
    live.chat({ author: "Asha", text: "hello", role });
    const [user] = users<ModUser>("moderation.users", "asha");
    for (const action of ["banUser", "removeUser"]) {
      expect(await live.kernel.invoke(`moderation.${action}`, { args: [user!.author.id, user!.messageId!] })).toEqual({ ok: false, reason: "Moderators and the streamer are protected" });
    }
    expect(mock.deleted).toEqual([]);
    expect(mock.banned).toEqual([]);
  });

  it("keeps a bounded private history including commands, and clears it on restart", async () => {
    live = await harness({ modules: [moderation] });
    live.chat({ author: "Old viewer", text: "hello" });
    for (let i = 0; i < MAX_MOD_USERS; i += 1) live.chat({ author: `Viewer ${i}`, text: "!unknown" });
    await new Promise((resolve) => setImmediate(resolve));
    expect(users("moderation.users", "Old viewer")).toEqual([]);
    expect(users("moderation.users", "Viewer")).toHaveLength(20);
    expect(live.kernel.snapshot().modules.moderation).not.toHaveProperty("users");
    const store = live.store;
    await live.stop();
    live = await harness({ modules: [moderation], store });
    expect(users("moderation.users", "Viewer")).toEqual([]);
  });
});
