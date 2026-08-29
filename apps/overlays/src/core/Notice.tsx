/**
 * The one line a card has to say to her, and the way to put it away.
 *
 * Every surface she touches says things back: a refusal from the server, a
 * confirmation that a press landed. They are one component because they are
 * one promise -- anything the app tells her is dismissible with a thumb, at
 * arm's length, and never scrolls off on its own unless it was good news.
 */
export interface NoticeText {
  text: string;
  /** True only where a success is worth saying out loud. Refusals are false. */
  ok: boolean;
}

export function Notice({
  notice,
  testId,
  onDismiss,
}: {
  notice: NoticeText;
  /** The card's hook for it. Dismiss is `${testId}-dismiss`, everywhere. */
  testId: string;
  onDismiss(): void;
}) {
  return (
    <p className="notice" data-ok={notice.ok} data-testid={testId}>
      <span>{notice.text}</span>
      <button
        type="button"
        className="dismiss"
        aria-label="Dismiss"
        data-testid={`${testId}-dismiss`}
        onClick={onDismiss}
      >
        ×
      </button>
    </p>
  );
}
