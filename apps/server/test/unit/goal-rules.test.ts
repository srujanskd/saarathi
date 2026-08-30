import { describe, expect, it } from "vitest";
import { MAX_GOAL_LABEL, type Goal } from "@saarathi/shared";
import {
  makeGoal,
  pollGoal,
  resetGoal,
  sameGoals,
  tallyGoal,
} from "../../src/modules/goals/rules.js";

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

describe("a polled goal", () => {
  it("takes the count the poll found", () => {
    const next = pollGoal(goal(), { count: 940, now: 5 });
    expect(next.current).toBe(940);
    expect(next.completedAt).toBeNull();
  });

  it("goes back to knowing nothing when the count goes away", () => {
    // She hid her subscriber count, or the key expired. A bar reading 0 is a
    // claim that nobody has subscribed, and that is a different thing.
    const next = pollGoal(goal({ current: 940 }), { now: 5 });
    expect(next.current).toBeNull();
  });

  it("lands the moment the count reaches the target", () => {
    const next = pollGoal(goal({ current: 999 }), { count: 1_000, now: 77 });
    expect(next.completedAt).toBe(77);
  });

  it("lands when the count jumps straight past the target", () => {
    // Subscriber counts round to three significant figures, so the exact
    // target is a number that may never be reported at all.
    const next = pollGoal(goal({ target: 37_750, current: 37_700 }), {
      count: 37_800,
      now: 77,
    });
    expect(next.completedAt).toBe(77);
  });

  it("stays landed when the count falls back below the target", () => {
    // Somebody un-liked. Firing the alert again on the way back past is the
    // one thing a completion may never do.
    const landed = pollGoal(goal({ source: "likes", target: 50, current: 49 }), {
      count: 50,
      now: 10,
    });
    const dropped = pollGoal(landed, { count: 49, now: 20 });
    expect(dropped.completedAt).toBe(10);
    expect(dropped.current).toBe(49);
  });

  it("keeps the stamp it already had rather than moving it", () => {
    const next = pollGoal(goal({ current: 1_000, completedAt: 10 }), { count: 1_200, now: 99 });
    expect(next.completedAt).toBe(10);
  });
});

describe("a tallied goal", () => {
  it("is not touched by what a poll found", () => {
    const next = pollGoal(goal({ source: "members", target: 5, current: 2 }), {
      count: 940,
      now: 5,
    });
    expect(next.current).toBe(2);
  });

  it("counts up, and lands on the target", () => {
    const next = tallyGoal(goal({ source: "manual", target: 3, current: 2 }), 1, 42);
    expect(next.current).toBe(3);
    expect(next.completedAt).toBe(42);
  });

  it("takes one back when she over-counted", () => {
    expect(tallyGoal(goal({ source: "manual", current: 4 }), -1, 42).current).toBe(3);
  });

  it("never goes below nothing", () => {
    expect(tallyGoal(goal({ source: "manual", current: 1 }), -5, 42).current).toBe(0);
  });
});

describe("a stream-scoped goal", () => {
  const like = (over: Partial<Goal> = {}) =>
    goal({ source: "likes", scope: "stream", target: 50, ...over });

  it("adopts the first stream it sees without losing progress", () => {
    // She counted reps for ten minutes before going live. Those still count.
    const next = pollGoal(
      goal({ source: "manual", scope: "stream", current: 5 }),
      { stream: "vid-1", now: 5 },
    );
    expect(next.current).toBe(5);
    expect(next.streamKey).toBe("vid-1");
  });

  it("puts a counted goal back to a zero it is sure of, not to unknown", () => {
    // No members have joined tonight yet. That is a fact, and "—" is not it.
    const next = pollGoal(
      goal({ source: "members", scope: "stream", current: 3, streamKey: "vid-1" }),
      { stream: "vid-2", now: 20 },
    );
    expect(next.current).toBe(0);
  });

  it("starts again when the next stream starts", () => {
    const landed = pollGoal(like({ current: 49, streamKey: "vid-1" }), {
      count: 50,
      stream: "vid-1",
      now: 10,
    });
    expect(landed.completedAt).toBe(10);

    const tonight = pollGoal(landed, { count: 3, stream: "vid-2", now: 20 });
    expect(tonight.completedAt).toBeNull();
    expect(tonight.current).toBe(3);
    expect(tonight.streamKey).toBe("vid-2");
  });

  it("holds still when there is no stream to speak of", () => {
    // YouTube did not answer this minute, or she has not gone live yet.
    // Treating that as a new stream would wipe the bar on every hiccup.
    const next = pollGoal(like({ current: 30, streamKey: "vid-1", completedAt: 5 }), { now: 20 });
    expect(next.streamKey).toBe("vid-1");
    expect(next.completedAt).toBe(5);
  });

  it("leaves a channel-scoped goal alone across streams", () => {
    const landed = goal({ current: 1_000, completedAt: 10, streamKey: "vid-1" });
    const next = pollGoal(landed, { count: 1_000, stream: "vid-2", now: 20 });
    expect(next.completedAt).toBe(10);
  });
});

