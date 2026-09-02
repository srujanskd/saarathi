import { randomUUID } from "node:crypto";
import {
  FLOOD_WINDOW_MS,
  LOCKDOWN_MS,
  MAX_FLAGS,
  MOD_RULES,
  MODERATION_ID,
  NO_WRITER,
  type GameModuleDef,
  type ModFlag,
  type ModerationState,
  type ModuleContext,
  type StreamEvent,
} from "@saarathi/shared";
import {
  compileRules,
  defaultRules,
  exempt,
  forgetIdle,
  inspect,
  makeRule,
  noteMessage,
  readRules,
  trimText,
  type CompiledRules,
} from "./rules.js";

type ModContext = ModuleContext<ModerationState>;

/**
 * The moderation layer: what her chat sent that she ought to look at.
 *
 * It watches, it queues, and now it acts: a row in the queue can be taken down
 * or its author banned, a wave can be swept in one press, and lockdown removes
 * what the rules catch as it arrives instead of asking her to tap forty times.
 * Every one of those is `ctx.writes`, which is a core service and an adapter
 * capability -- so this module gained the power to delete without the kernel
 * learning that moderation exists, and the detection half still works exactly
 * as it did on a build with nothing signed in.
 *
 * That is the shape the whole feature is built on rather than a nicety. What
 * she can do here is whatever the adapter can do right now, read at the moment
 * she presses: a queue on a machine with no grant renders the rows and tells
 * her to use the live dashboard, and the same queue five seconds after she
 * signs in renders buttons. Nothing has to be restarted and nothing is stored
 * about which of those two worlds we are in.
 *
 * A module and not a core service, and that was the design question worth
 * getting right. Nothing here needs a hook in the pipeline: `chat-message` is
 * already a normalized event carrying `isMod` and `isStreamer`, so this
 * subscribes like any game and the core learns nothing about moderation.
 */
