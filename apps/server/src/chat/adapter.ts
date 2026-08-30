import type { ChannelStats, ConnectionStatus, StreamEvent } from "@saarathi/shared";

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
}
