import {
  ACTIVE_WINDOW_MS,
  BOARD_SIZE,
  DEFAULT_PER_MINUTE,
  EARN_TICK_MS,
  GAINS,
  GAINS_ID,
  MAX_ROSTER,
  type GameModuleDef,
  type GainsState,
  type ModuleContext,
} from "@saarathi/shared";
import {
  buildBoard,
  earners,
  evict,
  makeGift,
  makeRate,
  noteSeen,
  rollStreak,
  sameBoard,
  streakBonus,
  type Roster,
} from "./rules.js";

type GainsContext = ModuleContext<GainsState>;

/**
 * Earning: chat is paid for turning up, and the board says who has the most.
 *
 * The ledger was spendable and unearnable before this -- the gate debited a
 * balance nothing ever credited -- so this is the other half of a currency that
 * already existed. It stays a module rather than growing into the ledger,
 * because who is active, what a streak is worth and how many rows fit over her
 * camera are one game's rules, and the ledger is a core service every module
 * shares.
 *
 * The roster is server-only. It is her chat's names and it grows with the
 * channel, and no page needs it: pages draw the board, which is ten rows.
 */
export const gains: GameModuleDef<GainsState> = {
  id: GAINS_ID,
  title: `Earning ${GAINS.plural}`,

  initialState: {
    roster: {},
    board: [],
    perMinute: DEFAULT_PER_MINUTE,
    streamKey: null,
    priorStreamKey: null,
  },

  // The board is not here on purpose: it is derived from the roster and the
  // ledger, both of which are durable, so it is rebuilt on the way up rather
  // than saved and trusted. A saved board would be the one thing on the overlay
  // that could disagree with a balance.
  persist: ["roster", "perMinute", "streamKey", "priorStreamKey"],

  serverOnly: ["roster", "streamKey", "priorStreamKey"],

  actions: {
    give: {
      label: `Give ${GAINS.plural}`,
      // A viewer and an amount, so no grid offers it blind. Her card knows who
      // is on the board, which is the only place the viewer id comes from.
      needsArgs: true,
      run(input, ctx) {
        const gift = makeGift(input.args);
        if (!gift.ok) return ctx.refuse(gift.reason);
        const account = ctx.state.roster[gift.id];
        if (!account) return ctx.refuse("Nobody here by that name");

        if (gift.amount > 0) {
          ctx.gains.grant(gift.id, gift.amount, `from her`);
        } else if (!ctx.gains.spend(gift.id, -gift.amount, `taken back`)) {
          // No partial debits anywhere in the ledger, so say so rather than
          // taking what there is and leaving her thinking it all went.
          return ctx.refuse(
            `${account.name} only has ${ctx.gains.balance(gift.id)} ${GAINS.plural}`,
          );
        }
        publish(ctx);
      },
    },

    rate: {
      label: "Set the earn rate",
      needsArgs: true,
      run(input, ctx) {
        const rate = makeRate(input.args);
        if (!rate.ok) return ctx.refuse(rate.reason);
        ctx.setState({ perMinute: rate.perMinute });
      },
    },

    clear: {
      label: "Start the board again",
      /**
       * The way out of the whole economy, and the reason earning is not a
       * one-way door. It zeroes what it can see -- everyone still on the
       * roster -- and the board empties with them, because nobody at zero is
       * listed. Someone evicted months ago keeps a balance nothing here can
       * reach, which is the honest trade for a roster that does not grow
       * forever.
       *
       * The roster itself stays. A streak is attendance, not a balance: she is
       * resetting an economy that got away from her, and taking six weeks of
       * turning up off everyone in chat is not something the button says it
       * does and not something she could give back.
       */
      run(_input, ctx) {
        for (const id of Object.keys(ctx.state.roster)) {
          ctx.gains.spend(id, ctx.gains.balance(id), "board cleared");
        }
        publish(ctx);
      },
    },
  },

  setup(ctx) {
    // The board is transient, so it is empty on the way up and the ledger is
    // what refills it. Written only when it is not already right, which on a
    // fresh install is never: a module that patches on the way up hands every
    // client that connected in that moment a message saying nothing.
    publish(ctx);

    // A stream boundary arrives on a poll, not on the bus -- a count landing is
    // not something that happened. See `StatsView`.
    ctx.stats.onChange(() => noteStream(ctx));
    noteStream(ctx);

    // Both, because a command is a message: someone who only ever types !spin
    // is watching, and paying only the people who make small talk is a rule
    // nobody would choose on purpose.
    for (const type of ["chat-message", "chat-command"] as const) {
      ctx.on(type, (event) => noteMessage(ctx, event.author.id, event.author.name, event.at));
    }

    ctx.every(EARN_TICK_MS, () => pay(ctx));
  },
};

/**
 * Which stream is running now.
 *
 * An absent token is not a new stream, exactly as it is not for a goal: it means
 * the adapter is not on one, or YouTube did not answer this minute, and treating
 * that as a boundary would break every streak in chat on a Wi-Fi hiccup.
 */
function noteStream(ctx: GainsContext): void {
  const stream = ctx.stats.stream();
  if (stream === undefined || stream === ctx.state.streamKey) return;
  ctx.setState({ streamKey: stream, priorStreamKey: ctx.state.streamKey });
}

/**
 * Someone spoke: they are active from now, and if this is their first line of
 * the stream their streak rolls and pays.
 *
 * Rolling here rather than on the boundary is what makes it survive anything.
 * The boundary is a moment the server may not have been running for -- she
 * restarts between streams -- and a streak that had to be present for it would
 * be a streak that resets when her PC does.
 */
function noteMessage(ctx: GainsContext, id: string, name: string, at: number): void {
  const stream = ctx.state.streamKey;
  const existing = ctx.state.roster[id];
  let account = noteSeen(existing, name, at);

  const first = stream !== null && account.lastStreamKey !== stream;
  if (first) {
    account = rollStreak(account, stream, ctx.state.priorStreamKey);
    const bonus = streakBonus(account.streak, ctx.state.perMinute);
    if (bonus > 0) ctx.gains.grant(id, bonus, `${account.streak} streams in a row`);
  }

  const roster: Roster = evict({ ...ctx.state.roster, [id]: account }, MAX_ROSTER);
  ctx.setState({ roster });
  // Only when something a client can see moved. An ordinary message changes a
  // timestamp nobody is shown; a streak rolling changes a row on the overlay.
  if (first) publish(ctx);
}

/** The minute's wages, to everyone who has spoken inside the window. */
function pay(ctx: GainsContext): void {
  const perMinute = ctx.state.perMinute;
  if (perMinute > 0) {
    const now = Date.now();
    for (const id of earners(ctx.state.roster, now, ACTIVE_WINDOW_MS)) {
      ctx.gains.grant(id, perMinute, "active minute");
    }
  }
  publish(ctx);
}

/** The board against the ledger as it stands, if it is not what is already up. */
function publish(ctx: GainsContext): void {
  const board = buildBoard(ctx.state.roster, (id) => ctx.gains.balance(id), BOARD_SIZE);
  if (sameBoard(ctx.state.board, board)) return;
  ctx.setState({ board });
}
