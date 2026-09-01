import { randomUUID } from "node:crypto";
import {
  GOALS_ID,
  GOAL_SOURCES,
  MAX_GOALS,
  isPolled,
  type GameModuleDef,
  type Goal,
  type GoalsState,
  type ModuleContext,
} from "@saarathi/shared";
import {
  makeGoal,
  pollGoal,
  resetGoal,
  sameGoals,
  tallyGoal,
  type Reading,
} from "./rules.js";

type GoalsContext = ModuleContext<GoalsState>;

/**
 * Her goals: a subscriber goal, a like goal, and anything else worth a bar.
 *
 * The second module, and the first one that reads a core service it does not
 * own. Two of its sources are polled through `ctx.stats` and the rest arrive on
 * the event bus, and nothing in here knows that one of those numbers came from
 * YouTube -- the whole point of the adapter seam.
 *
 * Completion is decided here and nowhere else. The server is authoritative, the
 * stamp is persisted, and an overlay works out what to draw from it, so a
 * browser source reloading mid-celebration rejoins the celebration instead of
 * starting a second one.
 */
export const goals: GameModuleDef<GoalsState> = {
  id: GOALS_ID,
  title: "Goals",

  initialState: { goals: [] },

  // Her goals are hers to keep, and so is the fact that one of them has already
  // landed: that stamp is the entire reason a completion fires once rather than
  // once per restart.
  persist: ["goals"],

  actions: {
    add: {
      label: "Add a goal",
      // Five arguments, so no grid offers it: her goals card is the surface
      // that knows what to pass, exactly as the challenge editor is.
      needsArgs: true,
      run(input, ctx) {
        if (ctx.state.goals.length >= MAX_GOALS) {
          return ctx.refuse(`That is ${MAX_GOALS} goals already — remove one first`);
        }
        const made = makeGoal(input.args, randomUUID());
        if (!made.ok) return ctx.refuse(made.reason);
        ctx.setState((state) => ({ goals: [...state.goals, made.goal] }));
        // Straight away, so a goal she adds mid-stream has its number on it
        // rather than an empty bar until the next poll a minute from now.
        refresh(ctx);
      },
    },

    remove: {
      label: "Remove a goal",
      needsArgs: true,
      run(input, ctx) {
        const id = input.args[0] ?? "";
        if (!ctx.state.goals.some((goal) => goal.id === id)) return ctx.refuse("That goal is gone");
        ctx.setState((state) => ({ goals: state.goals.filter((goal) => goal.id !== id) }));
      },
    },

    bump: {
      label: "Count one",
      // The id, so this is the one action here she puts on her deck: her goals
      // card writes the button, the way the OBS card writes a scene button.
      needsArgs: true,
      run(input, ctx) {
        const goal = find(ctx, input.args[0] ?? "");
        if (!goal) return ctx.refuse("That goal is gone");
        if (isPolled(goal.source)) {
          return ctx.refuse(`${goal.label} counts itself`);
        }
        const amount = Number(input.args[1] ?? "1");
        if (!Number.isInteger(amount) || amount === 0) {
          return ctx.refuse("Count one, a few, or a negative few to take some back");
        }
        commit(ctx, replace(ctx, tallyGoal(goal, amount, Date.now())));
      },
    },

    reset: {
      label: "Start a goal again",
      needsArgs: true,
      run(input, ctx) {
        const goal = find(ctx, input.args[0] ?? "");
        if (!goal) return ctx.refuse("That goal is gone");
        // Reset and re-read in one step, and deliberately not through
        // `commit`: this is the way back out of a completion, and a reset that
        // re-fired the alert on its way past the target would be a one-way
        // door with extra steps. Doing it in two -- clear the stamp, then let
        // the next poll land on it -- is exactly how that used to happen: a
        // subscriber count is still over the target a millisecond after she
        // taps, so it re-stamped and fired everything on the tap meant to
        // clear it.
        const cleared = resetGoal(goal, ctx.stats.stream());
        const settled = pollGoal(cleared, reading(ctx, cleared, Date.now()));

        // Still over its target on the counts as they stand, so there is no
        // starting it again and saying so is better than a button that looks
        // like it worked. A stream goal gets its restart from the next stream,
        // and a channel goal wants a bigger number.
        if (settled.completedAt !== null) {
          return ctx.refuse(`${goal.label} is already past ${goal.target}, so it lands again`);
        }
        ctx.setState({ goals: replace(ctx, settled) });
      },
    },
  },

  setup(ctx) {
    // A polled number from last week is worse than no number: it is wrong and
    // it looks right. The first poll is a second away, and until it lands these
    // bars say they do not know yet.
    //
    // Written only when it changes something, which on a fresh install and on
    // most restarts is never. A module that patches on the way up hands every
    // client that connected in that first moment a message that says nothing.
    const forgotten = ctx.state.goals.map((goal) =>
      !isPolled(goal.source) || goal.current === null
        ? goal
        : { ...goal, current: null },
    );
    if (!sameGoals(ctx.state.goals, forgotten)) ctx.setState({ goals: forgotten });

    ctx.stats.onChange(() => refresh(ctx));

    // The sources that are counted as things happen rather than asked for.
    // Read off the one table both ends share, so a new one is an entry there
    // and not a branch here.
    for (const [source, info] of Object.entries(GOAL_SOURCES)) {
      if (!info.event) continue;
      ctx.on(info.event, () => {
        const now = Date.now();
        commit(
          ctx,
          ctx.state.goals.map((goal) =>
            goal.source === source ? tallyGoal(goal, 1, now) : goal,
          ),
        );
      });
    }
  },
};

