import { OBS_ID, type CoreState } from "@saarathi/shared";

export type ReadinessState = "ready" | "fix" | "waiting";

export interface ReadinessCheck {
  id: "obs" | "chat" | "microphone" | "overlays" | "deck";
  title: string;
  state: ReadinessState;
  detail: string;
  fixAt?: string;
}

export interface StreamReadiness {
  ready: boolean;
  headline: string;
  checks: ReadinessCheck[];
}

/**
 * The home screen's answer to one question: can she start the stream?
 *
 * This stays a pure projection of server state. The page cannot turn a stale
 * checkbox into a green check, and a reconnect recalculates the whole answer
 * from the snapshot the server sends.
 */
export function streamReadiness(core: CoreState): StreamReadiness {
  const obsStatus = core.connections[OBS_ID];
  const obsConnected = obsStatus?.state === "connected";
  const chatEntry = Object.entries(core.chat)[0];

  const checks: ReadinessCheck[] = [
    {
      id: "obs",
      title: "OBS control",
      state: obsConnected ? "ready" : "fix",
      detail: obsStatus?.detail ?? "Saarathi is still starting OBS control.",
      fixAt: obsConnected ? undefined : "#obs-setup",
    },
    chatCheck(chatEntry, core),
    microphoneCheck(core, obsConnected),
    overlayCheck(core, obsConnected),
    {
      id: "deck",
      title: "Stream deck",
      state: core.deck.slots.length > 0 ? "ready" : "fix",
      detail:
        core.deck.slots.length > 0
          ? `${core.deck.slots.length} ${core.deck.slots.length === 1 ? "button is" : "buttons are"} ready.`
          : "Add at least one live action so the deck is useful when you step away from the PC.",
      fixAt: core.deck.slots.length > 0 ? undefined : "#deck-setup",
    },
  ];

  const ready = checks.every((check) => check.state === "ready");
  const fixes = checks.filter((check) => check.state === "fix").length;
  return {
    ready,
    headline: ready
      ? "Ready to stream"
      : `${fixes} ${fixes === 1 ? "thing" : "things"} to fix`,
    checks,
  };
}

function chatCheck(
  entry: [string, CoreState["chat"][string]] | undefined,
  core: CoreState,
): ReadinessCheck {
  if (!entry) {
    return {
      id: "chat",
      title: "Live chat",
      state: "fix",
      detail: "No live chat service is available.",
    };
  }

  const [name, view] = entry;
  const status = core.connections[name];
  const configured = view.channelId.trim().length > 0;
  const failed = status?.state === "error";
  return {
    id: "chat",
    title: `${view.title} chat`,
    state: configured && !failed ? "ready" : "fix",
    detail: !configured
      ? `Add your ${view.title} channel.`
      : failed
        ? status.detail
        : status?.state === "connected"
          ? status.detail
          : `Channel saved. Saarathi will join when your next live stream starts.`,
    fixAt: configured && !failed ? undefined : `#chat-${name}`,
  };
}

function microphoneCheck(core: CoreState, obsConnected: boolean): ReadinessCheck {
  if (!obsConnected) {
    return {
      id: "microphone",
      title: "Microphone",
      state: "waiting",
      detail: "Connect OBS first, then Saarathi can check your microphone.",
      fixAt: "#obs-setup",
    };
  }

  if (core.obs.microphones.length === 0) {
    return {
      id: "microphone",
      title: "Microphone",
      state: "fix",
      detail: "OBS has no Mic/Aux input. Add your microphone in OBS Settings, under Audio.",
      fixAt: "#obs-media-setup",
    };
  }

  const live = core.obs.microphones.find((input) => input.muted === false);
  if (live) {
    return {
      id: "microphone",
      title: "Microphone",
      state: "ready",
      detail: `${live.name} is present and unmuted in OBS.`,
    };
  }

  const unknown = core.obs.microphones.some((input) => input.muted === null);
  return {
    id: "microphone",
    title: "Microphone",
    state: "fix",
    detail: unknown
      ? "OBS found your microphone but did not report its mute state. Check it before going live."
      : "Every microphone in OBS is muted. Unmute the one you will use.",
    fixAt: "#obs-media-setup",
  };
}

function overlayCheck(core: CoreState, obsConnected: boolean): ReadinessCheck {
  if (!obsConnected) {
    return {
      id: "overlays",
      title: "Browser sources",
      state: "waiting",
      detail: "Connect OBS first, then Saarathi can check its browser sources.",
      fixAt: "#obs-setup",
    };
  }

  const expected = new Set(
    core.modules
      .filter((module) => module.overlay)
      .map((module) => module.browserSourceName)
      .filter((name): name is string => typeof name === "string"),
  );
  const count = core.obs.browserSources.filter((source) => expected.has(source)).length;
  return {
    id: "overlays",
    title: "Browser sources",
    state: count > 0 ? "ready" : "fix",
    detail:
      count > 0
        ? `${count} Saarathi browser ${count === 1 ? "source is" : "sources are"} ready in OBS.`
        : "Add at least one Saarathi overlay to OBS for this stream.",
    fixAt: count > 0 ? undefined : "#obs-media-setup",
  };
}
