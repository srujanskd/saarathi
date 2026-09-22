import { describe, expect, it } from "vitest";
import { OBS_ID, type ChatSignInView, type CoreState } from "@saarathi/shared";
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
      browserSourceName: "Saarathi wheel",
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
    browserSources: ["Saarathi wheel"],
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
  const connected: ChatSignInView = {
    granted: true, status: "connected", detail: "Chat sign-in is connected.",
    clientId: "saved", hasClientSecret: true, builtIn: false, clientHint: "",
  };
  function withSignIn(signIn: ChatSignInView) {
    const state = core();
    state.chat.youtube!.signIn = signIn;
    return state;
  }

  it("does not call working incoming chat ready when replies are disconnected", () => {
    const state = withSignIn({ ...connected, granted: false, status: "disconnected", detail: "Reconnect chat replies." });
    state.connections.youtube = { state: "connected", detail: "Reading chat" };
    const result = streamReadiness(state);
    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.id === "chat")?.state).toBe("ready");
    expect(result.checks.find((check) => check.id === "replies")).toMatchObject({
      state: "fix", detail: "Reconnect chat replies.", fixAt: "#chat-replies-youtube",
    });
  });

  it("waits for verification instead of treating a saved token as a working sign-in", () => {
    const result = streamReadiness(withSignIn({ ...connected, status: "checking" }));
    expect(result.ready).toBe(false);
    expect(result.headline).toBe("Checking stream readiness");
    expect(result.checks.find((check) => check.id === "replies")?.state).toBe("waiting");
  });

  it("becomes ready when the sign-in check succeeds", () => {
    expect(streamReadiness(withSignIn(connected)).ready).toBe(true);
  });

  it.each([{ used: 180, outOfQuota: false }, { used: 2, outOfQuota: true }])(
    "shows the reply allowance problem independently of a working sign-in: %s", (limits) => {
      const state = withSignIn(connected);
      state.writes = { ...state.writes, adapter: "youtube", ...limits };
      const result = streamReadiness(state);
      expect(result.ready).toBe(false);
      expect(result.checks.find((check) => check.id === "replies")?.detail)
        .toContain(limits.outOfQuota ? "quota is spent" : "only moderation can write");
    },
  );

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
