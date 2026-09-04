import { describe, expect, it, vi } from "vitest";
import { GAINS, type ConnectionStatus, type StreamEvent } from "@saarathi/shared";
import type { ChatSink } from "../../src/chat/adapter.js";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { normalize, parseAmount } from "../../src/chat/youtube.js";

/** A sink that keeps what an adapter pushed at it. */
function testSink() {
  const events: StreamEvent[] = [];
  const statuses: ConnectionStatus[] = [];
  const sink: ChatSink = {
    event: (e) => events.push(e),
    status: (s) => statuses.push(s),
    changed: () => {},
  };
  return { sink, events, statuses };
}

describe("MockChatAdapter", () => {
  it("reports itself connected so her status page shows a working chat", async () => {
    const { sink, statuses } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    expect(statuses).toEqual([{ state: "connected", detail: "Mock chat ready" }]);
  });

  it("is named, since the name keys its status", () => {
    expect(new MockChatAdapter().name).toBe("mock");
  });

  it("sends a plain chat message", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    adapter.send({ text: "hello" });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "chat-message",
      source: "mock",
      text: "hello",
      author: { id: "mock:TestViewer", name: "TestViewer" },
    });
  });

  it("does not parse commands itself: that is the kernel's job", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    adapter.send({ text: "!spin" });
    expect(events[0]!.type).toBe("chat-message");
  });

  it("uses the author it was given, and namespaces the id", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    adapter.send({ author: "Someone", text: "hi" });
    // All three flags stated rather than left off, exactly as the YouTube
    // adapter states them: a rule reading `isMod` should not be able to tell
    // which adapter a message came through.
    expect(events[0]!.author).toEqual({
      id: "mock:Someone",
      name: "Someone",
      isStreamer: false,
      isMod: false,
      isMember: false,
    });
  });

  it("sends as whoever the role says, so a rule about mods can be driven", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);

    adapter.send({ author: "Her", text: "hi", role: "streamer" });
    adapter.send({ author: "Mod", text: "hi", role: "mod" });
    adapter.send({ author: "Fan", text: "hi", role: "member" });
    adapter.send({ author: "Viewer", text: "hi" });

    expect(events.map((event) => event.author)).toEqual([
      { id: "mock:Her", name: "Her", isStreamer: true, isMod: false, isMember: false },
      { id: "mock:Mod", name: "Mod", isStreamer: false, isMod: true, isMember: false },
      { id: "mock:Fan", name: "Fan", isStreamer: false, isMod: false, isMember: true },
      { id: "mock:Viewer", name: "Viewer", isStreamer: false, isMod: false, isMember: false },
    ]);
  });

  it("counts a join as a member talking, whatever the role said", async () => {
    // `type: "member"` is the join event and `role: "member"` is a member
    // talking. Someone whose membership starts this second is a member for
    // every rule that asks, so the join implies the flag.
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    adapter.send({ author: "Fan", text: "just joined!", type: "member" });

    expect(events[0]!.type).toBe("new-member");
    expect(events[0]!.author.isMember).toBe(true);
  });

  it("trims the text and drops a line with nothing in it", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    adapter.send({ text: "  padded  " });
    adapter.send({ text: "   " });
    adapter.send({ text: "" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ text: "padded" });
  });

  it("makes a superchat, with a default amount so she can fire one off fast", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    adapter.send({ text: "take my money", type: "superchat" });
    expect(events[0]).toMatchObject({
      type: "paid-event",
      kind: "superchat",
      amount: { display: "$5.00" },
    });
  });

  it("keeps the amount it was handed", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    adapter.send({ text: "big one", type: "superchat", amount: "₹500.00" });
    expect(events[0]).toMatchObject({ amount: { display: "₹500.00" } });
  });

  it("makes a new member, and flags them as one", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    adapter.send({ text: "joined", type: "member" });
    expect(events[0]).toMatchObject({ type: "new-member", author: { isMember: true } });
  });

  it("goes quiet after stop instead of throwing", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    await adapter.stop();
    expect(() => adapter.send({ text: "hello" })).not.toThrow();
    expect(events).toHaveLength(0);
  });

  it("drops a send before start, since nothing is listening yet", () => {
    const adapter = new MockChatAdapter();
    expect(() => adapter.send({ text: "hello" })).not.toThrow();
  });
});

describe("MockChatAdapter writes", () => {
  it("echoes what the bot said back as a message, the way a real reply lands", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    const reply = `@TestViewer 12 ${GAINS.plural}`;
    await adapter.writes.say(reply);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "chat-message",
      source: "mock",
      text: reply,
      // As her, because that is who the grant belongs to on the real path --
      // and it is what keeps the bot out of her own moderation queue.
      author: { id: "mock:Saarathi", name: "Saarathi", isStreamer: true },
    });
  });

  it("records a delete and a ban rather than pretending to do them", async () => {
    const { sink } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    await adapter.writes.deleteMessage("msg-1");
    await adapter.writes.ban("mock:Spammer");

    expect(adapter.deleted).toEqual(["msg-1"]);
    expect(adapter.banned).toEqual(["mock:Spammer"]);
  });

  it("says nothing after stop, and nothing about nothing", async () => {
    const { sink, events } = testSink();
    const adapter = new MockChatAdapter();
    await adapter.start(sink);
    await adapter.writes.say("   ");
    expect(events).toHaveLength(0);

    await adapter.stop();
    await adapter.writes.say("anyone there");
    expect(events).toHaveLength(0);
  });
});

