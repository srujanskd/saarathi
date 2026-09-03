import {
  LEDGER_ID,
  OBS_DEFAULT_HOST,
  OBS_DEFAULT_PORT,
  OBS_ID,
  type GameModuleDef,
  type InvokeResult,
  type MockChatInput,
  type ObsView,
} from "@saarathi/shared";
import type { ChatAdapter } from "../../src/chat/adapter.js";
import { MockChatAdapter, mockAuthorId } from "../../src/chat/mock.js";
import { createKernel, type Kernel } from "../../src/core/kernel.js";
import { obsStatus } from "../../src/core/obs-config.js";
import type { ManualSettings, ObsAdapter, ObsSink } from "../../src/core/obs.js";
import { MemoryStore, type StateStore } from "../../src/core/store.js";
import { chatlog } from "../../src/modules/chatlog/index.js";
import { wheel } from "../../src/modules/wheel/index.js";
import { collect, type Collected } from "./collect.js";
import { testLogger, type RecordingLogger } from "./logger.js";

export interface FakeObs extends ObsAdapter {
  /** Scenes she switched to, in order. */
  readonly scenes: string[];
  readonly visibility: { scene: string; source: string; visible: boolean }[];
  /** Settings saved from her control page, in order. */
  readonly saves: ManualSettings[];
  /** Pretend OBS came up, or went away. Pushes status the way the real one does. */
  arrive(scenes?: string[]): void;
  depart(): void;
}

/**
 * OBS that never opens a socket. It is the whole `ObsAdapter`, not just the
 * narrow `ObsActions` a module sees, because the interesting things now happen
 * on the other half: her control page saving settings, and a connection coming
 * and going underneath a running kernel.
 */
export function fakeObs(): FakeObs {
  const scenes: string[] = [];
  const visibility: FakeObs["visibility"] = [];
  const saves: FakeObs["saves"] = [];
  let sink: ObsSink | null = null;
  let live: string[] | null = null;

  const where = { host: OBS_DEFAULT_HOST, port: OBS_DEFAULT_PORT };

  const view = (): ObsView => ({
    mode: "manual",
    ...where,
    hasPassword: false,
    detected: false,
    scenes: live ?? [],
    currentScene: live?.[0] ?? null,
    browserSources: [],
    microphones: [],
  });

  const publish = () => sink?.view(view());
  const ok = async (): Promise<InvokeResult> => ({ ok: true });

  return {
    name: OBS_ID,
    scenes,
    visibility,
    saves,
    actions: {
      get connected() {
        return live !== null;
      },
      async setScene(name) {
        scenes.push(name);
      },
      async setSourceVisible(scene, source, visible) {
        visibility.push({ scene, source, visible });
      },
    },
    async start(next) {
      sink = next;
      publish();
      sink.status(obsStatus({ phase: "down", ...where }));
    },
    async stop() {
      sink = null;
      live = null;
    },
    view,
    connect: ok,
    disconnect: ok,
    useAuto: ok,
    forgetPassword: ok,
    async setSettings(settings) {
      saves.push(settings);
      return { ok: true };
    },
    async setScene(name) {
      if (live === null) return { ok: false, reason: "OBS is not connected" };
      if (!live.includes(name)) return { ok: false, reason: `OBS has no scene called "${name}"` };
      scenes.push(name);
      publish();
      return { ok: true };
    },
    arrive(list = ["Workout", "Just Chatting"]) {
      live = list;
      publish();
      sink?.status(obsStatus({ phase: "connected", ...where, scenes: list.length }));
    },
    depart() {
      live = null;
      publish();
      sink?.status(obsStatus({ phase: "down", ...where }));
    },
  };
}

export interface Harness {
  kernel: Kernel;
  store: StateStore;
  log: RecordingLogger;
  obs: FakeObs;
  seen: Collected;
  /** Send a line as an ordinary viewer, or as whoever `input.author` names. */
  chat(input: MockChatInput | string): void;
  /** What a viewer has in the ledger, by the name they chat under. */
  balance(name: string): number;
  stop(): Promise<void>;
}

export interface HarnessOptions {
  modules?: GameModuleDef[];
  /** Reuse a store to prove something survived a restart. */
  store?: StateStore;
  chat?: ChatAdapter[];
  obs?: FakeObs;
  /**
   * Ledger balances to boot with, keyed by display name rather than author id
   * -- `mockAuthorId` does that part, so a test says who can afford something in
   * the same words it chats as. `affordsSpins` builds the usual one.
   *
   * A priced command is refused at the gate on an empty ledger, and every
   * viewer starts empty, so any test driving one through chat has to say this.
   */
  balances?: Record<string, number>;
}

/**
 * A started kernel with nothing real behind it: memory store, no-op OBS, mock
 * chat. This is the same interface main.ts uses, which is the point -- an
 * integration test drives the whole pipeline without owning a port or a file.
 */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const log = testLogger();
  const obs = options.obs ?? fakeObs();
  const store = options.store ?? new MemoryStore();
  const chat = options.chat ?? [new MockChatAdapter()];

  if (options.balances) {
    // Merged over whatever the store already holds, so seeding a balance on a
    // second boot of the same store does not wipe what the first one earned.
    const saved = (store.read(LEDGER_ID)?.balances ?? {}) as Record<string, number>;
    const seeded = Object.fromEntries(
      Object.entries(options.balances).map(([name, amount]) => [mockAuthorId(name), amount]),
    );
    store.write(LEDGER_ID, { balances: { ...saved, ...seeded } });
  }

  const kernel = createKernel({
    modules: options.modules ?? [wheel, chatlog],
    chat,
    store,
    obs,
    log,
  });

  const seen = collect(kernel);
  await kernel.start();

  return {
    kernel,
    store,
    log,
    obs,
    seen,
    chat: (input) => kernel.sendMockChat(typeof input === "string" ? { text: input } : input),
    balance: (name) =>
      ((store.read(LEDGER_ID)?.balances ?? {}) as Record<string, number>)[mockAuthorId(name)] ?? 0,
    stop: () => kernel.stop(),
  };
}

/** The goals slice, typed, straight out of a snapshot. */
export function goalsState(kernel: Kernel) {
  return kernel.snapshot().modules.goals as import("@saarathi/shared").GoalsState;
}

/** The gains slice, typed, straight out of a snapshot. Published only: the
 * roster is server-only, so a snapshot does not carry it and neither does this. */
export function gainsState(kernel: Kernel) {
  return kernel.snapshot().modules.gains as Omit<
    import("@saarathi/shared").GainsState,
    "roster" | "streamKey" | "priorStreamKey"
  >;
}

/** The moderation slice, typed, straight out of a snapshot. Published only:
 * the flood history is server-only, so a snapshot does not carry it. */
export function moderationState(kernel: Kernel) {
  return kernel.snapshot().modules.moderation as Omit<
    import("@saarathi/shared").ModerationState,
    "floods"
  >;
}

/** The wheel's slice, typed, straight out of a snapshot. */
export function wheelState(kernel: Kernel) {
  return kernel.snapshot().modules.wheel as import("@saarathi/shared").WheelState;
}
