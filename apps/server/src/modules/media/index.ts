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
  PAID_TIER_SAMPLES,
  knownTier,
  MEDIA_TYPES,
  type AlertLevel,
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
import { paidMessage, paidSpeech, type SpeechVoice } from "./speech.js";
import { defaultLevels, levelOf, parseLevels, restoreLevels, sizeOf } from "./levels.js";
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

/** Long enough to read, and longer the bigger it is drawn. */
const alertMs = (size: number) => PAID_ALERT_MS + PAID_ALERT_TIER_MS * (size - 1);

/** Where a paid message sits on her levels as they are now, and so how big it is drawn. */
const placed = (levels: readonly AlertLevel[], tier: number | undefined) => {
  const level = levelOf(levels, tier);
  return { level, size: sizeOf(level, levels.length) };
};

/** What the cue past an intro, or a cue with no intro, carries besides its clip. */
type CueExtra = Pick<MediaCue, "paidId" | "sample" | "introFor" | "level" | "size">;

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
  // Messages whose level intro has played, so a read she cut short with a
  // clip does not open with it twice. In memory on purpose: after a restart a
  // message is shown again from the start, and that includes its intro.
  const introDone = new Set<string>();
  // Messages whose voice failed this time round. They are shown silently
  // rather than sent to a voice that just failed a second time.
  const voiceFailed = new Set<string>();

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
   * Throw the voice away, and keep the queue. A voice she changed, speech
   * switched off or on, Stop and the module stopping end up here: none of
   * them is a decision about anybody's message, so the one being read stays
   * at the head and is read again in full, in whatever voice is set now. That
   * is also why a voice that failed is tried again: it may be fixed.
   *
   * A clip she presses does not come here. It goes over whatever is on and
   * keeps the voice already made, so nothing is synthesised twice.
   */
  const interrupt = (ctx: ModuleContext<MediaModuleState>) => {
    epoch++;
    generation?.abort();
    generation = null;
    if (ctx.state.speech && ctx.state.active?.itemId === ctx.state.speech.id) ctx.setState({ active: null });
    clearSpeech(ctx);
    voiceFailed.clear();
  };

  /**
   * Everything the lane remembers about the messages it has met, all of it in
   * memory. Stop forgets it, and so does the module stopping: switched back
   * on, it starts each message from the top, intro included, as a restart does.
   */
  const forget = () => {
    stopPicking();
    unpicked.clear();
    introDone.clear();
    voiceFailed.clear();
    testWaiting = false;
    testStyle = undefined;
  };

  /** Her Stop: the one way the queue is meant to empty. */
  const cancelSpeech = (ctx: ModuleContext<MediaModuleState>) => {
    interrupt(ctx);
    forget();
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
    introDone.delete(paidId);
    voiceFailed.delete(paidId);
    ctx.setState((state) => ({
      paid: state.paid.filter((message) => message.id !== paidId),
      paidViewers: state.paidViewers.filter(([id]) => id !== paidId),
    }));
  };

  /** The one way anything gets on the lane. */
  const startCue = (ctx: ModuleContext<MediaModuleState>, itemId: string | null, durationMs: number, extra: CueExtra = {}) => {
    const startedAt = now();
    const cue: MediaCue = { id: id(), itemId, startedAt, endsAt: startedAt + durationMs, ...extra };
    // Replacing is the v1 queue policy. The old timer may still wake up,
    // but the cue id stops it from ending the replacement.
    ctx.setState({ active: cue });
    ctx.after(durationMs, () => {
      if (ctx.state.active?.id === cue.id) endCue(ctx, cue);
    });
  };

  /**
   * And the one way it comes off, however it ended: running out, her skipping
   * an intro, or its clip being removed. An intro hands on to whatever it came
   * before. Anything else is done with, and the lane moves on.
   */
  const endCue = (ctx: ModuleContext<MediaModuleState>, cue: MediaCue) => {
    if (ctx.state.active?.id === cue.id) ctx.setState({ active: null });
    if (cue.introFor) return afterIntro(ctx, cue);
    if (cue.itemId && cue.itemId === ctx.state.speech?.id) clearSpeech(ctx);
    finished(ctx, cue.paidId ?? null);
    ctx.setState({ ttsStatus: voiceStatus(ctx.state) });
    void advance(ctx);
  };

  /** The clip her level plays first, if it has one and it is still in her library. */
  const introOf = (state: Readonly<MediaModuleState>, tier: number | undefined) => {
    const introId = state.alertLevels[levelOf(state.alertLevels, tier) - 1]?.introId;
    return introId ? state.items.find((item) => item.id === introId) : undefined;
  };

  /**
   * Put this message's intro on the lane, if its level has one it has not
   * played yet. True when it did: the intro's own ending carries on from there.
   */
  const playIntro = (ctx: ModuleContext<MediaModuleState>, message: PaidMessage) => {
    if (introDone.has(message.id)) return false;
    const clip = introOf(ctx.state, message.tier);
    if (!clip) return false;
    startCue(ctx, clip.id, clip.durationMs, { introFor: message.id, ...placed(ctx.state.alertLevels, message.tier) });
    ctx.setState({ ttsStatus: `Playing the intro for ${message.name}` });
    return true;
  };

  /**
   * An intro is over. Whatever it came before goes on next: a preview's
   * sample, or the message, read in the voice made while the intro played.
   */
  const afterIntro = (ctx: ModuleContext<MediaModuleState>, cue: MediaCue) => {
    if (cue.sample) return showSample(ctx, cue.sample);
    if (cue.introFor) introDone.add(cue.introFor);
    void advance(ctx);
  };

  /** A preview's alert, placed the way a real one on its level would be. */
  const showSample = (ctx: ModuleContext<MediaModuleState>, sample: PaidMessage) => {
    const where = placed(ctx.state.alertLevels, sample.tier);
    startCue(ctx, null, alertMs(where.size), { sample, ...where });
  };

  /**
   * Speech made already and held, through an intro or a clip she pressed.
   * Its message's intro goes first if that has not played, and been cut
   * short by her clip counts as not played.
   */
  const resume = (ctx: ModuleContext<MediaModuleState>) => {
    const head = ctx.state.paid[0];
    if (head && speaking === head.id && playIntro(ctx, head)) return;
    void speak(ctx, epoch);
  };

  /** Play the speech that is ready. A failure shows the message silently, never drops it. */
  const speak = async (ctx: ModuleContext<MediaModuleState>, started: number) => {
    const paidId = speaking;
    const result = ctx.state.speech ? await ctx.invoke("play", { args: [ctx.state.speech.id] }) : { ok: false };
    if (started !== epoch) return;
    if (result.ok) {
      ctx.setState({ ttsStatus: "Reading a paid message" });
      return;
    }
    clearSpeech(ctx);
    ctx.setState({ ttsStatus: "Could not read that message. Try Test voice again." });
    if (paidId) voiceFailed.add(paidId);
    void advance(ctx);
  };

  /**
   * Put the next thing on the lane, if it is free, and get its voice ready.
   * Every path that frees the lane, and every path that finishes a voice,
   * calls this. A paid message is shown whether or not it can be heard:
   * speech off, no voice on this machine and a voice that failed all still
   * put the name and the amount on her stream.
   *
   * A level's intro goes on first, at once. It needs neither Claude nor the
   * voice, so both are worked on while it plays rather than before it, and
   * the screen is never empty while a paid message waits on either.
   */
  const advance = async (ctx: ModuleContext<MediaModuleState>) => {
    if (generation) return;
    const active = ctx.state.active;
    // The head's own intro is the one thing its voice is made behind.
    const behindIntro = Boolean(active?.introFor && !active.sample && active.introFor === ctx.state.paid[0]?.id);
    if (active && !behindIntro) return;
    if (ctx.state.speech) {
      // The intro's ending comes back here and finds the lane free.
      if (!behindIntro) resume(ctx);
      return;
    }
    const voiced = ctx.state.ttsEnabled && ready(ctx);
    if (!voiced) testWaiting = false;
    // A test phrase jumps the queue, but not an intro that is already on.
    const test = testWaiting && !behindIntro;
    const head = test ? null : ctx.state.paid[0];
    if (!test && !head) return;
    if (head && held(ctx.state, head)) {
      ctx.setState({ ttsStatus: `${head.name}'s message is waiting for you to check` });
      return;
    }
    if (test) testWaiting = false;
    const onIntro = behindIntro || Boolean(head && playIntro(ctx, head));
    if (head && (!voiced || voiceFailed.has(head.id))) {
      if (onIntro) return;
      const where = placed(ctx.state.alertLevels, head.tier);
      return startCue(ctx, null, alertMs(where.size), { paidId: head.id, ...where });
    }
    // Usually chosen while the one before was playing. When it is not, the
    // pick's own ending calls back in here.
    if (head && needsPick(ctx.state, head)) {
      if (!onIntro) ctx.setState({ ttsStatus: "Choosing a voice…" });
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
    if (!onIntro) ctx.setState({ ttsStatus: "Preparing speech…" });
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
      // Held while the intro, or a clip she pressed, is still on: whichever
      // ends calls back into advance, which reads it then.
      if (!ctx.state.active) resume(ctx);
    } catch (error) {
      if (started !== epoch) return;
      generation = null;
      clearSpeech(ctx);
      ctx.setState({ ttsStatus: error instanceof SpeechError ? error.message : "Could not read that message. Try Test voice again." });
      // Shown without a voice rather than dropped: the voice failed, the
      // message did not.
      if (paidId) voiceFailed.add(paidId);
      void advance(ctx);
    }
  };

  const module: GameModuleDef<MediaModuleState> = {
    id: MEDIA_ID,
    title: "Media",
    overlay: true,
    initialState: { items: [], active: null, speech: null, ttsEnabled: true, paid: [], checkFirst: false, ttsStatus: voiceStatus(),
      speechProvider: "system", speechRegion: "centralindia", speechKey: "", hasSpeechKey: false,
      pickVoices: false, pickerStatus: pickerOff, viewerVoices: [], rememberedVoices: 0, paidViewers: [],
      alertTheme: "card", alertPosition: "top", alertLevels: defaultLevels() },
    // Her library survives. Playback does not: a server restart stops the lane
    // rather than claiming a clip is still audible after the process died. The
    // paid queue survives too, and its head is read again from the start.
    persist: ["items", "ttsEnabled", "paid", "checkFirst", "speechProvider", "speechRegion", "speechKey", "pickVoices",
      "viewerVoices", "paidViewers", "alertTheme", "alertPosition", "alertLevels"],
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
          // Her clip goes over whatever is on, and the message under it keeps
          // its turn and its voice: once the clip ends it is read again in
          // full, its intro too if the clip cut that short.
          if (item.id !== ctx.state.speech?.id) return startCue(ctx, item.id, item.durationMs);
          const paidId = speaking;
          const message = paidId ? ctx.state.paid.find((candidate) => candidate.id === paidId) : undefined;
          if (!paidId) return startCue(ctx, item.id, item.durationMs);
          const where = placed(ctx.state.alertLevels, message?.tier);
          startCue(ctx, item.id, Math.max(item.durationMs, alertMs(where.size)), { paidId, ...where });
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
      // Takes the whole list, the way her deck does, so no save can leave
      // her levels half-edited with a gap or an overlap between them.
      alertLevels: {
        label: "Paid alert levels",
        needsArgs: true,
        run(input, ctx) {
          let raw: unknown;
          try { raw = JSON.parse(input.args[0] ?? ""); } catch { return ctx.refuse("Those levels could not be read"); }
          const levels = parseLevels(raw, new Set(ctx.state.items.map((item) => item.id)));
          if (typeof levels === "string") return ctx.refuse(levels);
          ctx.setState({ alertLevels: levels });
        },
      },
      // Without an argument, so a deck button or a hotkey can skip whichever
      // intro is on. The message it came before goes on as if it had ended.
      skipIntro: {
        label: "Skip the intro",
        run(_input, ctx) {
          const cue = ctx.state.active;
          if (!cue?.introFor) return ctx.refuse("No intro is playing");
          endCue(ctx, cue);
        },
      },
      // Silent, and only on a free lane: a preview never pushes a real
      // message off the screen, and a real one that arrives meanwhile waits
      // a few seconds, the same as it would behind any clip. It plays the
      // level's intro first, because that is the part she is checking.
      previewAlert: {
        label: "Preview a paid alert",
        needsArgs: true,
        run(input, ctx) {
          const level = Number(input.args[0]);
          const levels = ctx.state.alertLevels;
          if (!Number.isInteger(level) || level < 1 || level > levels.length) return ctx.refuse(`Choose a level from 1 to ${levels.length}`);
          if (ctx.state.active || generation || ctx.state.speech) return ctx.refuse("Wait for what is on screen to finish");
          const tier = levels[level - 1]!.from;
          const sample: PaidMessage = {
            id: `preview-${id()}`,
            at: now(),
            name: "Preview",
            amount: PAID_TIER_SAMPLES[tier - 1]!,
            text: "This is how a paid message on this level looks on your stream.",
            tier,
          };
          const clip = introOf(ctx.state, tier);
          if (clip) startCue(ctx, clip.id, clip.durationMs, { sample, introFor: sample.id, ...placed(levels, tier) });
          else showSample(ctx, sample);
        },
      },
      // Her way off a preview that keeps whoever paid while she was placing
      // it: the queue carries on as if the preview had run out. Not Stop,
      // because Stop is her panic button on the deck and a hotkey, and a
      // panic button that puts the next paid message on stream is not one.
      // Takes the preview's id so it never reaches a deck, where nothing
      // starts a preview, and so a late tap cannot end a different one.
      endPreview: {
        label: "End the preview",
        needsArgs: true,
        run(input, ctx) {
          const sample = ctx.state.active?.sample;
          if (!sample || sample.id !== input.args[0]) return ctx.refuse("No preview is playing");
          ctx.setState({ active: null });
          void advance(ctx);
        },
      },
      stop: {
        label: "Stop all media",
        run(_input, ctx) {
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
      const clipIds = new Set(ctx.state.items.filter((item) => options.files.exists(item)).map((item) => item.id));
      const paidViewers = ctx.state.paidViewers.filter(([messageId]) => paid.some((message) => message.id === messageId));
      ctx.setState({ paid, viewerVoices, paidViewers, hasSpeechKey: Boolean(ctx.state.speechKey), ttsStatus: voiceStatus(ctx.state),
        rememberedVoices: viewerVoices.length, pickerStatus: ctx.state.pickVoices ? pickerOn : pickerOff,
        alertTheme: knownTheme(ctx.state.alertTheme) ? ctx.state.alertTheme : "card",
        alertPosition: knownPosition(ctx.state.alertPosition) ? ctx.state.alertPosition : "top",
        alertLevels: restoreLevels(ctx.state.alertLevels, clipIds) });
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
      forget();
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
      const cue = ctx.state.active;
      // A level that opened with this clip now opens with nothing, rather
      // than pointing at a file that is gone.
      ctx.setState((state) => ({
        items: state.items.filter((candidate) => candidate.id !== item.id),
        active: state.active?.itemId === item.id ? null : state.active,
        alertLevels: state.alertLevels.map((level) => level.introId === item.id ? { from: level.from } : level),
      }));
      if (cue?.itemId === item.id) endCue(ctx, cue);
      else void advance(ctx);
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