describe("youtube normalize", () => {
  const author = { name: "Viewer", channelId: "UC123" };
  const message = (text: string) => [{ text }];

  it("joins the message runs into one line", () => {
    const event = normalize({ author, message: [{ text: "hello " }, { text: "world" }] });
    expect(event).toMatchObject({ type: "chat-message", text: "hello world" });
  });

  it("keeps emoji as their shortcode text so a command still parses", () => {
    const event = normalize({ author, message: [{ text: "!spin " }, { emojiText: ":muscle:" }] });
    expect(event).toMatchObject({ text: "!spin :muscle:" });
  });

  it("labels the source, and nothing downstream may branch on it", () => {
    expect(normalize({ author, message: message("hi" ) })).toMatchObject({ source: "youtube" });
  });

  it("prefers the channel id, so a rename does not become a new viewer", () => {
    const event = normalize({ author, message: message("hi") });
    expect(event!.author).toMatchObject({ id: "UC123", name: "Viewer" });
  });

  it("falls back to the name when there is no channel id", () => {
    const event = normalize({ author: { name: "Viewer" }, message: message("hi") });
    expect(event!.author.id).toBe("Viewer");
  });

  it("does not crash on an item with nothing recognisable in it", () => {
    for (const item of [{}, null, undefined, { author: null }, { message: null }]) {
      expect(() => normalize(item)).not.toThrow();
    }
    expect(normalize({})).toBeNull();
  });

  it("names an unknown author rather than leaving a blank", () => {
    const event = normalize({ message: message("hi") });
    expect(event!.author).toMatchObject({ id: "unknown", name: "unknown" });
  });

  it("normalizes the badges the rules are allowed to care about", () => {
    const event = normalize({
      author: { ...author, badge: {} },
      isOwner: true,
      isModerator: true,
      message: message("hi"),
    });
    expect(event!.author).toMatchObject({ isStreamer: true, isMod: true, isMember: true });
  });

  it("flags a badged author as a member", () => {
    const event = normalize({ author: { ...author, badge: { thumbnail: {} } }, message: message("hi") });
    expect(event!.author.isMember).toBe(true);
  });

  it("leaves the flags false rather than undefined, so no rule sees a maybe", () => {
    const event = normalize({ author, message: message("hi") });
    expect(event!.author).toMatchObject({ isStreamer: false, isMod: false, isMember: false });
  });

  it("makes a superchat a paid-event", () => {
    const event = normalize({ author, message: message("go on"), superchat: { amount: "$5.00" } });
    expect(event).toMatchObject({
      type: "paid-event",
      kind: "superchat",
      amount: { display: "$5.00", value: 5 },
    });
  });

  it("calls a sticker a sticker, and treats it as money all the same", () => {
    const event = normalize({
      author,
      message: message(""),
      superchat: { amount: "$2.00", sticker: {} },
    });
    expect(event).toMatchObject({ type: "paid-event", kind: "sticker" });
  });

  it("keeps a paid event with no text, because the money is the point", () => {
    const event = normalize({ author, message: [], superchat: { amount: "$1.00" } });
    expect(event).toMatchObject({ type: "paid-event", text: "" });
  });

  it("makes a membership a new-member", () => {
    const event = normalize({ author, message: message("joined"), isMembership: true });
    expect(event).toMatchObject({ type: "new-member" });
  });

  it("treats a paid membership gift as money first", () => {
    const event = normalize({
      author,
      message: message("gifted"),
      isMembership: true,
      superchat: { amount: "$10.00" },
    });
    expect(event).toMatchObject({ type: "paid-event" });
  });

  it("drops an empty ordinary message: there is nothing to log or match", () => {
    expect(normalize({ author, message: [] })).toBeNull();
    expect(normalize({ author, message: [{ text: "   " }] })).toBeNull();
  });

  it("stamps arrival time, since YouTube's own is not reliable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    expect(normalize({ author, message: message("hi") })!.at).toBe(1_700_000_000_000);
    vi.useRealTimers();
  });
});

describe("parseAmount", () => {
  it("keeps what YouTube displayed and pulls the number out", () => {
    expect(parseAmount("$5.00")).toEqual({ display: "$5.00", value: 5 });
    expect(parseAmount("₹500.00")).toEqual({ display: "₹500.00", value: 500 });
    expect(parseAmount("CA$1.99")).toEqual({ display: "CA$1.99", value: 1.99 });
  });

  it("still reports the display when it cannot find a number", () => {
    expect(parseAmount("a lot")).toEqual({ display: "a lot" });
  });

  it("says 'a tip' rather than nothing when there is no display at all", () => {
    for (const input of ["", null, undefined, 5, {}]) {
      expect(parseAmount(input), String(input)).toEqual({ display: "a tip" });
    }
  });

  it("omits the value instead of reporting NaN", () => {
    const amount = parseAmount("$1.2.3");
    expect(amount.display).toBe("$1.2.3");
    expect("value" in amount).toBe(false);
  });
});