describe("starting a goal again", () => {
  it("clears the completion and joins the stream running now", () => {
    const next = resetGoal(goal({ current: 1_000, completedAt: 10 }), "vid-2");
    expect(next.completedAt).toBeNull();
    expect(next.streamKey).toBe("vid-2");
  });

  it("puts a polled goal back to not knowing, and a counted one back to zero", () => {
    expect(resetGoal(goal({ current: 1_000 }), undefined).current).toBeNull();
    expect(resetGoal(goal({ source: "manual", current: 12 }), undefined).current).toBe(0);
  });
});

describe("making a goal", () => {
  const args = ["1,000 subs", "1000", "subscribers", "channel"];

  it("takes what her card sent", () => {
    const made = makeGoal(args, "id-1");
    expect(made).toMatchObject({
      ok: true,
      goal: { label: "1,000 subs", target: 1_000, source: "subscribers", scope: "channel" },
    });
  });

  it("starts a polled goal at unknown and a counted one at zero", () => {
    expect(makeGoal(args, "id-1")).toMatchObject({ goal: { current: null } });
    expect(makeGoal(["Reps", "50", "manual", "stream"], "id-2")).toMatchObject({
      goal: { current: 0 },
    });
  });

  it("refuses a goal with no name", () => {
    expect(makeGoal(["  ", "10", "manual", "channel"], "id-1")).toEqual({
      ok: false,
      reason: "A goal needs a name",
    });
  });

  it("trims a name that would not fit on the bar", () => {
    const made = makeGoal(["x".repeat(200), "10", "manual", "channel"], "id-1");
    expect(made.ok && made.goal.label).toHaveLength(MAX_GOAL_LABEL);
  });

  it("refuses a target that is not a whole number above zero", () => {
    for (const target of ["0", "-5", "2.5", "lots", ""]) {
      expect(makeGoal(["Reps", target, "manual", "channel"], "id-1").ok).toBe(false);
    }
  });

  it("refuses a source and a scope it does not have", () => {
    expect(makeGoal(["Reps", "10", "vibes", "channel"], "id-1").ok).toBe(false);
    expect(makeGoal(["Reps", "10", "manual", "forever"], "id-1").ok).toBe(false);
  });

  it("keeps the scene she picked, and blank when she picked none", () => {
    expect(makeGoal([...args, "Celebration"], "id-1")).toMatchObject({
      goal: { scene: "Celebration" },
    });
    expect(makeGoal(args, "id-1")).toMatchObject({ goal: { scene: "" } });
  });
});

describe("telling two lists apart", () => {
  it("sees a count moving, a completion landing and a stream turning over", () => {
    const before = [goal({ current: 940 })];
    expect(sameGoals(before, [goal({ current: 940 })])).toBe(true);
    expect(sameGoals(before, [goal({ current: 941 })])).toBe(false);
    expect(sameGoals(before, [goal({ current: 940, completedAt: 1 })])).toBe(false);
    expect(sameGoals(before, [goal({ current: 940, streamKey: "vid-1" })])).toBe(false);
    expect(sameGoals(before, [])).toBe(false);
    expect(sameGoals(before, [goal({ id: "g2", current: 940 })])).toBe(false);
  });
});
