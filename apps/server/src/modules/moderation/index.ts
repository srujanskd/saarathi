import { randomUUID } from "node:crypto";
import {
  FLOOD_WINDOW_MS,
  MAX_FLAGS,
  MOD_RULES,
  MODERATION_ID,
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
  type Compiled,
} from "./rules.js";

type ModContext = ModuleContext<ModerationState>;

/**
 * The moderation layer: what her chat sent that she ought to look at.
 *
 * It watches and it queues, and in this form it writes nothing back to the
 * platform -- deleting a message and banning an account need a Google sign-in
 * that does not exist yet, and the detection half is the half she can have
 * without one. That split is deliberate rather than partial work: a queue she
 * can see from her phone is useful on its own with YouTube Studio open in the
 * next tab, and it means every rule in here was proven against mock chat before
 * anything acquired the power to delete.
 *
 * A module and not a core service, and that was the design question worth
 * getting right. Nothing here needs a hook in the pipeline: `chat-message` is
 * already a normalized event carrying `isMod` and `isStreamer`, so this
 * subscribes like any game and the core learns nothing about moderation. When
 * the write path lands it arrives as an adapter capability, not as a branch in
 * the kernel.
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
  },

  // Her rules are hers. The queue is durable too, which is the less obvious
  // half: a flag is something she has not dealt with yet, and a server that
  // restarts mid-stream -- which is the moment a crash is most likely and least
  // convenient -- may not be the thing that decides she does not need to see a
  // scam link any more.
  persist: ["rules", "flags"],

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
    const current = (): Compiled => {
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
function watch(ctx: ModContext, event: StreamEvent, rules: Compiled): void {
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
    // Absent on mock chat and on anything that is not a live chat message, and
    // that is the honest answer rather than a placeholder: it is the handle a
    // delete will need, and inventing one would make an un-actionable row look
    // actionable.
    messageId: event.messageId ?? null,
  };

  ctx.setState({
    ...patch,
    caught: ctx.state.caught + 1,
    flags: [flag, ...ctx.state.flags].slice(0, MAX_FLAGS),
  });

  ctx.log.info(
    `moderation: ${MOD_RULES[hit.kind].label} — ${event.author.name}: ${hit.reason}`,
  );

  // Her overlay draws nothing for this and her chat hears nothing about it. A
  // bot line saying a message was flagged tells the scammer which rule caught
  // them, and tells everyone else that a message they cannot see was removed.
  ctx.effect({ name: "flagged", payload: { kind: hit.kind, reason: hit.reason } });
}

function sameRules(a: ModerationState["rules"], b: ModerationState["rules"]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index]!;
    return left.kind === right.kind && left.enabled === right.enabled && left.value === right.value;
  });
}
