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
   * What she can set up for this adapter, if there is anything.
   *
   * One member rather than three methods, on the shape `ObsAdapter.actions`
   * already uses: an adapter that needs no setting up omits it, and mock chat
   * -- which is always registered beside the real one -- has nothing to omit.
   */
  readonly settings?: ChatSettings;
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
  const forget = actionId === CORE_ACTIONS.chatForgetKey;
  if (!forget && actionId !== CORE_ACTIONS.chatSettings) return null;

  const name = args[0] ?? "";
  const settings = adapters.find((adapter) => adapter.name === name)?.settings;
  if (!settings) {
    return Promise.resolve({ ok: false, reason: `There is nothing to set up for "${name}"` });
  }
  if (forget) return settings.forgetKey();
  return settings.save({
    channelId: (args[1] ?? "").trim(),
    apiKey: (args[2] ?? "").trim(),
  });
}

/** The settings slice of the core state: only the adapters that have any. */
export function chatViews(adapters: readonly ChatAdapter[]): Record<string, ChatView> {
  const views: Record<string, ChatView> = {};
  for (const adapter of adapters) {
    if (adapter.settings) views[adapter.name] = adapter.settings.view();
  }
  return views;
}
