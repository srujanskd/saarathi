import { describe, expect, it } from "vitest";
import { OBS_ID, type CoreState } from "@saarathi/shared";
import { streamReadiness } from "../../src/core/readiness.js";

const core = (overrides: Partial<CoreState> = {}): CoreState => ({
  startedAt: 1,
  connections: {
    [OBS_ID]: { state: "connected", detail: "OBS connected" },
    youtube: { state: "disconnected", detail: "No live stream found" },
  },
  modules: [
    {
      id: "wheel",
      title: "Challenge wheel",
      overlay: true,
      browserSourceName: "Saarathi Challenge wheel",
      enabled: true,
      armed: true,
      arming: false,
      actions: [],
      commands: [],
    },
  ],
  obs: {
    mode: "auto",
    host: "stream-pc",
    port: 4455,
    hasPassword: false,
    detected: true,
    scenes: ["Workout"],
    currentScene: "Workout",
    browserSources: ["Saarathi Challenge wheel"],
    microphones: [{ name: "Mic/Aux", muted: false }],
  },
  deck: { slots: [{ action: "wheel.spin", args: [], label: "Spin", icon: "" }] },
  stats: {},
  chat: {
    youtube: { title: "YouTube", channelId: "UC123", hasKey: false, hint: "Find it" },
  },
  writes: { adapter: null, used: 0, ceiling: 200, reserve: 20, outOfQuota: false },
  ...overrides,
});

describe("stream readiness", () => {
  it("is ready before the live stream exists when the channel is saved", () => {
    const result = streamReadiness(core());
    expect(result.ready).toBe(true);
    expect(result.headline).toBe("Ready to stream");
    expect(result.checks.find((check) => check.id === "chat")?.detail).toContain("next live stream");
  });

  it("names each independent thing she can fix", () => {
    const result = streamReadiness(
      core({
        obs: { ...core().obs, browserSources: [], microphones: [{ name: "Mic/Aux", muted: true }] },
        deck: { slots: [] },
        chat: {
          youtube: { title: "YouTube", channelId: "", hasKey: false, hint: "Find it" },
        },
      }),
    );

    expect(result.headline).toBe("4 things to fix");
    expect(result.checks.filter((check) => check.state === "fix").map((check) => check.id)).toEqual([
      "chat",
      "microphone",
      "overlays",
      "deck",
    ]);
  });

  it("waits to judge OBS inputs instead of counting one missing connection three times", () => {
    const result = streamReadiness(
      core({
        connections: {
          [OBS_ID]: { state: "disconnected", detail: "OBS is not running" },
          youtube: { state: "disconnected", detail: "No live stream found" },
        },
        obs: { ...core().obs, browserSources: [], microphones: [] },
      }),
    );

    expect(result.headline).toBe("1 thing to fix");
    expect(result.checks.find((check) => check.id === "microphone")?.state).toBe("waiting");
    expect(result.checks.find((check) => check.id === "overlays")?.state).toBe("waiting");
  });

  it("does not call an unknown microphone mute state ready", () => {
    const result = streamReadiness(
      core({ obs: { ...core().obs, microphones: [{ name: "Mic/Aux", muted: null }] } }),
    );
    expect(result.checks.find((check) => check.id === "microphone")).toMatchObject({
      state: "fix",
      fixAt: "#obs-media-setup",
    });
  });

  it("does not mistake an unrelated browser input for a Saarathi overlay", () => {
    const result = streamReadiness(
      core({ obs: { ...core().obs, browserSources: ["Chat dock"] } }),
    );
    expect(result.checks.find((check) => check.id === "overlays")).toMatchObject({
      state: "fix",
      fixAt: "#obs-media-setup",
    });
  });
});
