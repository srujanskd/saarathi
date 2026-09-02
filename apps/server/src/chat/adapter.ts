import {
  CORE_ACTIONS,
  type ChannelStats,
  type ChatView,
  type ConnectionStatus,
  type InvokeResult,
  type StreamEvent,
} from "@saarathi/shared";

/**
 * The one seam every platform crosses. An adapter turns whatever its platform
 * sends into normalized events and pushes them at the sink. Everything past
 * this file -- modules, triggers, overlays -- is platform-agnostic, so a Twitch
 * adapter or a Ko-fi tips webhook is a new file here and nothing else.
 */
export interface ChatSink {
  event(event: StreamEvent): void;
  /** Written for her: "No live stream found, retrying every 60s". */
  status(status: ConnectionStatus): void;
  /**
   * Something in this adapter's `settings` view changed on its own.
   *
   * Every other change to that view is the result of an action she invoked, and
   * the core republishes the slice on the way back out of one. A sign-in is the
   * exception: she presses a button, the answer comes back at once with a code
   * on it, and then the *interesting* change -- Google saying yes, the code
   * running out -- happens minutes later with no action in flight to hang it
   * on. So the adapter says so, and every page she has open finds out.
   *
   * Deliberately not `status`: whether chat is connected and whether the bot
   * may write are two different facts, and folding one into the other would
   * put "waiting for a code" where "reading live chat" belongs.
   */
  changed(): void;
}

export interface ChatAdapter {
  /** Also the key its connection status appears under on the status page. */
  readonly name: string;
  start(sink: ChatSink): Promise<void>;
  stop(): Promise<void>;
  /**
   * The counts this adapter can get right now, if it can get any.
   *
   * The one thing an adapter is asked rather than told. Everything else here is
   * a push -- something happened, the sink hears about it -- but a subscriber
   * count is not an event: nothing happens when it changes, there is only a
   * number that is different next time somebody looks. So the core polls, on
   * `STATS_POLL_MS`, and an adapter that has nothing to offer omits this
   * entirely rather than answering with zeroes.
   *
   * Platform-specific by definition, which is exactly why it lives behind this
   * interface and nowhere past it. A throw is a normal outcome -- her Wi-Fi,
   * an expired key, YouTube having a bad afternoon -- and is handled as one.
   */
  stats?(): Promise<ChannelStats>;
  /**
   * True for an adapter that is standing in for a real one.
   *
   * Mock chat is registered on every run, hers included, because a feature
   * nobody can demo without going live is a feature only its author can test.
   * That makes it the one adapter whose counts must never win an argument: the
   * core asks a stand-in last, so its climbing numbers show up on a goal bar
   * during development and get out of the way the moment YouTube can answer.
   */
  readonly standIn?: boolean;
  /**
   * What she can set up for this adapter, if there is anything.
   *
   * One member rather than three methods, on the shape `ObsAdapter.actions`
   * already uses: an adapter that needs no setting up omits it, and mock chat
   * -- which is always registered beside the real one -- has nothing to omit.
   */
  readonly settings?: ChatSettings;
  /**
   * What this adapter can write back to chat, if it can write anything.
   *
   * One optional member on the shape `settings` already uses, rather than three
   * loose optional methods: writing is one capability an adapter either has or
   * has not got, and the core asks that question once. An adapter may grow it
   * and lose it while running -- a grant is revoked, a token expires -- so it is
   * read at the moment of a write and never cached.
   *
   * Everything past this file still only knows `Kernel.say` and, later, a
   * moderation action. Which HTTP call a delete is, and what it costs, is
   * platform knowledge and stays here.
   */
  readonly writes?: ChatWrites;
}

/**
 * The writing half of an adapter: three calls, because three is what moderation
 * and replies between them need.
 *
 * Every one of them throws on failure rather than answering false. A write
 * failing is the normal case, not the exceptional one -- her Wi-Fi, a revoked
 * grant, a quota that ran out at 4pm -- and the caller has to tell those apart
 * from each other anyway, which is what an error carries and a boolean does not.
 * The same call `stats` makes, for the same reason.
 */
export interface ChatWrites {
  /** Post a line as her channel. Never queued: see `Kernel.say`. */
  say(text: string): Promise<void>;
  /** Delete one message, named by the platform's own id for it. */
  deleteMessage(messageId: string): Promise<void>;
  /** Ban an account from her chat, named by the author id events carry. */
  ban(authorId: string): Promise<void>;
}

/**
 * A write the platform would not do, and the one thing about it the core is
 * allowed to know.
 *
 * Every other distinction between failures stays platform knowledge and travels
 * only as the sentence on `message`: which HTTP status meant what, and which of
 * Google's dozen reason strings this was, is exactly what the adapter seam
 * exists to keep out of the core. `outOfQuota` is the exception because it is
 * the one failure the core has to *remember* rather than report -- the daily
 * allowance is gone until it resets, so the meter goes to a state rather than
 * logging one more line -- and "the platform will not write again today" is a
 * normalized fact, not a platform one.
 *
 * Not a status code and not a reason enum, deliberately: one boolean is all the
 * core acts on, and a second adapter with its own exhaustion answer sets the
 * same flag rather than teaching the core a second vocabulary.
 */
export class WriteRefused extends Error {
  constructor(
    message: string,
    readonly outOfQuota = false,
  ) {
    super(message);
    this.name = "WriteRefused";
  }
}

/**
 * Whether this is the refusal that means today's allowance is gone.
 *
 * A function rather than an `instanceof` at the call site because what arrives
 * in a `catch` is `unknown`, and because the answer for everything else -- her
 * Wi-Fi, a 500, a thrown string -- is no.
 */