export const moderation: GameModuleDef<ModerationState> = {
  id: MODERATION_ID,
  title: "Moderation",

  initialState: {
    rules: defaultRules(),
    flags: [],
    seen: 0,
    caught: 0,
    floods: {},
    lockdownUntil: null,
    removed: 0,
    purge: null,
  },

  // Her rules are hers. The queue is durable too, which is the less obvious
  // half: a flag is something she has not dealt with yet, and a server that
  // restarts mid-stream -- which is the moment a crash is most likely and least
  // convenient -- may not be the thing that decides she does not need to see a
  // scam link any more.
  persist: ["rules", "flags", "lockdownUntil"],

  // The flood history is her chat's names, keyed by viewer and growing with the
  // channel, and no page draws it: pages draw the queue. Same call as the gains
  // roster, and the same reason.
  serverOnly: ["floods"],

  actions: {
    setRule: {
      label: "Change a rule",
      // A kind, a switch and a value, so no grid offers it as a button: her
      // moderation card is the surface that knows what to pass, exactly as the
      // goals card is for a goal.
      needsArgs: true,
      run(input, ctx) {
        const edit = makeRule(input.args);
        if (!edit.ok) return ctx.refuse(edit.reason);
        ctx.setState((state) => ({
          rules: state.rules.map((rule) => (rule.kind === edit.rule.kind ? edit.rule : rule)),
        }));
      },
    },

    resetRules: {
      label: "Put the rules back",
      // The way out of a set of rules she has tangled, and the reason it takes
      // no arguments: it is the one action here worth a deck button, because
      // the moment she wants it is the moment the queue is filling with her own
      // regulars and she is not going to edit seven rules one-handed.
      run(_input, ctx) {
        ctx.setState({ rules: defaultRules() });
      },
    },

    dismiss: {
      label: "Leave it",
      needsArgs: true,
      run(input, ctx) {
        const id = input.args[0] ?? "";
        if (!ctx.state.flags.some((flag) => flag.id === id)) return ctx.refuse("That one is gone");
        ctx.setState((state) => ({ flags: state.flags.filter((flag) => flag.id !== id) }));
      },
    },

    clear: {
      label: "Clear the queue",
      run(_input, ctx) {
        if (ctx.state.flags.length === 0) return ctx.refuse("Nothing in the queue");
        ctx.setState({ flags: [] });
      },
    },

    remove: {
      label: "Take it down",
      needsArgs: true,
      async run(input, ctx) {
        const flag = flagOrRefuse(ctx, input.args[0] ?? "");
        // Never offered without one -- her card renders a row with no id as a
        // row with no button -- so reaching here means a deck button she made
        // for a specific flag, weeks ago, that is not that flag any more.
        if (flag.messageId === null) {
          return ctx.refuse("This one came from somewhere with no message to take down");
        }
        const done = await ctx.writes.removeMessage(flag.messageId);
        // The row stays put on a refusal, which is the whole reason this
        // answers: she can read why on the card and press it again.
        if (!done.ok) return ctx.refuse(done.reason);
        keepOnly(ctx, (other) => other.id !== flag.id);
        ctx.setState((state) => ({ removed: state.removed + 1 }));
      },
    },

    ban: {
      label: "Ban them",
      needsArgs: true,
      async run(input, ctx) {
        const flag = flagOrRefuse(ctx, input.args[0] ?? "");
        const done = await ctx.writes.banAuthor(flag.authorId);
        if (!done.ok) return ctx.refuse(done.reason);
        // Every row of theirs, not the one she happened to press. A banned
        // account's other four messages are not four more decisions, and
        // leaving them there is the queue asking her the same question again.
        keepOnly(ctx, (other) => other.authorId !== flag.authorId);
      },
    },

    purge: {
      label: "Sweep the queue",
      /**
       * The panic button, and the reason it takes no arguments: the moment she
       * wants it is a wave arriving faster than she can read it, and that is
       * not a moment for choosing rows. It is on the deck for the same reason.
       *
       * Awaited rather than started and reported on later, one message at a
       * time. She is watching a card with everything disabled while it runs,
       * which is honest about what is happening and cannot leave her a
       * half-swept queue to reason about; the queue is capped, so the worst
       * case is bounded, and a real wave is a dozen rows rather than fifty.
       */
      async run(_input, ctx) {
        const flags = ctx.state.flags;
        if (flags.length === 0) return ctx.refuse("Nothing in the queue");

        const actionable = flags.filter((flag) => flag.messageId !== null);
        if (actionable.length === 0) {
          return ctx.refuse("None of these came with a message to take down");
        }

        const gone = new Set<string>();
        let refusal = "";
        for (const flag of actionable) {
          const done = await ctx.writes.removeMessage(flag.messageId!);
          if (done.ok) {
            gone.add(flag.id);
            continue;
          }
          // Stops on the first refusal rather than working through forty of
          // them: whatever it is -- a revoked grant, a spent quota -- is going
          // to be just as true for the next thirty-nine, and spending them
          // finding that out is the one thing the reserve exists to prevent.
          refusal = done.reason;
          break;
        }

        ctx.setState((state) => ({
          flags: state.flags.filter((flag) => !gone.has(flag.id)),
          removed: state.removed + gone.size,
          purge: {
            at: Date.now(),
            removed: gone.size,
            // Both counts off `flags` and `actionable` -- the queue as it stood
            // when she pressed -- rather than off `state.flags` in here, which
            // is the queue as it stands several awaits later. A message that
            // arrived mid-sweep is in neither count: it was never this sweep's
            // to remove, and reading it as one of these would tell her a row
            // she has not seen yet had no message or could not be removed.
            noId: flags.length - actionable.length,
            stopped: actionable.length - gone.size,
          },
        }));

        // Refused after the report is written, so the count she can see and the
        // sentence explaining it arrive together.
        if (refusal) return ctx.refuse(refusal);
      },
    },

    lockdown: {
      label: "Lockdown",
      run(_input, ctx) {
        // Checked here as well as rendered on her card, because her card is
        // not the only way in: a deck button she made while signed in, pressed
        // after the grant went away, would otherwise flip a switch that
        // changes nothing at all. The sentence is the core's, so there is one
        // of it. See `NO_WRITER`.
        if (!ctx.writes.available) return ctx.refuse(NO_WRITER);
        // Pressed again while it is on, this pushes the end out rather than
        // refusing: a wave that outlasts the window is a second press, which
        // is the one thing she can do one-handed.
        ctx.setState({ lockdownUntil: Date.now() + LOCKDOWN_MS });
      },
    },

    lockdownOff: {
      label: "End lockdown",
      /**
       * The way out, and its own action rather than a toggle on the one above.
       * A deck button says what it does on its face and nothing else -- a
       * button that means "on" half the time is a button she presses to stop a
       * raid and starts one with. Her card renders the pair as one switch,
       * because a card can show which way it is currently set and a key cannot.
       */
      run(_input, ctx) {
        if (!lockedDown(ctx.state, Date.now())) return ctx.refuse("Lockdown is not on");
        ctx.setState({ lockdownUntil: null });
      },
    },
  },

  setup(ctx) {
    // Reconciled on the way up, not on every save: a build that adds a rule
    // kind has to hand her one, and a build that drops one may not leave
    // something behind that nothing can evaluate. Written only when it changed
    // something, which on most restarts is never -- a module that patches on
    // the way up hands every client that connected in that first moment a
    // message saying nothing.
    const rules = readRules(ctx.state.rules);
    if (!sameRules(rules, ctx.state.rules)) ctx.setState({ rules });

    // Compiled from whatever the rules are now, and again whenever they change.
    // Recompiling per message would put a regex build on her chat's busiest
    // minute; this way a pattern is compiled when she saves it and never again.
    // Off `ctx.state` rather than off `rules`, so the identity check below
    // starts out matching whichever of the two branches above just ran.
    let lastRules = ctx.state.rules;
    let compiled = compileRules(lastRules);
    const current = (): CompiledRules => {
      if (ctx.state.rules !== lastRules) {
        lastRules = ctx.state.rules;
        compiled = compileRules(lastRules);
      }
      return compiled;
    };

    // A command is a message. Someone pasting a scam link with a "!" in front
    // of it is not exempt from the link rule, and the kernel has already
    // promoted it to a chat-command by the time it reaches here.
    for (const type of ["chat-message", "chat-command"] as const) {
      ctx.on(type, (event) => watch(ctx, event, current()));
    }

    // Nothing else needs a clock, so this is the whole cost of the flood rule's
    // memory: one pass over the authors who have gone quiet, once a window.
    ctx.every(FLOOD_WINDOW_MS, () => {
      const floods = forgetIdle(ctx.state.floods, Date.now());
      if (floods !== ctx.state.floods) ctx.setState({ floods });
    });
  },
};

