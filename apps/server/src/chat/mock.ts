import type { Author, ChannelStats, MockChatInput, StreamEvent } from "@saarathi/shared";
import type { ChatAdapter, ChatSink } from "./adapter.js";

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
  /**
   * One run is one stream, which is honest for a stand-in: the counts below
   * start over when the process does, and this is what says so. It is what
   * lets a stream-scoped goal be watched re-arming without a live stream.
   */
  private readonly streamKey = `mock:${Date.now()}`;

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

    const author: Author = {
      id: mockAuthorId(input.author || "TestViewer"),
      name: input.author || "TestViewer",
      isMember: input.type === "member",
    };
    const base = { source: this.name, author, at: Date.now(), text };

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
}
