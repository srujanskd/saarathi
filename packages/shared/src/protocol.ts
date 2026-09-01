import type { ConnectionStatus, EventType } from "./events.js";
import type { Effect, ModuleStatus } from "./module.js";

/** Reserved module id for the core's own slice. */
export const CORE_ID = "core";

/**
 * The core's own actions, spelled exactly as `invoke` takes them.
 *
 * Both ends import these: the server routes on them and her pages send them.
 * A deck button is one of these strings saved on disk, so an id that was
 * renamed on one side only does not fail a build -- it turns a button she made
 * weeks ago into a refusal she finds out about mid-workout, by pressing it.
 * That is the same reason `GAINS` is one constant and not a hundred literals.
 */
export const CORE_ACTIONS = {
  obsConnect: `${CORE_ID}.obsConnect`,
  obsDisconnect: `${CORE_ID}.obsDisconnect`,
  obsAuto: `${CORE_ID}.obsAuto`,
  obsForget: `${CORE_ID}.obsForget`,
  obsScene: `${CORE_ID}.obsScene`,
  obsSettings: `${CORE_ID}.obsSettings`,
  chatSettings: `${CORE_ID}.chatSettings`,
  chatForgetKey: `${CORE_ID}.chatForgetKey`,
  deckSet: `${CORE_ID}.deckSet`,
} as const;

/**
 * What she is allowed to know about the OBS connection. Deliberately not the
 * password: this slice reaches every client, and in IRL mode that is her phone
 * over somebody else's network. `hasPassword` is enough to render the field.
 */
export interface ObsView {
  mode: "auto" | "manual";
  /**
   * Effective values -- what the next connect attempt will actually use, which
   * in auto mode is what OBS's own config file said and not what is stored.
   */
  host: string;
  port: number;
  /**
   * True when a password of *hers* is stored. Deliberately not the one detected
   * in OBS's config: this is what the password field and Forget password are
   * about, and neither has anything to offer for a password she never set.
   */
  hasPassword: boolean;
  /** True when these came from OBS's own config file rather than from her. */
  detected: boolean;
  /** Transient: OBS tells us on connect, and we forget on disconnect. */
  scenes: string[];
  currentScene: string | null;
}

/**
 * What she may know about one chat adapter's settings.
 *
 * Deliberately not the credential, for the reason `ObsView` is not the OBS
 * password: this slice reaches every client, and in IRL mode one of them is her
 * phone over somebody else's network. `hasKey` is enough to render the field
 * and to know whether Forget has anything to do.
 *
 * `title` and `hint` are written by the adapter rather than by the page, on the
 * same rule as `ChannelStats.detail`: where a channel id is found is a fact
 * about YouTube, and the point of the adapter seam is that nothing past it has
 * to know one. A second platform with settings brings its own two sentences and
 * the card renders them unchanged.
 */
export interface ChatView {
  /** What she reads on the card: "YouTube". */
  title: string;
  /** The channel it is reading, or blank when she has not said. */
  channelId: string;
  /** True when a key of hers is stored. Never the key itself. */
  hasKey: boolean;
  /** Where to find the channel id, in her words. */
  hint: string;
}

/**
 * One button on her deck.
 *
 * There is no id. The whole grid is replaced on every save, the way her
 * challenge list is, so nothing downstream ever has to tell one button from the
 * same button moved -- and a deck that is a plain list is a deck she can
 * reorder by dragging without the server learning a second verb.
 */
export interface DeckSlot {
  /** Fully qualified, exactly as `invoke` takes it: "wheel.spin", `CORE_ACTIONS.obsScene`. */
  action: string;
  /** Positional args for that action, exactly what `invoke` sends. */
  args: string[];
  /** What she reads on the button. Never blank: the server refuses that. */
  label: string;
  /** One emoji, or blank. What she actually aims at, at arm's length. */
  icon: string;
  /**
   * A key on her PC that presses this button while something else has focus,
   * as an Electron accelerator out of `HOTKEYS`. Absent on almost every
   * button: this is the one field of a slot that means nothing to the two
   * pages, because only the tray shell can register one.
   *
   * It lives on the slot rather than in a table of its own because a hotkey is
   * a property of a button she already made, and a second list keyed by
   * nothing -- the grid has no ids -- would need reconciling every time she
   * reordered it.
   */
  hotkey?: string;
}

export interface DeckView {
  slots: DeckSlot[];
}

/**
 * What one adapter can currently say about the channel it is reading.
 *
 * Every field is optional because "we do not have this number" is the normal
 * case, not the error case: likes belong to a video and there is no video until
 * she goes live, and a subscriber count she has hidden in YouTube Studio is not
 * available to anyone at any price. A goal rendering 0 because nothing has been
 * fetched yet is the same class of bug as a completion re-firing on a browser
 * source reload -- it is wrong only while she is live, which is the only time
 * anyone is looking.
 */
export interface StatCounts {
  /**
   * Channel subscribers. YouTube rounds this down to three significant figures
   * above 1,000 -- in the API as much as on the page, and even for an
   * authorized request about her own channel -- so it is exact for her today
   * and arrives in steps of 10, then 100, as she grows. Whatever renders it
   * must not animate through the values in between: they do not exist.
   */
  subscribers?: number;
  /** Likes on the video she is live on right now. Exact, and it can go down. */
  likes?: number;
}

