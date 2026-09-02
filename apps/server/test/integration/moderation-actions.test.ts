import { afterEach, describe, expect, it, vi } from "vitest";
import { LOCKDOWN_MS, MODERATION_ID, NO_WRITER, WRITES_ID } from "@saarathi/shared";
import {
  WriteRefused,
  type ChatAdapter,
  type ChatSink,
  type ChatWrites,
} from "../../src/chat/adapter.js";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { MemoryStore } from "../../src/core/store.js";
import { MODERATION_RESERVE, WRITE_CEILING, quotaDay } from "../../src/core/writes.js";
import { moderation } from "../../src/modules/moderation/index.js";
import { harness, moderationState, type Harness } from "../helpers/kernel.js";

let live: Harness | null = null;
afterEach(async () => {
  await live?.stop();
  live = null;
});

/** The kernel dispatches on a microtask, and so does every write in here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

/** Something worth flagging, in the words the scam rule catches. */
const SCAM = "free coaching, message me on whatsapp";

async function withQueue(over: { store?: MemoryStore; used?: number } = {}) {
  const store = over.store ?? new MemoryStore();
  if (over.used !== undefined) {
    store.write(WRITES_ID, { day: quotaDay(Date.now()), used: over.used });
  }
  const mock = new MockChatAdapter();
  live = await harness({ modules: [moderation], chat: [mock], store });
  return { mock, store, h: live };
}

const flags = (kit: Harness) => moderationState(kit.kernel).flags;
const first = (kit: Harness) => flags(kit)[0]!;

describe("acting on one row of the queue", () => {
  it("takes the message down and drops the row", async () => {
    const { mock, h } = await withQueue();
    h.chat({ author: "Spammer", text: SCAM });
    const flag = first(h);

    const done = await h.kernel.invoke(`${MODERATION_ID}.remove`, { args: [flag.id] });

    expect(done).toEqual({ ok: true });
    // The id it removed is the id the adapter handed out for that message, so
    // this proves the handle survived the whole round trip rather than proving
    // a button fired.
    expect(mock.deleted).toEqual([flag.messageId]);
    expect(flags(h)).toEqual([]);
    expect(moderationState(h.kernel).removed).toBe(1);
  });

  it("leaves the row alone when the platform refuses, and says why", async () => {
    const platform = refusing("that message is gone");
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    platform.viewerSays(SCAM, "Spammer");
    const flag = first(live);

    const done = await live.kernel.invoke(`${MODERATION_ID}.remove`, { args: [flag.id] });

    // Her card renders this reason and the row is still under it, which is the
    // whole reason a moderation write answers where `say` does not.
    expect(done).toEqual({ ok: false, reason: "that message is gone" });
    expect(flags(live)).toHaveLength(1);
    expect(moderationState(live.kernel).removed).toBe(0);
  });

  it("refuses a row the platform never named, in its own words", async () => {
    const platform = anonymous();
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    platform.viewerSays(SCAM, "Spammer");
    const flag = first(live);

    expect(flag.messageId).toBeNull();
    const done = await live.kernel.invoke(`${MODERATION_ID}.remove`, { args: [flag.id] });

    expect(done).toEqual({
      ok: false,
      reason: "This one came from somewhere with no message to take down",
    });
    // Nothing was spent finding that out: the row could never have worked.
    expect(platform.deleted).toEqual([]);
  });

  it("refuses a row that is already gone", async () => {
    const { h } = await withQueue();
    const done = await h.kernel.invoke(`${MODERATION_ID}.remove`, { args: ["not-a-flag"] });
    expect(done).toEqual({ ok: false, reason: "That one is gone" });
  });

  it("bans the author and takes every row of theirs with it", async () => {
    const { mock, h } = await withQueue();
    h.chat({ author: "Spammer", text: SCAM });
    h.chat({ author: "Spammer", text: "and again, whatsapp me" });
    h.chat({ author: "Someone", text: SCAM });
    expect(flags(h)).toHaveLength(3);

    const mine = flags(h).find((flag) => flag.authorName === "Spammer")!;
    const done = await h.kernel.invoke(`${MODERATION_ID}.ban`, { args: [mine.id] });

    expect(done).toEqual({ ok: true });
    expect(mock.banned).toEqual([mine.authorId]);
    // A banned account's other messages are not four more decisions.
    expect(flags(h).map((flag) => flag.authorName)).toEqual(["Someone"]);
  });

  it("bans somebody the platform never gave us a message for", async () => {
    // The asymmetry that has to hold: a ban needs an author id, which every
    // adapter has, so it works on a row where taking the message down cannot.
    const platform = anonymous();
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    platform.viewerSays(SCAM, "Spammer");

    const done = await live.kernel.invoke(`${MODERATION_ID}.ban`, { args: [first(live).id] });

    expect(done).toEqual({ ok: true });
    expect(platform.banned).toEqual(["ghost:Spammer"]);
  });
});

