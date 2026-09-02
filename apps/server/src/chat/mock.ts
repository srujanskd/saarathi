import type { Author, ChannelStats, MockChatInput, StreamEvent } from "@saarathi/shared";
import type { ChatAdapter, ChatSink, ChatWrites } from "./adapter.js";

/**
 * What the bot is called when mock chat echoes its own writes back.
 *
 * It speaks as her, because that is what the real path does: the reply goes out
 * over her own grant, from her own channel, and every rule that reads an author
 * has to see the same thing here as it would on YouTube. That includes the ones
 * with teeth -- moderation exempts her, so the bot cannot end up in her own
 * queue for quoting a link a viewer just posted.
 */
const MOCK_BOT = "Saarathi";

/**
 * The author id mock chat gives a viewer.
 *
 * Exported because it is the key the ledger holds, so a test that wants a
 * viewer to be able to afford something has to write balances under it. One
 * function rather than the prefix spelled out at every seeding site: change the
 * scheme here and a seeder cannot quietly start funding nobody.
 */
export function mockAuthorId(name: string): string {
  return `mock:${name}`;
}

/**
 * The id mock chat gives a message.
 *
 * It gives one at all, which is a reversal: this adapter used to hand out none,
 * on the reasoning that the honest thing for a stand-in to say about a platform
 * id is that it has not got one. That was right while nothing could act on one
 * and wrong the moment her queue grew buttons -- with no ids, taking a message
 * down, sweeping the queue and lockdown were all things only a live stream
 * could exercise, which is the one outcome this adapter exists to prevent. It
 * is the same argument that put roles on `MockChatInput`.
 *
 * A row with no id is still a real state -- YouTube's own library does not
 * always give us one -- and it is still rendered as one. It is just not the
 * state every mock message is in.
 */
function mockMessageId(n: number): string {
  return `mock:msg:${n}`;
}

/**
 * Mock chat. Always registered, never conditional: every chat-driven feature
 * has to be drivable without a live stream, or nobody can test it. The control
 * page and POST /api/mock-chat both end up here.
 */
export class MockChatAdapter implements ChatAdapter {
  readonly name = "mock";
  /** Real counts always win over these. See `ChatAdapter.standIn`. */
  readonly standIn = true;
  private sink: ChatSink | null = null;
  private polls = 0;
  /** Numbers the ids come off, so what a demo removes is what it flagged. */
  private messages = 0;
  /**
   * One run is one stream, which is honest for a stand-in: the counts below
   * start over when the process does, and this is what says so. It is what
   * lets a stream-scoped goal be watched re-arming without a live stream.
   */
  private readonly streamKey = `mock:${Date.now()}`;

  /** Message ids handed to `writes.deleteMessage`, in order. */
  readonly deleted: string[] = [];
  /** Author ids handed to `writes.ban`, in order. */
  readonly banned: string[] = [];

  /**
   * Mock chat writes, and this is the reason it is the first producer of them
   * rather than the last: everything the write path decides -- which tier gets
   * cut first, what a coalescing window merges, what the counter says at the end
   * of the day -- is observable from a keyboard here, with no Google account
   * anywhere near it. A no-op would have made every one of those a thing only a
   * live stream could show.
   *
   * `say` echoes into its own event stream, so a reply arrives as a message the
   * way a reply on YouTube does: it lands in her chat log, and the rules that
   * watch chat see it. The two moderation calls only record, because the only
   * honest thing a stand-in can do with a delete is remember it was asked for
   * -- and what it records are ids it handed out itself, so a demo of her queue
   * proves the id made the whole round trip rather than proving a button fired.
   */
  readonly writes: ChatWrites = {
    say: async (text: string) => this.speak(text),
    deleteMessage: async (messageId: string) => void this.deleted.push(messageId),
    ban: async (authorId: string) => void this.banned.push(authorId),
  };

  async start(sink: ChatSink): Promise<void> {
    this.sink = sink;
    sink.status({ state: "connected", detail: "Mock chat ready" });
  }

  async stop(): Promise<void> {
    this.sink = null;
  }

  /**
   * Numbers that climb, so a goal can be watched filling up without a live
   * stream. This is the same rule that makes mock chat unconditional: a feature
   * nobody can demo without going live is a feature only its author can test,
   * and she is not going live to find out whether a bar moves.
   *
   * They climb per call rather than per second so a test that advances fake
   * timers gets the same answer every run. Subscribers start under 1,000 --
   * where she is, and where YouTube still reports an exact figure -- and move
   * far slower than likes, because that is what the real pair does.
   */
  async stats(): Promise<ChannelStats> {
    this.polls += 1;
    return {
      counts: {
        subscribers: 940 + Math.floor(this.polls / 5),
        likes: 12 + this.polls,
      },
      stream: this.streamKey,
      detail: "Mock numbers, climbing",
    };
  }

  send(input: MockChatInput): void {
    if (!this.sink) return;
    const text = input.text?.trim();
    if (!text) return;

    const role = input.role ?? "viewer";
    const author: Author = {
      id: mockAuthorId(input.author || "TestViewer"),
      name: input.author || "TestViewer",
      isStreamer: role === "streamer",
      isMod: role === "mod",
      // The join event says member as much as the role does: someone whose
      // membership starts this second is a member for every rule that asks.
      isMember: role === "member" || input.type === "member",
    };
    this.messages += 1;
    const base = {
      source: this.name,
      author,
      at: Date.now(),
      text,
      messageId: mockMessageId(this.messages),
    };

    let event: StreamEvent;
    if (input.type === "superchat") {
      event = {
        ...base,
        type: "paid-event",
        kind: "superchat",
        amount: { display: input.amount || "$5.00" },
      };
    } else if (input.type === "member") {
      event = { ...base, type: "new-member" };
    } else {
      event = { ...base, type: "chat-message" };
    }

    this.sink.event(event);
  }

  /** The bot's own line, back through the sink that carries everything else. */
  private speak(text: string): void {
    const line = text.trim();
    if (!this.sink || !line) return;
    this.messages += 1;
    this.sink.event({
      type: "chat-message",
      source: this.name,
      author: { id: mockAuthorId(MOCK_BOT), name: MOCK_BOT, isStreamer: true },
      at: Date.now(),
      text: line,
      // The bot's own line is a message on the platform with an id like any
      // other. It is never flagged -- she is exempt and it speaks as her --
      // but a stand-in that numbered only half its stream would be lying
      // about a different thing.
      messageId: mockMessageId(this.messages),
    });
  }
}
