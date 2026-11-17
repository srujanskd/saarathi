import { randomBytes, randomUUID } from "node:crypto";
import {
  ALERT_POSITIONS,
  ALERT_THEMES,
  MAX_MEDIA_BYTES,
  MAX_MEDIA_DURATION_MS,
  MAX_MEDIA_ITEMS,
  MAX_PAID_QUEUE,
  MEDIA_ID,
  PAID_ALERT_MS,
  PAID_ALERT_TIER_MS,
  PAID_TIERS,
  MEDIA_TYPES,
  type GameModuleDef,
  type MediaCue,
  type MediaItem,
  type MediaState,
  type PaidMessage,
  type ModuleContext,
  type SpeechStyle,
  type SpeechVoiceId,
} from "@saarathi/shared";
import type { MediaFiles } from "./files.js";
import { knownTier, paidMessage, paidSpeech, type SpeechVoice } from "./speech.js";
import { microsoftVoice, SpeechError, validSpeechRegion, type MicrosoftVoice } from "./microsoft-speech.js";
import { inspectMedia } from "./inspect.js";
import { PickerError, type VoicePicker } from "./voice-picker.js";
import { knownStyle, knownVoice } from "./delivery.js";

const MAX_LABEL = 48;
const MIN_DURATION_MS = 500;
/**
 * Server-only, both of them: they are viewer ids nobody's page needs, and they
 * would otherwise ride in every snapshot to every overlay, read-only OBS
 * links included.
 *
 * `viewerVoices` is remembered voices, least recently heard first, so a regular
 * sounds the same every time. `paidViewers` is who sent each waiting message,
 * by message id, which is what a remembered voice is looked up by; it is kept
 * because the queue survives a restart and the pick may come after one.
 */
type MediaModuleState = MediaState & {
  speechKey: string;
  viewerVoices: [string, SpeechVoiceId][];
  paidViewers: [string, string][];
};
/** Enough regulars for a long while; past it the one heard least recently is forgotten. */
const MAX_REMEMBERED_VOICES = 500;
/**
 * After Claude fails, how long messages go by in the default voice before it
 * is asked again. Without it a signed-out Claude Code costs every message in a
 * raid its own timeout.
 */
const PICKER_PAUSE_MS = 5 * 60_000;

/** Long enough to read, and longer the bigger it is. */
const alertMs = (message: Pick<PaidMessage, "tier"> | null | undefined) =>
  PAID_ALERT_MS + PAID_ALERT_TIER_MS * ((message?.tier ?? 1) - 1);

/** What a preview at each rung says it was for. Rupees because hers are; nobody is charged. */
const SAMPLE_AMOUNTS = ["₹40", "₹80", "₹160", "₹400", "₹800", "₹2,000", "₹5,000"];

const knownTheme = (value: unknown): value is keyof typeof ALERT_THEMES =>
  typeof value === "string" && Object.hasOwn(ALERT_THEMES, value);
const knownPosition = (value: unknown): value is keyof typeof ALERT_POSITIONS =>
  typeof value === "string" && Object.hasOwn(ALERT_POSITIONS, value);

export interface MediaUpload {
  label: unknown;
  mime: unknown;
  volume: unknown;
  data: Buffer;
}

export type MediaResult<T = undefined> =
  | { ok: true; value: T }
  | { ok: false; reason: string };

export interface MediaController {
  module: GameModuleDef<MediaModuleState>;
  add(upload: MediaUpload): MediaResult<MediaItem>;
  remove(id: string): MediaResult;
  asset(id: string, key: string): { item: MediaItem; path: string } | null;
}

export interface MediaOptions {
  files: MediaFiles;
  now?: () => number;
  id?: () => string;
  assetKey?: () => string;
  voice?: SpeechVoice;
  microsoftVoice?: MicrosoftVoice;
  /** Absent where nothing can pick voices; the switch then refuses with a sentence. */
  picker?: VoicePicker;
}