describe("sweeping the whole queue", () => {
  it("takes down everything it can and reports what it did", async () => {
    const { mock, h } = await withQueue();
    for (const author of ["A", "B", "C"]) h.chat({ author, text: SCAM });

    const done = await h.kernel.invoke(`${MODERATION_ID}.purge`);

    expect(done).toEqual({ ok: true });
    expect(mock.deleted).toHaveLength(3);
    expect(flags(h)).toEqual([]);
    expect(moderationState(h.kernel).purge).toMatchObject({ removed: 3, noId: 0, stopped: 0 });
  });

  it("stops at the first refusal rather than spending the rest finding out", async () => {
    const platform = refusing("quota spent for today", 3);
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    for (const author of ["A", "B", "C", "D"]) platform.viewerSays(SCAM, author);

    const done = await live.kernel.invoke(`${MODERATION_ID}.purge`);

    expect(done).toEqual({ ok: false, reason: "quota spent for today" });
    // Two went, the third refused, and nothing after it was attempted.
    expect(platform.deleted).toHaveLength(3);
    // The report is written before it refuses, so the count and the sentence
    // explaining it reach her card together. The two it gave up on are
    // `stopped` and not `noId`: every one of these rows had a message to take
    // down, and telling her they did not would blame her platform for a quota
    // this app spent.
    expect(moderationState(live.kernel).purge).toMatchObject({
      removed: 2,
      noId: 0,
      stopped: 2,
    });
    expect(flags(live)).toHaveLength(2);
  });

  it("counts the rows it never tried apart from the rows it gave up on", async () => {
    // The one queue where a report carries both numbers, and the reason they
    // are two numbers: "no message to take down" is a fact about her platform
    // and "could not be taken down" is a fact about this app, and a single
    // total would render one of them as the other on her phone.
    const platform = patchy();
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    for (const author of ["A", "B", "C", "D"]) platform.viewerSays(SCAM, author);

    const done = await live.kernel.invoke(`${MODERATION_ID}.purge`);

    expect(done).toEqual({ ok: true });
    // Two of the four came with an id, both went, and the other two were never
    // attempted -- so nothing was stopped, and the queue keeps exactly the
    // rows nothing could have been done about.
    expect(platform.deleted).toHaveLength(2);
    expect(moderationState(live.kernel).purge).toMatchObject({
      removed: 2,
      noId: 2,
      stopped: 0,
    });
    expect(flags(live).every((flag) => flag.messageId === null)).toBe(true);
  });

  it("counts the queue as it stood when she pressed, not as it stands after", async () => {
    // A message that arrives mid-sweep is in neither leftover count: it was
    // never this sweep's to remove, and reading it as one would tell her a row
    // she has not seen yet had no message or could not be taken down.
    const platform = patchy();
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    platform.viewerSays(SCAM, "A");
    const sweeping = live.kernel.invoke(`${MODERATION_ID}.purge`);
    platform.viewerSays(SCAM, "B");

    expect(await sweeping).toEqual({ ok: true });
    expect(moderationState(live.kernel).purge).toMatchObject({
      removed: 1,
      noId: 0,
      stopped: 0,
    });
  });

  it("says so rather than sweeping nothing, when no row can be acted on", async () => {
    const platform = anonymous();
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    platform.viewerSays(SCAM, "Spammer");

    const done = await live.kernel.invoke(`${MODERATION_ID}.purge`);

    expect(done).toEqual({
      ok: false,
      reason: "None of these came with a message to take down",
    });
    expect(platform.deleted).toEqual([]);
    // No report either: nothing happened, and "0 removed" would read as broken.
    expect(moderationState(live.kernel).purge).toBeNull();
  });

  it("refuses an empty queue", async () => {
    const { h } = await withQueue();
    expect(await h.kernel.invoke(`${MODERATION_ID}.purge`)).toEqual({
      ok: false,
      reason: "Nothing in the queue",
    });
  });
});

