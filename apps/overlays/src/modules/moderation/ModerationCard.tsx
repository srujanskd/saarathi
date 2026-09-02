import { useEffect, useState, type ChangeEvent } from "react";
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
import type { DeckDraft } from "../../core/useDeckDraft.js";
import { useCoreState, useModuleState } from "../../lib/connection.js";
import { useInvoke, type Invoker } from "../../lib/invoke.js";
import type { CardProps } from "../types.js";
import { lockdownLeft, purgeLine } from "./lockdown.js";
import "./moderation-card.css";

export function ModerationCard({ connection, deck, status }: CardProps) {
  const state = useModuleState<ModerationState>(connection, MODERATION_ID);
  const core = useCoreState(connection);
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

  /**
   * Whether anything can write to her platform at all.
   *
   * Read off the write meter rather than from a flag of moderation's own,
   * because it is the same capability: an adapter that can post a reply is an
   * adapter that can take a message down, and `writes.adapter` is the core
   * already having decided which one would do it. So this card learns whether
   * she is signed in without learning that YouTube exists, and it flips the
   * moment she signs in with no reload and nothing stored.
   */
  const canAct = (core?.writes.adapter ?? null) !== null;

  const until = state?.lockdownUntil ?? null;
  const [now, setNow] = useState(() => connection.serverNow());
  const left = lockdownLeft(until, now);

  // A clock only while there is something to count down, and it stops itself
  // when there is not: an interval that keeps ticking is her phone
  // re-rendering forever for a number nobody is reading. Same shape as the
  // wheel card's, and for the same reason.
  useEffect(() => {
    if (until === null || connection.serverNow() >= until) return;
    const id = setInterval(() => {
      const at = connection.serverNow();
      setNow(at);
      if (at >= until) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [connection, until]);

  const swept = purgeLine(state?.purge ?? null);

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

      {/* Offered only where it could work. Lockdown with nothing signed in is
          a switch that flips and changes nothing, which is worse than a switch
          that is not there -- and it is the state a dev run and a fresh
          install are both in. */}
      {canAct ? (
        <div className="panic" data-on={left ? "yes" : "no"} data-testid="moderation-panic">
          <div className="panic-words">
            <span className="panic-label">Lockdown</span>
            <p className="hint" data-testid="moderation-lockdown-state">
              {left
                ? `On, ${left}. Anything the rules catch is taken down as it arrives.`
                : "Takes down anything the rules catch instead of queueing it."}
            </p>
          </div>
          <button
            type="button"
            className="tool"
            data-on={left ? "yes" : "no"}
            disabled={busy}
            data-testid="moderation-lockdown"
            onClick={() =>
              void run(`${MODERATION_ID}.${left ? "lockdownOff" : "lockdown"}`, [])
            }
          >
            {left ? "Off" : "On"}
          </button>
        </div>
      ) : null}

      {swept ? (
        <p className="hint" data-testid="moderation-purge">
          {swept}
        </p>
      ) : null}

      {flags.length === 0 ? (
        <p className="empty" data-testid="moderation-empty">
          Nothing flagged. Anything her rules catch shows up here.
        </p>
      ) : (
        <>
          {/* With nothing signed in this is still the only thing she can do
              about a bad message, so the sentence stays -- it is what the card
              said on every build before there was a write path, and it is what
              a VPS with a revoked grant says again. */}
          {canAct ? null : (
            <p className="hint" data-testid="moderation-elsewhere">
              Remove anything bad from the live dashboard, then leave it here.
            </p>
          )}
          <ul className="flag-rows" data-testid="moderation-flags">
            {flags.map((flag) => (
              <FlagRow
                key={flag.id}
                flag={flag}
                busy={busy}
                canAct={canAct}
                onDismiss={() => void run(`${MODERATION_ID}.dismiss`, [flag.id])}
                onRemove={() => void run(`${MODERATION_ID}.remove`, [flag.id])}
                onBan={() => void run(`${MODERATION_ID}.ban`, [flag.id])}
              />
            ))}
          </ul>
          <div className="rule-tools">
            {canAct ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                data-testid="moderation-purge-run"
                onClick={() => void run(`${MODERATION_ID}.purge`, [])}
              >
                Sweep the queue
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              disabled={busy}
              data-testid="moderation-clear"
              onClick={() => void run(`${MODERATION_ID}.clear`, [])}
            >
              Clear the queue
            </button>
          </div>
        </>
      )}

      {/* The three worth a physical button, and the reason they are the three:
          each one is something she wants during a wave, when she is not
          reading a screen. Behind a fold because putting a button on the deck
          is a thing she does once, in a quiet moment. */}
      {canAct ? (
        <details className="fold">
          <summary>
            <span>Panic buttons on the deck</span>
          </summary>
          <p className="hint">
            Lockdown expires on its own after a few minutes. End lockdown is the way
            out before then.
          </p>
          <div className="rule-tools">
            <DeckButton deck={deck} invoke={invoke} action="lockdown" label="Lockdown" icon="🔒" />
            <DeckButton
              deck={deck}
              invoke={invoke}
              action="lockdownOff"
              label="Unlock"
              icon="🔓"
            />
            <DeckButton deck={deck} invoke={invoke} action="purge" label="Sweep" icon="🧹" />
          </div>
        </details>
      ) : null}

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

/**
 * One flagged message and what she can do about it.
 *
 * The three buttons are not the same kind of thing, which is why they are not
 * offered on the same terms. Leave it is always there: it is hers, it touches
 * nothing outside this app, and it is the way out of a queue that got long.
 * Ban them needs only an author id, which every adapter gives us. Take it down
 * needs the platform's own id for the message, and that is genuinely absent on
 * some rows -- mock chat hands out none at all -- so the row says so instead of
 * offering a button that can only refuse. That difference has to be rendered:
 * she is holding a phone during a raid, and finding out by pressing is the same
 * cost as not being told.
 */
function FlagRow({
  flag,
  busy,
  canAct,
  onDismiss,
  onRemove,
  onBan,
}: {
  flag: ModFlag;
  busy: boolean;
  /** Whether anything can write to her platform right now. */
  canAct: boolean;
  onDismiss: () => void;
  onRemove: () => void;
  onBan: () => void;
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
      <div className="flag-tools">
        {canAct ? (
          <>
            {flag.messageId === null ? (
              <span className="hint" data-testid="moderation-no-id">
                No message to take down
              </span>
            ) : (
              <button
                type="button"
                className="tool"
                disabled={busy}
                data-testid="moderation-remove"
                onClick={onRemove}
              >
                Take it down
              </button>
            )}
            <button
              type="button"
              className="tool tool-danger"
              disabled={busy}
              data-testid="moderation-ban"
              onClick={onBan}
            >
              Ban them
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="tool"
          disabled={busy}
          data-testid="moderation-dismiss"
          onClick={onDismiss}
        >
          Leave it
        </button>
      </div>
    </li>
  );
}

/** One panic action onto her grid. Three copies of eight lines, otherwise. */
function DeckButton({
  deck,
  invoke,
  action,
  label,
  icon,
}: {
  deck: DeckDraft;
  invoke: Invoker;
  action: string;
  label: string;
  icon: string;
}) {
  return (
    <button
      type="button"
      className="btn"
      disabled={invoke.working}
      data-testid={`moderation-deck-${action}`}
      onClick={() =>
        void addToDeck(deck, invoke, {
          action: `${MODERATION_ID}.${action}`,
          args: [],
          label,
          icon,
        })
      }
    >
      {label}
    </button>
  );
}
