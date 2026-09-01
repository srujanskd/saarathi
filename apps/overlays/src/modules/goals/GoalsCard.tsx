import { useState } from "react";
import {
  GOALS_ID,
  GOAL_SOURCES,
  isPolled,
  MAX_GOALS,
  MAX_GOAL_LABEL,
  type Goal,
  type GoalScope,
  type GoalSource,
  type GoalsState,
} from "@saarathi/shared";
import { Notice } from "../../core/Notice.js";
import { addToDeck } from "../../core/addToDeck.js";
import { useCoreState, useModuleState } from "../../lib/connection.js";
import { useInvoke } from "../../lib/invoke.js";
import type { CardProps } from "../types.js";
import { countText, toGo } from "./progress.js";
import "./goals-card.css";

interface Draft {
  label: string;
  target: string;
  source: GoalSource;
  scope: GoalScope;
  scene: string;
}

/**
 * A subscriber count carries across streams; likes belong to one video and
 * start again with the next. She should not have to know that, so picking a
 * source picks the scope that goes with it -- and she can still change it,
 * because "50 push-ups today" and "50 push-ups this year" are both real.
 */
const NATURAL_SCOPE: Record<GoalSource, GoalScope> = {
  subscribers: "channel",
  likes: "stream",
  members: "stream",
  tips: "stream",
  manual: "stream",
};

const BLANK: Draft = {
  label: "",
  target: "",
  source: "subscribers",
  scope: "channel",
  scene: "",
};

export function GoalsCard({ connection, deck }: CardProps) {
  const core = useCoreState(connection);
  const state = useModuleState<GoalsState>(connection, GOALS_ID);
  const invoke = useInvoke(connection);
  const [draft, setDraft] = useState<Draft | null>(null);

  const goals = state?.goals ?? [];
  const scenes = core?.obs.scenes ?? [];
  const fields = draft ?? BLANK;
  const busy = invoke.working;
  const { run } = invoke;

  async function add(): Promise<void> {
    const args = [fields.label, fields.target, fields.source, fields.scope, fields.scene];
    if (await run(`${GOALS_ID}.add`, args)) setDraft(null);
  }

  /** A "+1" button for a goal she counts herself, onto the grid she is
   * looking at. See `addToDeck`. */
  async function addBumpToDeck(goal: Goal): Promise<void> {
    await addToDeck(deck, invoke, {
      action: `${GOALS_ID}.bump`,
      args: [goal.id],
      label: goal.label,
      icon: "➕",
    });
  }

  return (
    <section className="card" data-testid="goals-card">
      <h2>Goals</h2>

      {invoke.notice ? (
        <Notice notice={invoke.notice} testId="goals-notice" onDismiss={invoke.dismiss} />
      ) : null}

      {goals.length === 0 ? (
        <p className="empty" data-testid="goals-empty">
          No goals yet. Add one and it appears on the overlay.
        </p>
      ) : (
        <ul className="goal-rows" data-testid="goal-rows">
          {goals.map((goal) => (
            <li key={goal.id} className="goal-row" data-landed={goal.completedAt !== null}>
              <p className="goal-row-top">
                <span>{goal.label}</span>
                <span className="goal-row-count">{countText(goal)}</span>
              </p>
              <p className="hint">{whereFrom(goal)}</p>

              <div className="goal-row-tools">
                {!isPolled(goal.source) ? (
                  <>
                    <button
                      type="button"
                      className="tool"
                      disabled={busy}
                      data-testid="goal-bump"
                      onClick={() => void run(`${GOALS_ID}.bump`, [goal.id])}
                    >
                      +1
                    </button>
                    {/* The way back out of a miscount. She is counting reps
                        with her thumb between sets, so the tap that lands
                        twice is the normal case and not the odd one. */}
                    <button
                      type="button"
                      className="tool"
                      disabled={busy || !goal.current}
                      data-testid="goal-unbump"
                      onClick={() => void run(`${GOALS_ID}.bump`, [goal.id, "-1"])}
                    >
                      −1
                    </button>
                    <button
                      type="button"
                      className="tool"
                      disabled={busy}
                      onClick={() => void addBumpToDeck(goal)}
                    >
                      On the deck
                    </button>
                  </>
                ) : null}
                <button
                  type="button"
                  className="tool"
                  disabled={busy}
                  data-testid="goal-reset"
                  onClick={() => void run(`${GOALS_ID}.reset`, [goal.id])}
                >
                  Start again
                </button>
                <button
                  type="button"
                  className="tool"
                  data-tool="remove"
                  disabled={busy}
                  onClick={() => void run(`${GOALS_ID}.remove`, [goal.id])}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <details className="fold">
        <summary>
          <span>Add a goal</span>
          {draft ? (
            <span className="dirty" data-testid="goals-unsaved">
              unsaved
            </span>
          ) : null}
        </summary>

        <label className="field">
          <span>What she is going for</span>
          <input
            className="input"
            data-testid="goal-label"
            value={fields.label}
            maxLength={MAX_GOAL_LABEL}
            placeholder="1,000 subscribers"
            onChange={(event) => setDraft({ ...fields, label: event.target.value })}
          />
        </label>

        <label className="field">
          <span>Target</span>
          <input
            className="input"
            data-testid="goal-target"
            // A number pad rather than a keyboard: she is doing this on a phone.
            inputMode="numeric"
            value={fields.target}
            placeholder="1000"
            onChange={(event) => setDraft({ ...fields, target: event.target.value })}
          />
        </label>

        <label className="field">
          <span>Counting</span>
          <select
            className="select"
            data-testid="goal-source"
            value={fields.source}
            onChange={(event) => {
              const source = event.target.value as GoalSource;
              setDraft({ ...fields, source, scope: NATURAL_SCOPE[source] });
            }}
          >
            {Object.entries(GOAL_SOURCES).map(([id, info]) => (
              <option key={id} value={id}>
                {info.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Runs until</span>
          <select
            className="select"
            data-testid="goal-scope"
            value={fields.scope}
            onChange={(event) =>
              setDraft({ ...fields, scope: event.target.value as GoalScope })
            }
          >
            <option value="channel">She hits it, once</option>
            <option value="stream">This stream, then it starts again</option>
          </select>
        </label>

        {scenes.length > 0 ? (
          <label className="field">
            <span>Cut to a scene when it lands</span>
            <select
              className="select"
              data-testid="goal-scene"
              value={fields.scene}
              onChange={(event) => setDraft({ ...fields, scene: event.target.value })}
            >
              <option value="">Stay where she is</option>
              {scenes.map((scene) => (
                <option key={scene} value={scene}>
                  {scene}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <button
          type="button"
          className="btn btn-primary"
          data-testid="goal-add"
          disabled={busy || goals.length >= MAX_GOALS}
          onClick={() => void add()}
        >
          {goals.length >= MAX_GOALS ? `That is ${MAX_GOALS} goals already` : "Add goal"}
        </button>
        {draft ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setDraft(null)}
          >
            Discard
          </button>
        ) : null}
      </details>
    </section>
  );
}

/** One line about where the number comes from and when it starts again. */
function whereFrom(goal: Goal): string {
  const source = GOAL_SOURCES[goal.source].label;
  const remaining = toGo(goal);
  const where =
    goal.completedAt !== null
      ? "done"
      : remaining === null
        ? "nothing counted yet"
        : `${remaining.toLocaleString()} to go`;
  const scope = goal.scope === "stream" ? "this stream" : "all-time";
  return `${source} · ${scope} · ${where}`;
}