describe("lockdown", () => {
  it("takes what the rules catch down as it arrives, and queues none of it", async () => {
    const { mock, h } = await withQueue();
    expect(await h.kernel.invoke(`${MODERATION_ID}.lockdown`)).toEqual({ ok: true });

    h.chat({ author: "Spammer", text: SCAM });
    await settled();

    const state = moderationState(h.kernel);
    expect(mock.deleted).toHaveLength(1);
    expect(state.flags).toEqual([]);
    expect(state.removed).toBe(1);
    // Still counted as caught: the rules did the catching either way, and the
    // counters are what tell her the layer is alive.
    expect(state.caught).toBe(1);
  });

  it("still lets an ordinary message through", async () => {
    const { mock, h } = await withQueue();
    await h.kernel.invoke(`${MODERATION_ID}.lockdown`);

    h.chat({ author: "Regular", text: "great set, how many reps?" });
    await settled();

    expect(mock.deleted).toEqual([]);
    expect(moderationState(h.kernel).seen).toBe(1);
  });

  it("queues the row after all when the write fails", async () => {
    const platform = refusing("no grant any more");
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    await live.kernel.invoke(`${MODERATION_ID}.lockdown`);

    platform.viewerSays(SCAM, "Spammer");
    await settled();

    // Nothing is lost to a failed write: it lands in the queue it would have
    // gone to anyway, and she deals with it by hand.
    expect(flags(live)).toHaveLength(1);
    expect(moderationState(live.kernel).removed).toBe(0);
  });

  it("queues normally again once it has expired, with nothing running at the time", async () => {
    const { mock, h } = await withQueue();
    await h.kernel.invoke(`${MODERATION_ID}.lockdown`);
    const until = moderationState(h.kernel).lockdownUntil!;

    // No timer switches it off, so nothing has to have been running: the
    // message simply arrives after the moment the timestamp names.
    h.kernel.registry.handleEvent({
      type: "chat-message",
      source: "mock",
      author: { id: "mock:Late", name: "Late" },
      at: until + 1,
      text: SCAM,
      messageId: "mock:msg:late",
    });
    await settled();

    expect(mock.deleted).toEqual([]);
    expect(flags(h)).toHaveLength(1);
  });

  it("is still on after a restart in the middle of it", async () => {
    const store = new MemoryStore();
    const opened = await withQueue({ store });
    await opened.h.kernel.invoke(`${MODERATION_ID}.lockdown`);
    const until = moderationState(opened.h.kernel).lockdownUntil;
    await opened.h.stop();

    // The moment a server is most likely to restart is the middle of the wave
    // she turned this on for, and coming back up unguarded is the one outcome
    // nobody would notice until it was over.
    const again = await withQueue({ store });
    expect(moderationState(again.h.kernel).lockdownUntil).toBe(until);

    again.h.chat({ author: "Spammer", text: SCAM });
    await settled();
    expect(again.mock.deleted).toHaveLength(1);
  });

  it("has a way out, and says so when there is nothing to get out of", async () => {
    const { mock, h } = await withQueue();
    expect(await h.kernel.invoke(`${MODERATION_ID}.lockdownOff`)).toEqual({
      ok: false,
      reason: "Lockdown is not on",
    });

    await h.kernel.invoke(`${MODERATION_ID}.lockdown`);
    expect(await h.kernel.invoke(`${MODERATION_ID}.lockdownOff`)).toEqual({ ok: true });
    expect(moderationState(h.kernel).lockdownUntil).toBeNull();

    h.chat({ author: "Spammer", text: SCAM });
    await settled();
    expect(mock.deleted).toEqual([]);
    expect(flags(h)).toHaveLength(1);
  });

  it("pushes the end out when she presses it again", async () => {
    const { h } = await withQueue();
    // A clock she can be a minute apart on, because the interesting build is
    // the one that ignores the second press: with both presses in the same
    // millisecond, "the end did not come back towards her" is true of that
    // build too, and the test says nothing.
    vi.useFakeTimers({ now: Date.now() });
    try {
      await h.kernel.invoke(`${MODERATION_ID}.lockdown`);
      const firstEnd = moderationState(h.kernel).lockdownUntil!;

      vi.advanceTimersByTime(60_000);
      await h.kernel.invoke(`${MODERATION_ID}.lockdown`);
      const secondEnd = moderationState(h.kernel).lockdownUntil!;

      // A wave that outlasts the window is a second press, not a setting: the
      // end is a full window from now, not a minute off the old one.
      expect(secondEnd).toBe(firstEnd + 60_000);
      expect(secondEnd - Date.now()).toBe(LOCKDOWN_MS);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses to arm when nothing can write, rather than flipping and doing nothing", async () => {
    const platform = mute();
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });

    expect(await live.kernel.invoke(`${MODERATION_ID}.lockdown`)).toEqual({
      ok: false,
      reason: NO_WRITER,
    });
    expect(moderationState(live.kernel).lockdownUntil).toBeNull();
  });
});