/**
 * One adapter's answer to the poll, and what to tell her when a number is
 * missing.
 *
 * `detail` is written by the adapter because only the adapter knows why: "no
 * live stream yet", "she hides her subscriber count", "no API key set" are
 * three different sentences and one absent field. Everything else in this repo
 * that can be unavailable carries its own words for the same reason -- see
 * `ConnectionStatus.detail`.
 */
export interface ChannelStats {
  counts: StatCounts;
  detail: string;
  /**
   * An opaque token for the stream the per-stream counts belong to, or absent
   * when the adapter is not on one.
   *
   * Nothing downstream may read anything into it -- it is a video id today and
   * something else on the next platform. The only fact it carries is that when
   * it changes, every per-stream number started over from nothing, which is
   * what tells a stream-scoped goal to arm itself again. Without it the like
   * goal she hit last night is still showing as complete at 3 likes tonight,
   * and that is a wrong number on screen while she is live.
   */
  stream?: string;
}

export interface CoreState {
  startedAt: number;
  /** One entry per external connection, keyed by adapter name: chat, and OBS. */
  connections: Record<string, ConnectionStatus>;
  modules: ModuleStatus[];
  obs: ObsView;
  /**
   * Her button grid. Core state rather than a module, for the reason the scene
   * list is: every surface renders it and no module owns it. It rides here so
   * the deck page, the control page's editor and (later) the hotkey registrar
   * are all looking at one list that changed everywhere at once.
   */
  deck: DeckView;
  /**
   * Counts polled from the chat adapters, keyed by adapter name exactly as
   * `connections` is -- it is the same set of adapters, answering a second
   * question. Transient on purpose: a subscriber count from last week is worse
   * than no number at all, so nothing here is persisted and a restart starts
   * empty until the first poll lands.
   */
  stats: Record<string, ChannelStats>;
  /**
   * The settings of the chat adapters that have any, keyed by adapter name the
   * way `connections` and `stats` are. Mock chat has nothing to set, so it is
   * absent here rather than present and empty -- the same rule that keeps an
   * adapter which cannot count out of `stats`.
   */
  chat: Record<string, ChatView>;
}

export interface Snapshot {
  core: CoreState;
  /** Only the slices this client subscribed to. */
  modules: Record<string, unknown>;
  /**
   * The server's clock when it built this snapshot.
   *
   * Every timestamp downstream of here -- `spin.startedAt` above all -- is
   * server time, and a client is not necessarily on the same machine: `?server=`
   * exists precisely so the server can be a VPS while the page runs on her
   * phone. A client that subtracts its own `Date.now()` from a server timestamp
   * is out by however far the two clocks disagree, which for a phone is
   * routinely tens of seconds and enough to make a six second spin arrive
   * already finished.
   *
   * It rides on the snapshot rather than the patch because the server re-sends
   * a full snapshot on every connect, so a client re-syncs for free exactly
   * when it could have drifted, and a patch does not pay for a timestamp to
   * correct a drift that cannot accumulate inside one spin.
   */
  serverNow: number;
}

export interface Patch {
  /** Module id, or CORE_ID. */
  module: string;
  state: unknown;
}

/**
 * Which of her surfaces a client is. "hotkey" is not a page: it is the tray
 * shell, connected as a client like any other so that a global shortcut goes
 * through the same `invoke` her deck page does. There is no second code path
 * into an action, and there is not going to be one.
 */
export type Surface = "overlay" | "control" | "deck" | "hotkey";

export interface Hello {
  surface: Surface;
  /** Module ids to subscribe to. Omit for all of them. */
  modules?: string[];
}

export interface MockChatInput {
  author?: string;
  text: string;
  type?: "chat" | "superchat" | "member";
  /** Display amount for superchats, e.g. "$5.00". */
  amount?: string;
  /**
   * Who mock chat should say sent it.
   *
   * Every rule that reads `Author` has to be drivable without a live stream,
   * which the three flags on an event made impossible from here: moderation
   * exempts her mods and a mods-only command refuses everyone else, and neither
   * could be demonstrated -- or tested through the mock path -- while every
   * mock message came from an ordinary viewer. "member" is separate from
   * `type: "member"` on purpose: that one is the join event, this one is a
   * member talking, and they are different events about the same person.
   */
  role?: "viewer" | "member" | "mod" | "streamer";
}

export type InvokeResult =
  | { ok: true }
  | { ok: false; reason: string; retryInMs?: number };

export interface InvokeRequest {
  /** Fully qualified: "wheel.spin". */
  action: string;
  args?: string[];
}

/**
 * Adding a module adds zero socket events. If you are tempted to add one here,
 * you are probably reaching for state that belongs in a module slice.
 */
export interface ServerToClientEvents {
  snapshot: (snapshot: Snapshot) => void;
  patch: (patch: Patch) => void;
  effect: (effect: Effect) => void;
}

export interface ClientToServerEvents {
  hello: (hello: Hello) => void;
  invoke: (request: InvokeRequest, ack?: (result: InvokeResult) => void) => void;
  mockChat: (input: MockChatInput) => void;
}

export type { EventType };
