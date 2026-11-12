import { describe, expect, it } from "vitest";
import type { PaidEvent } from "@saarathi/shared";
import { paidMessage, paidSpeech, systemVoice } from "../../src/modules/media/speech.js";

const event = (over: Partial<PaidEvent> = {}): PaidEvent => ({
  type: "paid-event", kind: "superchat", source: "mock", at: 1,
  author: { id: "ana", name: "Ana" }, amount: { display: "$5.00" }, text: "Keep going!", ...over,
});
const paid = (over: Partial<PaidEvent> = {}) => paidMessage(event(over), "message");

describe("paid speech text", () => {
  it("uses the same message for tips and Super Chats, including a thanks for empty stickers", () => {
    expect(paidSpeech(paid())).toBe("Ana sent $5.00. Keep going!");
    expect(paidSpeech(paid({ kind: "tip" }))).toBe("Ana sent $5.00. Keep going!");
    expect(paidSpeech(paid({ kind: "sticker", text: "" }))).toBe("Ana sent $5.00. Thank you!");
  });

  it("keeps the arrival time and the id it was given", () => {
    expect(paid({ at: 42 })).toEqual({ id: "message", at: 42, name: "Ana", amount: "$5.00", text: "Keep going!" });
  });

  it("bounds every viewer-controlled field and removes control characters", () => {
    const text = paidSpeech(paid({
      author: { id: "ana", name: "a".repeat(100) },
      amount: { display: "b".repeat(100) }, text: "c".repeat(10_000),
    }));
    expect(text).toBe(`${"a".repeat(40)} sent ${"b".repeat(24)}. ${"c".repeat(180)}`);
    expect(paidSpeech(paid({ text: "hello\u0000\nworld" }))).toBe("Ana sent $5.00. hello world");
  });

  it("reports unsupported server platforms without trying to launch a voice", () => {
    expect(systemVoice("linux")).toBeUndefined();
    expect(systemVoice("win32")).toBeTypeOf("function");
    expect(systemVoice("darwin")).toBeTypeOf("function");
  });
});
