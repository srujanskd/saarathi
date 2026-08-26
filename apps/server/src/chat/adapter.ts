import type { ConnectionStatus, StreamEvent } from "@saarathi/shared";

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
}
