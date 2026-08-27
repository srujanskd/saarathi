import { describe, expect, it } from "vitest";
import type { StreamEvent } from "@saarathi/shared";
import { formatEvent } from "../../src/modules/chatlog/format.js";

const base = {
  source: "mock",
  author: { id: "mock:anita", name: "anita" },
  at: 1,
  text: "hello",
};

describe("a row on the chat card", () => {
  it("keeps ordinary chat as the text they sent", () => {
    const event: StreamEvent = { ...base, type: "chat-message" };
    expect(formatEvent(event)).toEqual({ who: "anita", what: "hello", kind: "chat-message" });
  });

  it("keeps a command as the original text, bang included", () => {
    const event: StreamEvent = {
      ...base,
      type: "chat-command",
      command: "spin",
      args: [],
      text: "!spin",
    };
    expect(formatEvent(event)).toEqual({ who: "anita", what: "!spin", kind: "chat-command" });
  });

  it("puts the paid amount in front of the message", () => {
    const event: StreamEvent = {
      ...base,
      type: "paid-event",
      kind: "superchat",
      amount: { display: "$5.00" },
      text: "do burpees",
    };
    expect(formatEvent(event).what).toBe("$5.00 · do burpees");
  });

  it("still shows the amount when they paid with no message", () => {
    const event: StreamEvent = {
      ...base,
      type: "paid-event",
      kind: "superchat",
      amount: { display: "$5.00" },
      text: "",
    };
    expect(formatEvent(event).what).toBe("$5.00");
  });

  it("marks a member join without inventing a message", () => {
    const event: StreamEvent = { ...base, type: "new-member", text: "" };
    expect(formatEvent(event)).toEqual({ who: "anita", what: "joined", kind: "new-member" });
  });
});