describe("what moderation is allowed to spend", () => {
  it("takes a message down on the reserve no reply may touch", async () => {
    // Every reply tier is cut at this point, which is exactly the afternoon a
    // delete matters most.
    const { mock, h } = await withQueue({ used: WRITE_CEILING - MODERATION_RESERVE });
    h.chat({ author: "Spammer", text: SCAM });

    expect(await h.kernel.invoke(`${MODERATION_ID}.remove`, { args: [first(h).id] })).toEqual({
      ok: true,
    });
    expect(mock.deleted).toHaveLength(1);
  });

  it("still tries once even the reserve is gone", async () => {
    const { mock, h } = await withQueue({ used: WRITE_CEILING + 10 });
    h.chat({ author: "Spammer", text: SCAM });

    // A ban is worth eating a 403 for, and refusing locally costs her the one
    // write she actually needed.
    expect(await h.kernel.invoke(`${MODERATION_ID}.ban`, { args: [first(h).id] })).toEqual({
      ok: true,
    });
    expect(mock.banned).toHaveLength(1);
    expect(h.kernel.coreState().writes.used).toBe(WRITE_CEILING + 11);
  });

  it("still tries when the platform says the day is over, and remembers that it said so", async () => {
    // The two halves of this are deliberately different answers to the same
    // fact. A delete attempts anyway -- the reserve exists so it can, and a
    // 403 costs her nothing next to the write she needed. But a moderation
    // refusal is often the first thing to *find out* the quota is gone, and the
    // replies that would otherwise keep spending writes on the discovery are
    // the ones that should stop.
    const platform = exhausted();
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    platform.viewerSays(SCAM, "Spammer");

    const done = await live.kernel.invoke(`${MODERATION_ID}.remove`, { args: [first(live).id] });

    // It tried, it answered with the platform's own sentence, and the row is
    // still there for her to press again after the reset.
    expect(platform.deleted).toHaveLength(1);
    expect(done).toEqual({ ok: false, reason: "YouTube has used up today's quota." });
    expect(flags(live)).toHaveLength(1);

    // And her card now says the bot is quiet rather than showing a counter
    // with room left in it.
    expect(live.kernel.coreState().writes).toMatchObject({ used: 1, outOfQuota: true });
  });

  it("counts a write that threw, because it may still have been charged", async () => {
    const platform = refusing("403");
    live = await harness({ modules: [moderation], chat: [platform], store: new MemoryStore() });
    platform.viewerSays(SCAM, "Spammer");

    await live.kernel.invoke(`${MODERATION_ID}.remove`, { args: [first(live).id] });
    expect(live.kernel.coreState().writes.used).toBe(1);
  });
});

