import { useEffect, useState } from "react";
import { GOALS_ID, GOAL_ALERT_MS, type Goal, type GoalsState } from "@saarathi/shared";
import { useModuleState, type Connection } from "../../lib/connection.js";
import { playChime } from "./chime.js";
import { atTarget, celebrating, countText, fill, toGo } from "./progress.js";
import "./goals.css";

/** Shared, so an overlay with no goals does not hand React a new array a
 * render. */
const NONE: Goal[] = [];

/**
 * Her goals, over her camera.
 *
 * It renders and it decides nothing: whether a goal has landed is the server's
 * answer, and it arrives as a timestamp in the slice rather than as an event
 * this page had to be present for. That is what makes a browser source that
 * reloads mid-celebration rejoin the celebration in progress instead of
 * starting a second one -- the same trick the wheel plays with `startedAt`.
 */
export function GoalsOverlay({ connection }: { connection: Connection }) {
  const state = useModuleState<GoalsState>(connection, GOALS_ID);
  const goals = state?.goals ?? NONE;

  // A celebration ends by the clock, and no patch arrives to say so. One timer
  // for the next one due, rather than one per goal or an interval that repaints
  // the browser source forever.
  const [, redraw] = useState(0);
  const now = connection.serverNow();
  const nextEnd = goals.reduce<number | null>((soonest, goal) => {
    if (goal.completedAt === null) return soonest;
    const ends = goal.completedAt + GOAL_ALERT_MS;
    if (ends <= now) return soonest;
    return soonest === null || ends < soonest ? ends : soonest;
  }, null);

  // The chime, off the effect rather than off the stamp in the slice. A
  // completion that is already in the state is one this page may have just
  // reconnected to, and a browser source reloading mid celebration must rejoin
  // it silently -- the sound belongs to the moment, the bar belongs to the
  // state. Missing one because nothing was connected is the right outcome too:
  // there was nobody to hear it.
  useEffect(() => {
    let audio: AudioContext | null = null;

    const stop = connection.onEffect((effect) => {
      if (effect.module !== GOALS_ID || effect.name !== "goal-complete") return;
      // Built on the first goal that lands rather than on mount, so a browser
      // source that sits at zero goals all stream holds no audio hardware.
      audio ??= new AudioContext();
      // OBS starts a browser source with autoplay allowed, so this resolves
      // there. A plain browser suspends it until somebody clicks, and a
      // silent chime on a dev machine is not worth a permission prompt.
      if (audio.state === "suspended") void audio.resume().catch(() => undefined);
      playChime(audio);
    });

    return () => {
      stop();
      void audio?.close().catch(() => undefined);
    };
  }, [connection]);

  useEffect(() => {
    if (nextEnd === null) return;
    const timer = setTimeout(() => redraw((n) => n + 1), nextEnd - connection.serverNow());
    return () => clearTimeout(timer);
  }, [connection, nextEnd]);

  return (
    <div className="goals" data-testid="goals">
      {goals.map((goal) => (
        <GoalBar key={goal.id} goal={goal} now={now} />
      ))}
    </div>
  );
}

function GoalBar({ goal, now }: { goal: Goal; now: number }) {
  const remaining = toGo(goal);
  const landed = atTarget(goal);

  return (
    <div
      className="goal"
      data-landed={landed}
      data-celebrating={celebrating(goal, now)}
      data-testid="goal"
    >
      <p className="goal-top">
        <span className="goal-label">{goal.label}</span>
        <span className="goal-count">{countText(goal)}</span>
      </p>
      <div className="goal-track">
        {/* scaleX rather than width: a width transition repaints the whole
            browser source every frame, and she is streaming at 60fps. */}
        <div className="goal-fill" style={{ transform: `scaleX(${fill(goal)})` }} />
      </div>
      <p className="goal-foot">
        {landed ? "Done" : remaining === null ? "Counting" : `${remaining.toLocaleString()} to go`}
      </p>
    </div>
  );
}
