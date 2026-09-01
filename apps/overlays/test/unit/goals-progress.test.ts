import { describe, expect, it } from "vitest";
import { GOAL_ALERT_MS, type Goal } from "@saarathi/shared";
import {
  celebrating,
  countStep,
  countText,
  fill,
  stepFor,
  toGo,
} from "../../src/modules/goals/progress.js";

function goal(over: Partial<Goal> = {}): Goal {
  return {
    id: "g1",
    label: "1,000 subscribers",
    target: 1_000,
    source: "subscribers",
    scope: "channel",
    current: null,
    completedAt: null,
    streamKey: null,
    scene: "",
    ...over,
  };
}

describe("the smallest move a count can make", () => {
  it("is one, while she is small enough for an exact number", () => {
    expect(countStep(0)).toBe(1);
    expect(countStep(940)).toBe(1);
    expect(countStep(999)).toBe(1);
  });

  it("is ten in the thousands and a hundred in the ten-thousands", () => {
    // Three significant figures: "37700" came back for a 37.7K channel, and
    // the real number is somewhere in a hundred-wide band.
    expect(countStep(1_000)).toBe(10);
    expect(countStep(9_999)).toBe(10);
    expect(countStep(10_000)).toBe(100);
    expect(countStep(37_700)).toBe(100);
    expect(countStep(1_000_000)).toBe(10_000);
  });

  it("is one for every count that is not rounded", () => {
    // Likes are exact, and so is anything the server counted itself.
    expect(stepFor(goal({ source: "likes", target: 50_000 }))).toBe(1);
    expect(stepFor(goal({ source: "manual", target: 50_000 }))).toBe(1);
    expect(stepFor(goal({ source: "subscribers", target: 50_000 }))).toBe(100);
  });
});

describe("how many to go", () => {
  it("counts down exactly while the numbers are exact", () => {
    expect(toGo(goal({ current: 940 }))).toBe(60);
  });

  it("rounds up to a number she can actually be told", () => {
    // 50 to go on a count that moves in hundreds is a bar that looks stuck one
    // step short and then overshoots.
    expect(toGo(goal({ target: 37_750, current: 37_700 }))).toBe(100);
  });

  it("says nothing when there is no count yet, or she is already there", () => {
    expect(toGo(goal())).toBeNull();
    expect(toGo(goal({ current: 1_000 }))).toBeNull();
    expect(toGo(goal({ current: 1_200 }))).toBeNull();
  });
});

describe("how full the bar draws", () => {
  it("is empty with nothing counted, and never past full", () => {
    expect(fill(goal())).toBe(0);
    expect(fill(goal({ current: 500 }))).toBe(0.5);
    expect(fill(goal({ current: 4_000 }))).toBe(1);
  });
});

describe("the celebration", () => {
  it("runs from the moment the server says it landed", () => {
    const landed = goal({ completedAt: 1_000 });
    expect(celebrating(landed, 1_000)).toBe(true);
    // An OBS source that reloads halfway through rejoins this one rather than
    // starting a second one.
    expect(celebrating(landed, 1_000 + GOAL_ALERT_MS / 2)).toBe(true);
    expect(celebrating(landed, 1_000 + GOAL_ALERT_MS)).toBe(false);
  });

  it("is not running for a goal that has not landed", () => {
    expect(celebrating(goal({ current: 999 }), 5_000)).toBe(false);
  });
});

describe("the numbers on the bar", () => {
  it("groups them, and says nothing rather than zero when nothing is known", () => {
    expect(countText(goal({ current: 37_700, target: 40_000 }))).toBe("37,700 / 40,000");
    expect(countText(goal())).toBe("— / 1,000");
  });
});
