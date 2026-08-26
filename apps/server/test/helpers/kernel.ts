import type { GameModuleDef, MockChatInput, ObsActions } from "@saarathi/shared";
import type { ChatAdapter } from "../../src/chat/adapter.js";
import { MockChatAdapter } from "../../src/chat/mock.js";
import { createKernel, type Kernel } from "../../src/core/kernel.js";
import { MemoryStore, type StateStore } from "../../src/core/store.js";
import { chatlog } from "../../src/modules/chatlog/index.js";
import { wheel } from "../../src/modules/wheel/index.js";
import { collect, type Collected } from "./collect.js";
import { testLogger, type RecordingLogger } from "./logger.js";

export interface FakeObs extends ObsActions {
  readonly scenes: string[];
  readonly visibility: { scene: string; source: string; visible: boolean }[];
}

export function fakeObs(connected = true): FakeObs {
  const scenes: string[] = [];
  const visibility: FakeObs["visibility"] = [];
  return {
    get connected() {
      return connected;
    },
    scenes,
    visibility,
    async setScene(name) {
      scenes.push(name);
    },
    async setSourceVisible(scene, source, visible) {
      visibility.push({ scene, source, visible });
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
  stop(): Promise<void>;
}

export interface HarnessOptions {
  modules?: GameModuleDef[];
  /** Reuse a store to prove something survived a restart. */
  store?: StateStore;
  chat?: ChatAdapter[];
}

/**
 * A started kernel with nothing real behind it: memory store, no-op OBS, mock
 * chat. This is the same interface main.ts uses, which is the point -- an
 * integration test drives the whole pipeline without owning a port or a file.
 */
export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const log = testLogger();
  const obs = fakeObs();
  const store = options.store ?? new MemoryStore();
  const chat = options.chat ?? [new MockChatAdapter()];

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
    stop: () => kernel.stop(),
  };
}

/** The wheel's slice, typed, straight out of a snapshot. */
export function wheelState(kernel: Kernel) {
  return kernel.snapshot().modules.wheel as import("@saarathi/shared").WheelState;
}
