import { useState, type FormEvent } from "react";
import { CHATLOG_ID, type ChatLogState, type MockChatInput } from "@saarathi/shared";
import { useBotReplies, useModuleState } from "../../lib/connection.js";
import type { CardProps } from "../types.js";
import { formatEvent } from "./format.js";

type Kind = NonNullable<MockChatInput["type"]>;

const KINDS: { value: Kind; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "superchat", label: "Paid" },
  { value: "member", label: "Join" },
];

export function ChatCard({ connection, status }: CardProps) {
  const state = useModuleState<ChatLogState>(connection, CHATLOG_ID);
  const replies = useBotReplies(connection);
  const [author, setAuthor] = useState("");
  const [text, setText] = useState("");
  const [kind, setKind] = useState<Kind>("chat");
  const [amount, setAmount] = useState("");

  function send(event: FormEvent): void {
    event.preventDefault();
    const line = text.trim();
    if (!line) return;
    const input: MockChatInput = { text: line, type: kind };
    const who = author.trim();
    if (who) input.author = who;
    if (kind === "superchat") input.amount = amount.trim() || "$5.00";
    connection.mockChat(input);
    setText("");
  }

  const events = state?.events ?? [];

  return (
    <section className="card" data-testid="chat-card">
      <h2>{status.title}</h2>
      <p className="hint">Mock chat. Does not go to YouTube.</p>

      <form className="mock" onSubmit={send}>
        <div className="segment" role="radiogroup" aria-label="Kind">
          {KINDS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="seg"
              role="radio"
              aria-checked={kind === option.value}
              data-active={kind === option.value}
              onClick={() => setKind(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <div className="mock-row">
          <label className="field">
            <span>From</span>
            <input
              className="input"
              data-testid="mock-author"
              value={author}
              placeholder="TestViewer"
              autoComplete="off"
              onChange={(event) => setAuthor(event.target.value)}
            />
          </label>
          {kind === "superchat" ? (
            <label className="field">
              <span>Amount</span>
              <input
                className="input"
                data-testid="mock-amount"
                value={amount}
                placeholder="$5.00"
                autoComplete="off"
                inputMode="decimal"
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
          ) : null}
        </div>
        <label className="field">
          <span>Message</span>
          <input
            className="input"
            data-testid="mock-text"
            value={text}
            placeholder="!spin"
            autoComplete="off"
            enterKeyHint="send"
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <button type="submit" className="btn" data-testid="mock-send">
          Send
        </button>
      </form>

      {replies.length > 0 ? (
        <ul className="bot-replies" data-testid="bot-replies">
          {replies.map((line, index) => (
            <li key={`${index}:${line}`}>{line}</li>
          ))}
        </ul>
      ) : null}

      {events.length === 0 ? (
        <p className="empty">Nothing yet. Send !spin to try a turn.</p>
      ) : (
        <ol className="log" data-testid="chat-log">
          {events.map((event, index) => {
            const line = formatEvent(event);
            return (
              <li key={`${event.at}:${index}`} data-kind={line.kind}>
                <span className="log-who">{line.who}</span>
                <span className="log-what">{line.what}</span>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