export function outOfQuota(err: unknown): boolean {
  return err instanceof WriteRefused && err.outOfQuota;
}

export interface ChatSettingsInput {
  /**
   * Blank clears it, which is her way out: an adapter with no channel goes idle
   * rather than retrying against nothing. Unlike the key, this one *is* sent
   * back to her page, so a blank field is a field she emptied on purpose.
   */
  channelId: string;
  /**
   * Blank leaves the stored one alone, because it is never sent to a client to
   * prefill the field with. Forgetting it is its own button, exactly as it is
   * for the OBS password.
   */
  apiKey: string;
}

/**
 * The half of an adapter her control page talks to. Every string in it is the
 * adapter's own words: what a channel id looks like and where she finds one is
 * platform knowledge, and the point of this seam is that nothing past it has to
 * hold any.
 */
export interface ChatSettings {
  view(): ChatView;
  save(input: ChatSettingsInput): Promise<InvokeResult>;
  forgetKey(): Promise<InvokeResult>;
  /**
   * Start signing the bot in, for a platform where writing needs one.
   *
   * Here rather than on a core surface of its own, and that was the design
   * question worth getting right: *how* you authorize a write is platform
   * knowledge. Google wants a device code typed into a browser; Twitch wants
   * something else; a tips webhook wants nothing at all. A core-level auth
   * surface would have been in the wrong place the day the second adapter
   * landed, and it would have had to grow a shape wide enough for both.
   *
   * Optional for the same reason `settings` itself is: an adapter that needs no
   * sign-in omits both these and no card section appears.
   */
  signIn?(): Promise<InvokeResult>;
  /** Forget the grant, and cancel a sign-in she changed her mind about. */
  signOut?(): Promise<InvokeResult>;
  /**
   * Save a credential of her own for the sign-in to use.
   *
   * Optional beside `signIn` rather than folded into `save`, because it is the
   * same shape of thing one level down: `save` is which channel to read, this
   * is which application is asking Google for permission to write to it. A
   * platform whose sign-in needs no credential from her -- or none at all --
   * omits it, and no fields appear.
   */
  setClient?(input: ChatClientInput): Promise<InvokeResult>;
  /** Put it back to whatever the build carries. The way out of the above. */
  forgetClient?(): Promise<InvokeResult>;
}

export interface ChatClientInput {
  /** Public, echoed back to her, and validated before anything is written. */
  clientId: string;
  /** Blank leaves the stored one alone, as every other secret here does. */
  clientSecret: string;
}

/**
 * Her control page's chat settings, routed here for the reason `obsCommand`
 * routes OBS's: which adapter a name refers to is knowledge about the chat
 * layer, and the registry's job is modules. `null` means "not one of ours".
 *
 * The adapter is named in the arguments rather than in the action, so the two
 * ids stay platform-neutral -- a Twitch adapter that grows settings is reachable
 * through the same pair of strings her deck already knows.
 */
export function chatCommand(
  adapters: readonly ChatAdapter[],
  actionId: string,
  args: string[],
): Promise<InvokeResult> | null {
  if (!CHAT_ACTIONS.has(actionId)) return null;

  const name = args[0] ?? "";
  const settings = adapters.find((adapter) => adapter.name === name)?.settings;
  if (!settings) {
    return Promise.resolve({ ok: false, reason: `There is nothing to set up for "${name}"` });
  }

  // Four of these are optional on `ChatSettings`, and all four refuse the same
  // way when the adapter has not got them: a deck button she made on a build
  // that had a sign-in, pressed on one that does not, has to say so rather
  // than doing nothing. `orRefuse` is that one sentence, in one place.
  //
  // Each thunk calls back through `settings.` rather than holding the method it
  // was handed, so an adapter that writes these as real methods rather than as
  // closures keeps its receiver.
  const orRefuse = (
    method: (() => Promise<InvokeResult>) | undefined,
  ): Promise<InvokeResult> =>
    method ? method() : Promise.resolve({ ok: false, reason: `${name} needs no sign-in` });

  switch (actionId) {
    case CORE_ACTIONS.chatForgetKey:
      return settings.forgetKey();
    case CORE_ACTIONS.chatSignIn:
      return orRefuse(settings.signIn && (() => settings.signIn!()));
    case CORE_ACTIONS.chatSignOut:
      return orRefuse(settings.signOut && (() => settings.signOut!()));
    case CORE_ACTIONS.chatClient:
      return orRefuse(
        settings.setClient &&
          (() =>
            settings.setClient!({
              clientId: (args[1] ?? "").trim(),
              clientSecret: (args[2] ?? "").trim(),
            })),
      );
    case CORE_ACTIONS.chatForgetClient:
      return orRefuse(settings.forgetClient && (() => settings.forgetClient!()));
    default:
      return settings.save({
        channelId: (args[1] ?? "").trim(),
        apiKey: (args[2] ?? "").trim(),
      });
  }
}

/**
 * The core actions this file answers for. A set rather than a chain of
 * comparisons, because there are four of them now and the router in the
 * registry asks the question once.
 */
const CHAT_ACTIONS: ReadonlySet<string> = new Set([
  CORE_ACTIONS.chatSettings,
  CORE_ACTIONS.chatForgetKey,
  CORE_ACTIONS.chatSignIn,
  CORE_ACTIONS.chatSignOut,
  CORE_ACTIONS.chatClient,
  CORE_ACTIONS.chatForgetClient,
]);

/** The settings slice of the core state: only the adapters that have any. */
export function chatViews(adapters: readonly ChatAdapter[]): Record<string, ChatView> {
  const views: Record<string, ChatView> = {};
  for (const adapter of adapters) {
    if (adapter.settings) views[adapter.name] = adapter.settings.view();
  }
  return views;
}
