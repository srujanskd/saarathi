import {
  DEFAULT_CHALLENGES,
  MAX_CHALLENGES,
  MAX_HISTORY,
  MAX_QUEUE,
  SPIN_COOLDOWN_MS,
  WHEEL_ID,
  type Cancel,
  type GameModuleDef,
  type ModuleContext,
  type TriggerVia,
  type WheelState,
} from "@saarathi/shared";
import { planSpin, spinBlockedFor } from "./rules.js";

/**
 * Triggers that cost the viewer something. These wait their turn when the wheel
 * is busy; free triggers are refused outright, because a free spin that
 * silently arrives forty seconds later is worse than one that says no now.
 */
const QUEUEABLE = new Set<TriggerVia>(["paid", "gains"]);

type WheelContext = ModuleContext<WheelState>;

/**
 * Handles for the pending drain timer, one per module context. It lives outside
 * the state slice because it is a timer, not data: nothing renders it and
 * nothing should persist it. The queue it drains is in state, so a restart
 * picks up where this left off.
 *
 * Keyed by context rather than held in a single variable because a process can
 * run more than one kernel -- a test suite does it constantly -- and two wheels
 * sharing one timer handle means one of them cancels the other's drain.
 */
const pendingDrains = new WeakMap<WheelContext, Cancel>();

/**
 * Run the next paid spin as soon as the wheel can take it. Re-entrant on
 * purpose: it works out its own wait and reschedules itself, so every caller
 * just says "drain" without knowing how long the current spin has left.
 */
function drain(ctx: WheelContext): void {
  pendingDrains.get(ctx)?.();
  pendingDrains.delete(ctx);

  const next = ctx.state.queue[0];
  if (!next) return;

  // Nothing to spin. Leave the queue alone; setChallenges drains again once
  // there is something on the wheel, so nobody's money is dropped.
  if (ctx.state.challenges.length === 0) return;

  const wait = spinBlockedFor(ctx.state.spin, Date.now());
  if (wait > 0) {
    pendingDrains.set(ctx, ctx.after(wait, () => drain(ctx)));
    return;
  }

  ctx.setState((state) => ({ queue: state.queue.slice(1) }));
  void ctx.invoke("spin", { by: next.by, via: next.via });
}

/**
 * The challenge wheel: the first game module, and not a special case. Every
 * trigger she has -- !spin in chat, a Super Chat or a tip, her deck, her
 * control page -- lands in the same `spin` action below. There is no second
 * path to keep in sync.
 */
export const wheel: GameModuleDef<WheelState> = {
  id: WHEEL_ID,
  title: "Challenge wheel",

  initialState: {
    challenges: [...DEFAULT_CHALLENGES],
    spin: null,
    queue: [],
    history: [],
  },

  // Her challenge list, what chat has already made her do, and anything paid
  // for but not yet run are hers to keep. The spin in flight is not: a restart
  // should never leave a stale wheel mid-rotation on the overlay.
  persist: ["challenges", "queue", "history"],

  commands: [
    {
      name: "spin",
      action: "spin",
      cooldownMs: SPIN_COOLDOWN_MS,
      allow: "everyone",
      help: "Spin the wheel for a random challenge",
    },
  ],

  actions: {
    spin: {
      label: "Spin the wheel",
      run(input, ctx) {
        const outcome = planSpin(ctx.state, {
          by: input.by,
          via: input.via,
          now: Date.now(),
          random: Math.random,
        });

        if (!outcome.ok) {
          if (!QUEUEABLE.has(input.via)) return ctx.refuse(outcome.reason);
          if (ctx.state.queue.length >= MAX_QUEUE) {
            return ctx.refuse(`${outcome.reason}, and the queue is full`);
          }

          const position = ctx.state.queue.length + 1;
          ctx.setState((state) => ({
            queue: [...state.queue, { by: input.by, via: input.via, at: Date.now() }],
          }));
          ctx.effect({ name: "spin-queued", payload: { by: input.by, position } });
          ctx.log.info(`wheel: queued a ${input.via} spin for ${input.by} (#${position})`);
          drain(ctx);
          return;
        }

        ctx.setState((state) => ({
          spin: outcome.spin,
          history: [
            {
              label: outcome.spin.label,
              by: outcome.spin.by,
              via: outcome.spin.via,
              at: outcome.spin.startedAt,
            },
            ...state.history,
          ].slice(0, MAX_HISTORY),
        }));

        ctx.effect({ name: "spin-started", payload: { label: outcome.spin.label } });
        ctx.log.info(`wheel: ${outcome.spin.label} for ${input.by} (${input.via})`);
        drain(ctx);
      },
    },

    cancel: {
      label: "Clear the wheel",
      run(_input, ctx) {
        if (!ctx.state.spin) return ctx.refuse("Nothing is on the wheel right now");
        ctx.setState({ spin: null });
        drain(ctx);
      },
    },

    clearQueue: {
      label: "Drop queued spins",
      run(_input, ctx) {
        if (ctx.state.queue.length === 0) return ctx.refuse("Nothing is queued");
        const dropped = ctx.state.queue.length;
        ctx.setState({ queue: [] });
        ctx.log.info(`wheel: she dropped ${dropped} queued spin(s)`);
      },
    },

    setChallenges: {
      label: "Save challenges",
      hidden: true,
      // The cap is enforced on the write and nowhere else, so a list already
      // over it in her state file keeps loading and spinning; only her next
      // save is refused. Clamping on load would want a per-module hydrate hook
      // in the core, and a wheel-shaped hook is the thing the module contract
      // says to fix elsewhere. Her control page flags an over-cap list on
      // sight, so it is visible without one.
      run(input, ctx) {
        const challenges = input.args.map((line) => line.trim()).filter(Boolean);
        if (challenges.length === 0) return ctx.refuse("A wheel needs at least one challenge");
        if (challenges.length > MAX_CHALLENGES) {
          return ctx.refuse(
            `A wheel holds ${MAX_CHALLENGES} challenges — that list has ${challenges.length}`,
          );
        }
        ctx.setState({ challenges });
        drain(ctx);
      },
    },
  },

  setup(ctx) {
    // Money buys a spin outright: it skips the chat cooldown because the
    // cooldown lives on the !spin binding, not on the action.
    ctx.on("paid-event", (event) => {
      void ctx.invoke("spin", { by: event.author.name, via: "paid", event });
    });

    // Anything paid for before the last shutdown still owes her a spin.
    drain(ctx);
  },

  teardown(ctx) {
    pendingDrains.get(ctx)?.();
    pendingDrains.delete(ctx);
  },
};