/**
 * One message, against her rules.
 *
 * The counters move on every message and the queue moves on almost none, which
 * is why they are written together: `seen` is what tells her the layer is alive,
 * and it is server-only-adjacent in cost -- a patch a message is exactly what
 * her phone's data plan cannot afford in IRL mode, so the coalescing window in
 * the registry is doing real work here.
 */
function watch(ctx: ModContext, event: StreamEvent, rules: CompiledRules): void {
  if (event.type !== "chat-message" && event.type !== "chat-command") return;

  // Her own line and her mods' lines are counted and never judged. Counted,
  // because "is this thing even running" is answered by the total.
  const counted = noteMessage(ctx.state.floods, event.author.id, event.at);
  const patch: Partial<ModerationState> = {
    seen: ctx.state.seen + 1,
    floods: counted.history,
  };

  if (exempt(event.author)) {
    ctx.setState(patch);
    return;
  }

  const hit = inspect({ text: event.text, rules, recent: counted.recent });
  if (!hit) {
    ctx.setState(patch);
    return;
  }

  const flag: ModFlag = {
    id: randomUUID(),
    at: event.at,
    authorId: event.author.id,
    authorName: event.author.name,
    text: trimText(event.text),
    kind: hit.kind,
    reason: hit.reason,
    // Absent on anything that is not a live chat message -- a tip, a webhook
    // -- and null is the honest answer rather than a placeholder: it is the
    // handle a delete needs, and inventing one would make an un-actionable row
    // look actionable.
    messageId: event.messageId ?? null,
  };

  ctx.log.info(
    `moderation: ${MOD_RULES[hit.kind].label} — ${event.author.name}: ${hit.reason}`,
  );

  // Lockdown is the queue's fast path, not a second rule engine: the same
  // rules caught the same message, and the only difference is that it goes
  // rather than waits. Both of the other conditions are the honest fallback
  // -- a message with no id and a machine with nothing signed in cannot be
  // acted on, and a wave of rows she can still see beats a wave that
  // silently did nothing.
  if (lockedDown(ctx.state, event.at) && flag.messageId !== null && ctx.writes.available) {
    // Counted as caught now and counted as removed only if it goes. The
    // decision to queue or not has to be made here, synchronously, so the
    // write is fired and the result puts the row back if it failed.
    ctx.setState({ ...patch, caught: ctx.state.caught + 1 });
    const messageId = flag.messageId;
    void ctx.writes.removeMessage(messageId).then((done) => {
      if (done.ok) {
        ctx.setState((state) => ({ removed: state.removed + 1 }));
        return;
      }
      // Nothing is lost to a failed write: it lands in the queue it would
      // have gone to anyway, and she deals with it by hand.
      ctx.setState((state) => ({ flags: [flag, ...state.flags].slice(0, MAX_FLAGS) }));
      ctx.log.warn(`moderation: lockdown could not remove ${flag.authorName}'s message`);
    });
    return;
  }

  ctx.setState({
    ...patch,
    caught: ctx.state.caught + 1,
    flags: [flag, ...ctx.state.flags].slice(0, MAX_FLAGS),
  });
}