/** The media library and its one server-timed playback lane. */
export function createMedia(options: MediaOptions): MediaController {
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const assetKey = options.assetKey ?? (() => randomBytes(18).toString("base64url"));
  let context: ModuleContext<MediaModuleState> | null = null;

  const cloudVoice = options.microsoftVoice ?? microsoftVoice();
  let generation: AbortController | null = null;
  let epoch = 0;
  // The paid message whose audio is `state.speech`, null for a test phrase.
  let speaking: string | null = null;
  // Test voice jumps the queue and is never persisted: it is not anybody's money.
  let testWaiting = false;
  let testStyle: SpeechStyle | undefined;
  // The one message Claude is choosing for, off the lane so playback never waits behind it.
  let picking: { id: string; controller: AbortController } | null = null;
  // Messages whose pick ended without a style; they are read in the default voice.
  const unpicked = new Set<string>();
  let pickerPausedUntil = 0;

  const stopPicking = () => {
    picking?.controller.abort();
    picking = null;
  };

  const clearSpeech = (ctx: ModuleContext<MediaModuleState>) => {
    const item = ctx.state.speech;
    if (item) {
      try { options.files.remove(item); } catch { ctx.log.warn("media: could not remove speech audio"); }
      ctx.setState({ speech: null });
    }
    speaking = null;
  };

  /**
   * Stop reading, and keep the queue. A clip she pressed, a voice she changed or
   * a restart all end up here: none of them is a decision about anybody's
   * message, so the one being read stays at the head and is read again in full.
   */
  const interrupt = (ctx: ModuleContext<MediaModuleState>) => {
    epoch++;
    generation?.abort();
    generation = null;
    if (ctx.state.speech && ctx.state.active?.itemId === ctx.state.speech.id) ctx.setState({ active: null });
    clearSpeech(ctx);
  };

  /** Her Stop: the one way the queue is meant to empty. */
  const cancelSpeech = (ctx: ModuleContext<MediaModuleState>) => {
    interrupt(ctx);
    stopPicking();
    unpicked.clear();
    testWaiting = false;
    if (ctx.state.paid.length > 0) ctx.setState({ paid: [], paidViewers: [] });
    ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
  };

  const voiceStatus = (state?: MediaModuleState) => {
    if (state?.speechProvider === "microsoft") {
      return state.speechKey ? "Ready. Kannada announcer voice plays through the Media overlay in OBS."
        : "Add your Azure Speech key and region below to use the Kannada announcer voice.";
    }
    return options.voice ? "Ready. Paid messages play through the Media overlay in OBS."
      : "Built-in speech needs Windows or macOS on the server. You can also set up Microsoft speech below.";
  };

  const pickerOff = "Off. Every message is read in the voice above.";
  const pickerOn = "On. Claude picks a voice for each viewer and a mood for each message.";
  const pickerRetry = "Saarathi will ask Claude again in five minutes, or switch this off and on to ask now.";

  const viewerOf = (state: Readonly<MediaModuleState>, messageId: string) =>
    state.paidViewers.find(([id]) => id === messageId)?.[1];

  const remembered = (state: Readonly<MediaModuleState>, viewer: string | undefined) =>
    viewer ? state.viewerVoices.find(([id]) => id === viewer)?.[1] : undefined;

  /** Also how a returning viewer moves to the back, so the full list forgets whoever has been away longest. */
  const remember = (ctx: ModuleContext<MediaModuleState>, viewer: string, voice: SpeechVoiceId) => {
    const kept = ctx.state.viewerVoices.filter(([id]) => id !== viewer);
    const viewerVoices = [...kept, [viewer, voice] as [string, SpeechVoiceId]].slice(-MAX_REMEMBERED_VOICES);
    ctx.setState({ viewerVoices, rememberedVoices: viewerVoices.length });
  };

  /**
   * How this message should sound, or nothing for the default voice. Never
   * throws: a picker that is missing, signed out or slow costs the message its
   * style, never its turn.
   */
  const choose = async (ctx: ModuleContext<MediaModuleState>, message: PaidMessage, signal: AbortSignal): Promise<SpeechStyle | undefined> => {
    const viewer = viewerOf(ctx.state, message.id);
    const known = remembered(ctx.state, viewer);
    if (viewer && known) remember(ctx, viewer, known);
    const fallback = known ? { voice: known, mood: "neutral" as const } : undefined;
    // Nothing to read a mood from, and the voice is already settled.
    if (known && !message.text) return fallback;
    if (now() < pickerPausedUntil) return fallback;
    try {
      if (!options.picker) throw new PickerError("missing");
      const picked = await options.picker.pick({ name: message.name, amount: message.amount, text: message.text }, signal);
      if (signal.aborted) return undefined;
      if (!known && viewer) remember(ctx, viewer, picked.voice);
      ctx.setState({ pickerStatus: pickerOn });
      return { voice: known ?? picked.voice, mood: picked.mood };
    } catch (error) {
      if (signal.aborted) return undefined;
      pickerPausedUntil = now() + PICKER_PAUSE_MS;
      const why = error instanceof PickerError ? error.message : "Claude did not answer, so the default voice was used.";
      ctx.setState({ pickerStatus: `${why} ${pickerRetry}` });
      return fallback;
    }
  };

  /** Still waiting for Claude: switched on, not chosen yet, and not already given up on. */
  const needsPick = (state: Readonly<MediaModuleState>, message: PaidMessage) =>
    state.pickVoices && !message.style && !unpicked.has(message.id);

  /**
   * Choose voices ahead of the lane, one message at a time and in order, so
   * Claude's answer overlaps whatever is playing instead of holding up the next
   * alert. A message waiting for her check is skipped: its words go to
   * Anthropic only once she has let them through.
   */
  const pickAhead = (ctx: ModuleContext<MediaModuleState>) => {
    if (picking || !ctx.state.ttsEnabled || !ready(ctx)) return;
    const next = ctx.state.paid.find((message) => needsPick(ctx.state, message) && !held(ctx.state, message));
    if (!next) return;
    const controller = new AbortController();
    picking = { id: next.id, controller };
    void choose(ctx, next, controller.signal).then((style) => {
      if (picking?.controller !== controller) return;
      picking = null;
      if (style) ctx.setState((state) => ({ paid: state.paid.map((message) => message.id === next.id ? { ...message, style } : message) }));
      else unpicked.add(next.id);
      void advance(ctx);
      pickAhead(ctx);
    });
  };

  const ready = (ctx: ModuleContext<MediaModuleState>) => ctx.state.speechProvider === "microsoft"
    ? Boolean(ctx.state.speechKey) : Boolean(options.voice);

  /** Her check-first switch is on, and this one has words she has not seen. */
  const held = (state: Readonly<MediaModuleState>, message: PaidMessage | undefined) =>
    Boolean(message && state.checkFirst && message.text && !message.approved);

  /** The message she is being asked about, refusing if there is none or it moved on. */
  const heldOrRefuse = (ctx: ModuleContext<MediaModuleState>, wanted: string | undefined) => {
    const head = ctx.state.paid[0];
    if (!head || !held(ctx.state, head)) return ctx.refuse("No paid message is waiting for you");
    if (wanted && wanted !== head.id) return ctx.refuse("That message has moved on");
    return head;
  };

  const finished = (ctx: ModuleContext<MediaModuleState>, paidId: string | null) => {
    if (!paidId) return;
    unpicked.delete(paidId);
    ctx.setState((state) => ({
      paid: state.paid.filter((message) => message.id !== paidId),
      paidViewers: state.paidViewers.filter(([id]) => id !== paidId),
    }));
  };

  /** The one way anything gets on the lane, and the one way it comes off. */
  const startCue = (ctx: ModuleContext<MediaModuleState>, itemId: string | null, durationMs: number, paidId: string | null,
    sample?: PaidMessage) => {
    const startedAt = now();
    const cue: MediaCue = { id: id(), itemId, startedAt, endsAt: startedAt + durationMs,
      ...(paidId ? { paidId } : {}), ...(sample ? { sample } : {}) };
    // Replacing is the v1 queue policy. The old timer may still wake up,
    // but the cue id stops it from clearing the replacement.
    ctx.setState({ active: cue });
    ctx.after(durationMs, () => {
      if (ctx.state.active?.id !== cue.id) return;
      ctx.setState({ active: null });
      clearSpeech(ctx);
      finished(ctx, paidId);
      ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
      void advance(ctx);
    });
  };

  /**
   * Put the next thing on the lane, if it is free. Every path that frees it
   * calls this. A paid message is shown whether or not it can be heard: speech
   * off, no voice on this machine and a voice that failed all still put the
   * name and the amount on her stream.
   */
  const advance = async (ctx: ModuleContext<MediaModuleState>) => {
    if (generation || ctx.state.speech || ctx.state.active) return;
    const voiced = ctx.state.ttsEnabled && ready(ctx);
    if (!voiced) testWaiting = false;
    const head = testWaiting ? null : ctx.state.paid[0];
    if (!testWaiting && !head) return;
    if (head && held(ctx.state, head)) {
      ctx.setState({ ttsStatus: `${head.name}'s message is waiting for you to check` });
      return;
    }
    testWaiting = false;
    if (head && !voiced) return startCue(ctx, null, alertMs(head), head.id);
    // Usually chosen while the one before was playing. When it is not, the
    // pick's own ending calls back in here.
    if (head && needsPick(ctx.state, head)) {
      ctx.setState({ ttsStatus: "Choosing a voice…" });
      pickAhead(ctx);
      return;
    }
    const started = epoch;
    const controller = new AbortController();
    generation = controller;
    const style = head ? head.style : testStyle;
    testStyle = undefined;
    const microsoft = ctx.state.speechProvider === "microsoft";
    const text = head ? paidSpeech(head, microsoft ? "kn" : "en")
      : microsoft ? "ಮನೆಯ ಸದಸ್ಯರೇ, ನಿಮ್ಮ ಬೆಂಬಲಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ಮುಂದಿನ ಸವಾಲಿಗೆ ಸಿದ್ಧರಾಗಿ!"
        : "Thank you for supporting the stream!";
    const paidId = head?.id ?? null;
    ctx.setState({ ttsStatus: "Preparing speech…" });
    try {
      const data = microsoft
        ? await cloudVoice(text, controller.signal, { key: ctx.state.speechKey, region: ctx.state.speechRegion }, style)
        : await options.voice!(text, controller.signal, style);
      if (started !== epoch) return;
      const made = makeItem({ label: "Paid message", mime: "audio/wav", volume: 1, data },
        { id: `speech-${id()}`, assetKey: assetKey(), now: now() });
      if (!made.ok) throw new Error("Invalid speech audio");
      options.files.put(made.value.id, made.value.mime, data);
      ctx.setState({ speech: made.value });
      speaking = paidId;
      generation = null;
      const result = await ctx.invoke("play", { args: [made.value.id] });
      if (started !== epoch) return;
      if (!result.ok) throw new Error("Speech playback unavailable");
      ctx.setState({ ttsStatus: "Reading a paid message" });
    } catch (error) {
      if (started !== epoch) return;
      generation = null;
      clearSpeech(ctx);
      ctx.setState({ ttsStatus: error instanceof SpeechError ? error.message : "Could not read that message. Try Test voice again." });
      // Shown without a voice rather than dropped: the voice failed, the
      // message did not.
      if (paidId) startCue(ctx, null, alertMs(head), paidId);
      else void advance(ctx);
    }
  };

  const module: GameModuleDef<MediaModuleState> = {
    id: MEDIA_ID,
    title: "Media",
    overlay: true,
    initialState: { items: [], active: null, speech: null, ttsEnabled: true, paid: [], checkFirst: false, ttsStatus: voiceStatus(),
      speechProvider: "system", speechRegion: "centralindia", speechKey: "", hasSpeechKey: false,
      pickVoices: false, pickerStatus: pickerOff, viewerVoices: [], rememberedVoices: 0, paidViewers: [],
      alertTheme: "card", alertPosition: "top" },
    // Her library survives. Playback does not: a server restart stops the lane
    // rather than claiming a clip is still audible after the process died. The
    // paid queue survives too, and its head is read again from the start.
    persist: ["items", "ttsEnabled", "paid", "checkFirst", "speechProvider", "speechRegion", "speechKey", "pickVoices",
      "viewerVoices", "paidViewers", "alertTheme", "alertPosition"],
    serverOnly: ["speechKey", "viewerVoices", "paidViewers"],

    actions: {
      speechSettings: {
        label: "Save speech voice",
        needsArgs: true,
        run(input, ctx) {
          const [provider, rawRegion = "", rawKey = ""] = input.args;
          if (provider !== "system" && provider !== "microsoft") return ctx.refuse("Choose a speech voice");
          const region = rawRegion.trim().toLowerCase();
          const key = rawKey.trim();
          if (provider === "microsoft" && !validSpeechRegion(region)) return ctx.refuse("Enter the region code from Azure, such as centralindia");
          if (key && !/^[a-zA-Z0-9]{16,256}$/.test(key)) return ctx.refuse("Paste a valid Azure Speech key");
          interrupt(ctx);
          ctx.setState({ speechProvider: provider, speechRegion: region || ctx.state.speechRegion,
            speechKey: key || ctx.state.speechKey, hasSpeechKey: Boolean(key || ctx.state.speechKey) });
          ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
          void advance(ctx);
        },
      },
      forgetSpeechKey: {
        label: "Forget Microsoft speech key",
        run(_input, ctx) {
          interrupt(ctx);
          ctx.setState({ speechKey: "", hasSpeechKey: false });
          ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
          void advance(ctx);
        },
      },
      tts: {
        label: "Set paid-message speech",
        needsArgs: true,
        run(input, ctx) {
          const enabled = input.args[0];
          if (enabled !== "on" && enabled !== "off") return ctx.refuse("Choose on or off");
          // Off means quiet, not gone: the queue carries on, on screen only.
          interrupt(ctx);
          ctx.setState({ ttsEnabled: enabled === "on" });
          ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
          void advance(ctx);
        },
      },
      checkFirst: {
        label: "Check paid messages first",
        needsArgs: true,
        run(input, ctx) {
          const on = input.args[0];
          if (on !== "on" && on !== "off") return ctx.refuse("Choose on or off");
          ctx.setState({ checkFirst: on === "on" });
          // Off lets whatever was waiting go, in order.
          if (on === "off") {
            ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
            void advance(ctx);
          }
        },
      },
      // No arguments needed, so the deck and a hotkey can answer the one at
      // the head of the line; her card names the message so a tap never lands
      // on the next one by mistake.
      approve: {
        label: "Show the paid message",
        run(input, ctx) {
          const head = heldOrRefuse(ctx, input.args[0]);
          ctx.setState((state) => ({ paid: state.paid.map((message) => message.id === head.id ? { ...message, approved: true } : message) }));
          ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
          void advance(ctx);
        },
      },
      thanksOnly: {
        label: "Thanks only, skip the words",
        run(input, ctx) {
          const head = heldOrRefuse(ctx, input.args[0]);
          ctx.setState((state) => ({ paid: state.paid.map((message) => message.id === head.id
            ? { ...message, text: "", cut: "You left it out", approved: true } : message) }));
          ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
          void advance(ctx);
        },
      },
      pickVoices: {
        label: "Let Claude pick voices",
        needsArgs: true,
        run(input, ctx) {
          const on = input.args[0];
          if (on !== "on" && on !== "off") return ctx.refuse("Choose on or off");
          if (on === "on" && !options.picker?.available()) {
            return ctx.refuse("Claude Code is not set up on the computer running Saarathi. Ask whoever set up Saarathi to install it.");
          }
          // Messages already given a style keep it; only new ones change.
          if (on === "on") {
            // Switching on is also how she asks again after a failure.
            pickerPausedUntil = 0;
            unpicked.clear();
          } else {
            stopPicking();
          }
          ctx.setState({ pickVoices: on === "on", pickerStatus: on === "on" ? pickerOn : pickerOff });
          // A message waiting on Claude goes ahead in the default voice.
          void advance(ctx);
          pickAhead(ctx);
        },
      },
      // Takes an argument so no deck button or hotkey can offer it: there is no
      // undo, and her card asks twice before it sends this.
      forgetVoices: {
        label: "Forget remembered voices",
        needsArgs: true,
        run(input, ctx) {
          if (input.args[0] !== "all") return ctx.refuse("Confirm forgetting every remembered voice");
          if (ctx.state.viewerVoices.length === 0) return ctx.refuse("No voices are remembered");
          ctx.setState({ viewerVoices: [], rememberedVoices: 0 });
        },
      },
      testVoice: {
        label: "Test voice",
        run(input, ctx) {
          if (!ready(ctx)) return ctx.refuse(voiceStatus(ctx.state));
          if (!ctx.state.ttsEnabled) return ctx.refuse("Turn paid-message speech on first");
          if (testWaiting) return ctx.refuse("Test voice is already waiting");
          const voice = input.args[0];
          if (voice !== undefined && !knownVoice(voice)) return ctx.refuse("Choose one of the voices");
          testStyle = voice === undefined ? undefined : { voice, mood: "neutral" };
          testWaiting = true;
          void advance(ctx);
        },
      },
      play: {
        label: "Play a clip",
        needsArgs: true,
        run(input, ctx) {
          const item = ctx.state.speech?.id === input.args[0]
            ? ctx.state.speech
            : ctx.state.items.find((candidate) => candidate.id === input.args[0]);
          if (!item) return ctx.refuse("That clip is gone");
          if (item.id !== ctx.state.speech?.id) interrupt(ctx);
          const paidId = item.id === ctx.state.speech?.id ? speaking : null;
          const message = paidId ? ctx.state.paid.find((candidate) => candidate.id === paidId) : undefined;
          startCue(ctx, item.id, paidId ? Math.max(item.durationMs, alertMs(message)) : item.durationMs, paidId);
        },
      },
      alertTheme: {
        label: "Paid alert look",
        needsArgs: true,
        run(input, ctx) {
          const theme = input.args[0];
          if (!knownTheme(theme)) return ctx.refuse("Choose one of the looks");
          ctx.setState({ alertTheme: theme });
        },
      },
      alertPosition: {
        label: "Paid alert position",
        needsArgs: true,
        run(input, ctx) {
          const position = input.args[0];
          if (!knownPosition(position)) return ctx.refuse("Choose one of the positions");
          ctx.setState({ alertPosition: position });
        },
      },
      // Silent, and only on a free lane: a preview never pushes a real
      // message off the screen, and a real one that arrives meanwhile waits
      // a few seconds, the same as it would behind any clip.
      previewAlert: {
        label: "Preview a paid alert",
        needsArgs: true,
        run(input, ctx) {
          const tier = Number(input.args[0]);
          if (!knownTier(tier)) return ctx.refuse(`Choose a size from 1 to ${PAID_TIERS}`);
          if (ctx.state.active || generation || ctx.state.speech) return ctx.refuse("Wait for what is on screen to finish");
          const sample: PaidMessage = {
            id: `preview-${id()}`,
            at: now(),
            name: "Preview",
            amount: SAMPLE_AMOUNTS[tier - 1]!,
            text: "This is how a paid message this size looks on your stream.",
            tier,
          };
          startCue(ctx, null, alertMs(sample), null, sample);
        },
      },
      stop: {
        label: "Stop all media",
        run(_input, ctx) {
          // A preview is the only thing on the lane she put there to look at,
          // and Stop is the only way off it, so Stop ends just the preview.
          // Clearing the queue too would throw away whoever paid while she
          // was placing the alert. Pressed again, it stops everything.
          if (ctx.state.active?.sample) {
            ctx.setState({ active: null });
            void advance(ctx);
            return;
          }
          if (!ctx.state.active && !generation && ctx.state.paid.length === 0 && !testWaiting) return ctx.refuse("Nothing is playing");
          cancelSpeech(ctx);
          ctx.setState({ active: null });
        },
      },
    },

    setup(ctx) {
      // Saved by some earlier release: a voice or mood it no longer has is dropped, not trusted.
      const paid = ctx.state.paid.map(({ style, tier, ...message }) => {
        const kept = knownStyle(style);
        return { ...message, ...(kept ? { style: kept } : {}), ...(knownTier(tier) ? { tier } : {}) };
      });
      const viewerVoices = ctx.state.viewerVoices.filter(([, voice]) => knownVoice(voice));
      const paidViewers = ctx.state.paidViewers.filter(([messageId]) => paid.some((message) => message.id === messageId));
      ctx.setState({ paid, viewerVoices, paidViewers, hasSpeechKey: Boolean(ctx.state.speechKey), ttsStatus: voiceStatus(ctx.state),
        rememberedVoices: viewerVoices.length, pickerStatus: ctx.state.pickVoices ? pickerOn : pickerOff,
        alertTheme: knownTheme(ctx.state.alertTheme) ? ctx.state.alertTheme : "card",
        alertPosition: knownPosition(ctx.state.alertPosition) ? ctx.state.alertPosition : "top" });
      ctx.on("paid-event", (event) => {
        if (ctx.state.paid.length >= MAX_PAID_QUEUE) {
          ctx.setState({ ttsStatus: "Paid message queue is full. New messages are being skipped." });
          return;
        }
        const message = paidMessage(event, id());
        const viewer = event.author.id?.slice(0, 128);
        ctx.setState((state) => ({
          paid: [...state.paid, message],
          ...(viewer ? { paidViewers: [...state.paidViewers, [message.id, viewer] as [string, string]] } : {}),
        }));
        void advance(ctx);
        pickAhead(ctx);
      });
      context = ctx;
      const present = ctx.state.items.filter((item) => options.files.exists(item));
      if (present.length !== ctx.state.items.length) ctx.setState({ items: present });
      // Whatever was waiting when the server last stopped is still owed.
      void advance(ctx);
    },

    teardown(ctx) {
      interrupt(ctx);
      stopPicking();
      if (ctx.state.active) ctx.setState({ active: null });
      context = null;
    },
  };

  return {
    module,
    add(upload) {
      const ctx = context;
      if (!ctx) return { ok: false, reason: "Media is still starting" };
      if (ctx.state.items.length >= MAX_MEDIA_ITEMS) {
        return { ok: false, reason: `That is ${MAX_MEDIA_ITEMS} clips already. Remove one first.` };
      }
      const made = makeItem(upload, { id: id(), assetKey: assetKey(), now: now() });
      if (!made.ok) return made;
      try {
        options.files.put(made.value.id, made.value.mime, upload.data);
      } catch {
        return { ok: false, reason: "Saarathi could not save that file" };
      }
      ctx.setState((state) => ({ items: [...state.items, made.value] }));
      return made;
    },
    remove(itemId) {
      const ctx = context;
      if (!ctx) return { ok: false, reason: "Media is still starting" };
      const item = ctx.state.items.find((candidate) => candidate.id === itemId);
      if (!item) return { ok: false, reason: "That clip is gone" };
      try {
        options.files.remove(item);
      } catch {
        return { ok: false, reason: "Saarathi could not remove that file" };
      }
      ctx.setState((state) => ({
        items: state.items.filter((candidate) => candidate.id !== item.id),
        active: state.active?.itemId === item.id ? null : state.active,
      }));
      void advance(ctx);
      return { ok: true, value: undefined };
    },
    asset(itemId, key) {
      const item = context?.state.speech?.id === itemId
        ? context.state.speech
        : context?.state.items.find((candidate) => candidate.id === itemId);
      if (!item || item.assetKey !== key || !options.files.exists(item)) return null;
      return { item, path: options.files.path(item) };
    },
  };
}

