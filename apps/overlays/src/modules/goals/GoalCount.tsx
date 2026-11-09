import { useState } from "react";
import type { Goal } from "@saarathi/shared";
import { countText } from "./progress.js";
import "./count.css";

/** Animate reported values only. Inventing the integers between polls would
 * make a rounded subscriber count look more precise than it is. */
export function GoalCount({ goal }: { goal: Goal }) {
  const [shown, setShown] = useState({ current: goal.current, previous: goal.current });
  if (shown.current !== goal.current) {
    setShown({ current: goal.current, previous: shown.current });
  }
  const moving = shown.current !== null && shown.previous !== null && shown.current !== shown.previous;
  const direction = moving && shown.current! < shown.previous! ? "down" : "up";
  return (
    <span className="goal-count" aria-label={countText(goal)}>
      <span className="goal-digits" data-direction={direction}>
        {moving ? <span className="goal-old" aria-hidden="true">{shown.previous!.toLocaleString()}</span> : null}
        <span
          key={shown.current}
          className={moving ? "goal-new" : undefined}
          aria-hidden="true"
          onAnimationEnd={() => setShown((value) => ({ ...value, previous: value.current }))}
        >
          {shown.current === null ? "—" : shown.current.toLocaleString()}
        </span>
      </span>
      <span className="goal-target" aria-hidden="true"> / {goal.target.toLocaleString()}</span>
    </span>
  );
}
