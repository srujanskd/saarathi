import { useState } from "react";
import type { Connection } from "./connection.js";
import type { NoticeText } from "../core/Notice.js";

export interface Invoker {
  /** The action in flight, for a card that greys only the button she pressed. */
  busy: string | null;
  /** Something is in flight, for a card that greys all of them. */
  working: boolean;
  notice: NoticeText | null;
  /** Say something that did not come from a refusal. */
  say(text: string, ok?: boolean): void;
  dismiss(): void;
  /** Fires an action and reports whether the server took it. */
  run(action: string, args?: string[]): Promise<boolean>;
}

/**
 * Pressing a button on one of her cards.
 *
 * Every card does the same three things around an `invoke` -- grey the buttons
 * while it is in flight, show the refusal if there is one, and answer whether
 * it landed -- and they were doing them in three copies of the same eight
 * lines. The behaviour worth keeping in one place is the clear on the way in:
 * a refusal she has already dealt with must not still be sitting on the card
 * when the next press succeeds.
 *
 * The card decides nothing about the action itself. The server is authoritative
 * and its answer is the only thing rendered here.
 */
export function useInvoke(connection: Connection): Invoker {
  const [notice, setNotice] = useState<NoticeText | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  return {
    busy,
    working: busy !== null,
    notice,
    say: (text, ok = true) => setNotice({ text, ok }),
    dismiss: () => setNotice(null),
    async run(action, args) {
      setBusy(action);
      setNotice(null);
      const result = await connection.invoke({ action, args });
      setBusy(null);
      if (!result.ok) setNotice({ text: result.reason, ok: false });
      return result.ok;
    },
  };
}
