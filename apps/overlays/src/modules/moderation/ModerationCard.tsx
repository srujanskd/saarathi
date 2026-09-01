import { useState, type ChangeEvent } from "react";
import {
  MODERATION_ID,
  MOD_RULES,
  type ModFlag,
  type ModRule,
  type ModRuleInput,
  type ModRuleKind,
  type ModerationState,
} from "@saarathi/shared";
import { Notice } from "../../core/Notice.js";
import { addToDeck } from "../../core/addToDeck.js";
import { useModuleState } from "../../lib/connection.js";
import { useInvoke } from "../../lib/invoke.js";
import type { CardProps } from "../types.js";
import "./moderation-card.css";

export function ModerationCard({ connection, deck, status }: CardProps) {
  const state = useModuleState<ModerationState>(connection, MODERATION_ID);
  const invoke = useInvoke(connection);
  /**
   * Her edits, per rule, and only the ones she has actually touched.
   *
   * Keyed rather than one draft at a time because the fold shows every rule at
   * once: a single draft would silently drop the word list when she moved on to
   * the caps threshold, which is losing something she typed.
   */
  const [drafts, setDrafts] = useState<Partial<Record<ModRuleKind, string>>>({});

  const rules = state?.rules ?? [];
  const flags = state?.flags ?? [];
  const seen = state?.seen ?? 0;
  const caught = state?.caught ?? 0;
  const busy = invoke.working;
  const { run } = invoke;

  function draftOf(rule: ModRule): string {
    return drafts[rule.kind] ?? rule.value;
  }

  function setDraft(kind: ModRuleKind, value: string | undefined): void {
    setDrafts((current) => ({ ...current, [kind]: value }));
  }

  async function save(rule: ModRule, next: Partial<ModRule>): Promise<void> {
    const merged = { ...rule, value: draftOf(rule), ...next };
    const ok = await run(`${MODERATION_ID}.setRule`, [
      merged.kind,
      merged.enabled ? "on" : "off",
      merged.value,
    ]);
    // Only on success, so a refusal leaves what she typed on screen to fix.
    // The server is the authority on whether a pattern is safe to keep.
    if (ok) setDraft(rule.kind, undefined);
  }

  return (
    <section className="card" data-testid="moderation-card">
      <h2>{status.title}</h2>

      {invoke.notice ? (
        <Notice notice={invoke.notice} testId="moderation-notice" onDismiss={invoke.dismiss} />
      ) : null}

      <p className="hint" data-testid="moderation-counts">
        {seen === 0
          ? "Nothing has come through chat yet"
          : `${seen} message${seen === 1 ? "" : "s"} watched, ${caught} flagged`}
      </p>

      {flags.length === 0 ? (
        <p className="empty" data-testid="moderation-empty">
          Nothing flagged. Anything her rules catch shows up here.
        </p>
      ) : (
        <>
          {/* She cannot delete from here yet, and the card says so rather than
              offering a button that does nothing. Removing a message needs a
              Google sign-in this build does not have. */}
          <p className="hint">Remove anything bad from the live dashboard, then leave it here.</p>
          <ul className="flag-rows" data-testid="moderation-flags">
            {flags.map((flag) => (
              <FlagRow
                key={flag.id}
                flag={flag}
                busy={busy}
                onDismiss={() => void run(`${MODERATION_ID}.dismiss`, [flag.id])}
              />
            ))}
          </ul>
          <button
            type="button"
            className="btn"
            disabled={busy}
            data-testid="moderation-clear"
            onClick={() => void run(`${MODERATION_ID}.clear`, [])}
          >
            Clear the queue
          </button>
        </>
      )}

      <details className="fold">
        <summary>
          <span>Rules</span>
          {Object.values(drafts).some((value) => value !== undefined) ? (
            <span className="dirty" data-testid="moderation-unsaved">
              unsaved
            </span>
          ) : null}
        </summary>

        {rules.map((rule) => {
          const info = MOD_RULES[rule.kind];
          const draft = draftOf(rule);
          const edited = draft !== rule.value;
          return (
            <div className="rule" key={rule.kind} data-testid="moderation-rule">
              <div className="rule-top">
                <span className="rule-label">{info.label}</span>
                {/* A switch and not a checkbox: it is the control she reaches
                    for mid-workout, and it has to be a target not a tick. */}
                <button
                  type="button"
                  className="tool"
                  data-on={rule.enabled ? "yes" : "no"}
                  disabled={busy}
                  data-testid={`moderation-toggle-${rule.kind}`}
                  onClick={() => void save(rule, { enabled: !rule.enabled })}
                >
                  {rule.enabled ? "On" : "Off"}
                </button>
              </div>
              <p className="hint">{info.hint}</p>

              {info.input === "none" ? null : (
                <label className="field">
                  <span>{info.field}</span>
                  <RuleValue
                    kind={rule.kind}
                    input={info.input}
                    value={draft}
                    onChange={(next) => setDraft(rule.kind, next)}
                  />
                </label>
              )}

              {edited ? (
                <div className="rule-tools">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busy}
                    data-testid={`moderation-save-${rule.kind}`}
                    onClick={() => void save(rule, {})}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => setDraft(rule.kind, undefined)}
                  >
                    Discard
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}

        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="moderation-reset"
          onClick={() => void run(`${MODERATION_ID}.resetRules`, [])}
        >
          Put the rules back
        </button>

        {/* The one action here worth a physical button: the moment she wants
            the rules back is the moment the queue is filling with her own
            regulars, and that is not a moment for editing seven rules. */}
        <button
          type="button"
          className="btn"
          disabled={busy}
          data-testid="moderation-reset-deck"
          onClick={() =>
            void addToDeck(deck, invoke, {
              action: `${MODERATION_ID}.resetRules`,
              args: [],
              label: "Rules back",
              icon: "🛡️",
            })
          }
        >
          On the deck
        </button>
      </details>
    </section>
  );
}

function RuleValue({
  kind,
  input,
  value,
  onChange,
}: {
  kind: ModRuleKind;
  input: Exclude<ModRuleInput, "none">;
  value: string;
  onChange: (value: string) => void;
}) {
  function edit(event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>): void {
    onChange(event.target.value);
  }

  if (input === "list") {
    return (
      <textarea
        className="input"
        rows={2}
        data-testid={`moderation-value-${kind}`}
        value={value}
        onChange={edit}
      />
    );
  }

  return (
    <input
      className="input"
      // A number pad for a threshold, a keyboard for a pattern.
      inputMode={input === "number" ? "numeric" : "text"}
      data-testid={`moderation-value-${kind}`}
      value={value}
      onChange={edit}
    />
  );
}

function FlagRow({
  flag,
  busy,
  onDismiss,
}: {
  flag: ModFlag;
  busy: boolean;
  onDismiss: () => void;
}) {
  return (
    <li className="flag-row">
      <p className="flag-row-top">
        <span className="flag-who">{flag.authorName}</span>
        <span className="flag-why" data-kind={flag.kind}>
          {flag.reason}
        </span>
      </p>
      <p className="flag-text">{flag.text}</p>
      <button
        type="button"
        className="tool"
        disabled={busy}
        data-testid="moderation-dismiss"
        onClick={onDismiss}
      >
        Leave it
      </button>
    </li>
  );
}