/**
 * Whether lockdown is on, which is a question about the clock rather than a
 * flag.
 *
 * There is no timer that switches it off. A timestamp already says when it
 * ends, so a server that was restarted mid-lockdown comes back up still locked
 * down with no re-arming to do, and one restarted an hour later comes back up
 * with a value that is simply in the past. The alternative -- a boolean and a
 * timer to clear it -- is a second source of truth that has to survive a
 * restart, for a state that expires on its own.
 */
function lockedDown(state: Readonly<ModerationState>, now: number): boolean {
  return state.lockdownUntil !== null && state.lockdownUntil > now;
}

/**
 * The flag she pressed, refusing out of the action if it is not there any more.
 *
 * Named for the refusal rather than for the lookup, because that is the half a
 * caller has to know about: this does not return absence, it ends the action
 * through `ctx.refuse`, which the core turns into the sentence on her card.
 */
function flagOrRefuse(ctx: ModContext, id: string): ModFlag {
  const flag = ctx.state.flags.find((other) => other.id === id);
  // The same words `dismiss` refuses with, and the same cause: her card was
  // rendering a queue that has since moved on, or a deck button outlived the
  // flag it was made for.
  if (!flag) return ctx.refuse("That one is gone");
  return flag;
}

/** Narrow the queue to the rows that pass. Everything else goes. */
function keepOnly(ctx: ModContext, keep: (flag: ModFlag) => boolean): void {
  ctx.setState((state) => ({ flags: state.flags.filter(keep) }));
}

function sameRules(a: ModerationState["rules"], b: ModerationState["rules"]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index]!;
    return left.kind === right.kind && left.enabled === right.enabled && left.value === right.value;
  });
}