// --- adapters that are not mock chat ----------------------------------------

interface Fake extends ChatAdapter {
  readonly deleted: string[];
  readonly banned: string[];
  viewerSays(text: string, author?: string): void;
}

/**
 * A real adapter -- not a stand-in, so it outranks mock chat -- with the three
 * writes and a switch on each. Every case here is one mock chat cannot reach:
 * a platform that refuses, a platform that names no messages, and a platform
 * that cannot write at all.
 */
function fake(options: {
  name: string;
  writes?: ChatWrites;
  /**
   * Whether events carry the platform's own id for the message.
   *
   * A predicate as well as a switch, because a queue that mixes the two is the
   * only one whose sweep report carries both `noId` and `stopped`, and those
   * two being told apart is the whole point of there being two of them.
   */
  ids?: boolean | ((n: number) => boolean);
}): Fake {
  const deleted: string[] = [];
  const banned: string[] = [];
  let sink: ChatSink | null = null;
  let sent = 0;

  return {
    name: options.name,
    deleted,
    banned,
    ...(options.writes ? { writes: options.writes } : {}),
    async start(next) {
      sink = next;
      next.status({ state: "connected", detail: "up" });
    },
    async stop() {
      sink = null;
    },
    viewerSays(text, author = "TestViewer") {
      sent += 1;
      sink?.event({
        type: "chat-message",
        source: options.name,
        author: { id: `${options.name}:${author}`, name: author },
        at: Date.now(),
        text,
        ...(hasId(options.ids, sent) ? { messageId: `${options.name}:msg:${sent}` } : {}),
      });
    },
  } as Fake;
}

function hasId(ids: boolean | ((n: number) => boolean) | undefined, n: number): boolean {
  if (ids === undefined) return true;
  return typeof ids === "function" ? ids(n) : ids;
}

/** Writes that throw, optionally only from the nth call onwards. */
function refusing(reason: string, from = 1): Fake {
  const adapter: Fake = fake({
    name: "grumpy",
    writes: {
      say: async () => {},
      deleteMessage: async (messageId) => {
        adapter.deleted.push(messageId);
        if (adapter.deleted.length >= from) throw new Error(reason);
      },
      ban: async (authorId) => {
        adapter.banned.push(authorId);
        throw new Error(reason);
      },
    },
  });
  return adapter;
}

/**
 * A platform that has spent the day's quota.
 *
 * Its own helper beside `refusing` because the difference is the whole point:
 * this one throws the refusal that crosses the adapter seam as more than a
 * sentence, and an ordinary `Error` -- which is what `refusing` throws -- must
 * not be mistaken for it.
 */
function exhausted(): Fake {
  const adapter: Fake = fake({
    name: "spent",
    writes: {
      say: async () => {
        throw new WriteRefused("YouTube has used up today's quota.", true);
      },
      deleteMessage: async (messageId) => {
        adapter.deleted.push(messageId);
        throw new WriteRefused("YouTube has used up today's quota.", true);
      },
      ban: async (authorId) => {
        adapter.banned.push(authorId);
        throw new WriteRefused("YouTube has used up today's quota.", true);
      },
    },
  });
  return adapter;
}

/** A platform whose messages carry no id of their own. */
function anonymous(): Fake {
  const adapter: Fake = fake({
    name: "ghost",
    ids: false,
    writes: {
      say: async () => {},
      deleteMessage: async (messageId) => void adapter.deleted.push(messageId),
      ban: async (authorId) => void adapter.banned.push(authorId),
    },
  });
  return adapter;
}

/** A platform that names some of its messages and not others. */
function patchy(): Fake {
  const adapter: Fake = fake({
    name: "patchy",
    ids: (n) => n % 2 === 1,
    writes: {
      say: async () => {},
      deleteMessage: async (messageId) => void adapter.deleted.push(messageId),
      ban: async (authorId) => void adapter.banned.push(authorId),
    },
  });
  return adapter;
}

/** Connected, and cannot write a thing: a VPS with no grant. */
function mute(): Fake {
  return fake({ name: "silent" });
}
