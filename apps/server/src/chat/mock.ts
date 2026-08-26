import type { Author, MockChatInput, StreamEvent } from "@saarathi/shared";
import type { ChatAdapter, ChatSink } from "./adapter.js";

/**
 * Mock chat. Always registered, never conditional: every chat-driven feature
 * has to be drivable without a live stream, or nobody can test it. The control
 * page and POST /api/mock-chat both end up here.
 */
export class MockChatAdapter implements ChatAdapter {
  readonly name = "mock";
  private sink: ChatSink | null = null;

  async start(sink: ChatSink): Promise<void> {
    this.sink = sink;
    sink.status({ state: "connected", detail: "Mock chat ready" });
  }

  async stop(): Promise<void> {
    this.sink = null;
  }

  send(input: MockChatInput): void {
    if (!this.sink) return;
    const text = input.text?.trim();
    if (!text) return;

    const author: Author = {
      id: `mock:${input.author || "TestViewer"}`,
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