function makeItem(
  upload: MediaUpload,
  generated: { id: string; assetKey: string; now: number },
): MediaResult<MediaItem> {
  const label = typeof upload.label === "string" ? upload.label.trim() : "";
  if (!label) return { ok: false, reason: "Give the clip a name" };
  if (label.length > MAX_LABEL) return { ok: false, reason: `Keep the clip name under ${MAX_LABEL} characters` };
  if (typeof upload.mime !== "string" || !(upload.mime in MEDIA_TYPES)) {
    return { ok: false, reason: "Use an MP3, WAV, OGG, MP4, WebM, GIF, PNG, JPG or WebP file" };
  }
  if (upload.data.length === 0) return { ok: false, reason: "That file is empty" };
  if (upload.data.length > MAX_MEDIA_BYTES) {
    return { ok: false, reason: `Keep media under ${Math.floor(MAX_MEDIA_BYTES / 1024 / 1024)} MB` };
  }
  const inspected = inspectMedia(upload.data);
  if (!inspected || inspected.mime !== upload.mime) {
    return { ok: false, reason: "That file does not match its media type" };
  }
  const durationMs = inspected.durationMs;
  if (!Number.isInteger(durationMs) || durationMs < MIN_DURATION_MS || durationMs > MAX_MEDIA_DURATION_MS) {
    return { ok: false, reason: "Keep playback between half a second and 30 seconds" };
  }
  const volume = Number(upload.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    return { ok: false, reason: "Volume has to be between silent and full" };
  }
  const mime = inspected.mime;
  return {
    ok: true,
    value: {
      id: generated.id,
      assetKey: generated.assetKey,
      label,
      mime,
      kind: MEDIA_TYPES[mime].kind,
      bytes: upload.data.length,
      durationMs,
      volume,
      addedAt: generated.now,
    },
  };
}