/** Every goal against the counts as they stand right now. */
function refresh(ctx: GoalsContext): void {
  const now = Date.now();
  commit(
    ctx,
    ctx.state.goals.map((goal) => pollGoal(goal, reading(ctx, goal, now))),
  );
}

/**
 * What the counts say about one goal at this moment.
 *
 * One place, because a reset re-reads the same counts a poll does and the two
 * disagreeing about which adapter to ask is a goal that reads one number on
 * the overlay and another on her phone.
 */
function reading(ctx: GoalsContext, goal: Goal, now: number): Reading {
  const counts = GOAL_SOURCES[goal.source].count;
  return {
    count: counts === undefined ? undefined : ctx.stats.count(counts),
    stream: ctx.stats.stream(),
    now,
  };
}

/**
 * The new list, and an alert for anything that just landed.
 *
 * The one place a completion is noticed, so every path into a number -- a poll,
 * a member joining, her thumb on a deck button -- fires the same alert once and
 * only once. Nothing is written when nothing moved: most polls change nothing,
 * and a patch a minute that says the same thing is her phone's data plan.
 */
function commit(ctx: GoalsContext, next: Goal[]): void {
  const before = ctx.state.goals;
  if (sameGoals(before, next)) return;
  ctx.setState({ goals: next });

  for (const goal of next) {
    const was = before.find((earlier) => earlier.id === goal.id);
    if (goal.completedAt === null || was?.completedAt !== null) continue;
    land(ctx, goal);
  }
}

function land(ctx: GoalsContext, goal: Goal): void {
  ctx.log.info(`goals: ${goal.label} landed at ${goal.current}/${goal.target}`);
  // The overlay draws the celebration and plays the chime off this. Her chat
  // hears nothing: an alert on her own screen is hers to see, and a bot line
  // in a live chat is the one consequence here that cannot be taken back.
  ctx.effect({ name: "goal-complete", payload: { id: goal.id, label: goal.label } });

  // Optional, and it stays optional: OBS may be shut, and a goal landing is not
  // a reason to throw in the middle of a chat event.
  if (!goal.scene || !ctx.obs.connected) return;
  void ctx.obs
    .setScene(goal.scene)
    .catch((err: unknown) => ctx.log.warn(`goals: could not cut to ${goal.scene}`, err));
}

function find(ctx: GoalsContext, id: string): Goal | undefined {
  return ctx.state.goals.find((goal) => goal.id === id);
}

/** The list with one goal swapped, in place, because order is hers. */
function replace(ctx: GoalsContext, goal: Goal): Goal[] {
  return ctx.state.goals.map((earlier) => (earlier.id === goal.id ? goal : earlier));
}
