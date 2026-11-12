import { randomBytes, randomUUID } from "node:crypto";
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_DURATION_MS,
  MAX_MEDIA_ITEMS,
  MAX_PAID_QUEUE,
  MEDIA_ID,
  PAID_ALERT_MS,
  MEDIA_TYPES,
  type GameModuleDef,
  type MediaCue,
  type MediaItem,
  type MediaState,
  type ModuleContext,
} from "@saarathi/shared";
import type { MediaFiles } from "./files.js";
import { paidMessage, paidSpeech, type SpeechVoice } from "./speech.js";
import { microsoftVoice, SpeechError, validSpeechRegion, type MicrosoftVoice } from "./microsoft-speech.js";
import { inspectMedia } from "./inspect.js";

const MAX_LABEL = 48;
const MIN_DURATION_MS = 500;
type MediaModuleState = MediaState & { speechKey: string };

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
    testWaiting = false;
    if (ctx.state.paid.length > 0) ctx.setState({ paid: [] });
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

  const ready = (ctx: ModuleContext<MediaModuleState>) => ctx.state.speechProvider === "microsoft"
    ? Boolean(ctx.state.speechKey) : Boolean(options.voice);

  const finished = (ctx: ModuleContext<MediaModuleState>, paidId: string | null) => {
    if (paidId) ctx.setState((state) => ({ paid: state.paid.filter((message) => message.id !== paidId) }));
  };

  /** The one way anything gets on the lane, and the one way it comes off. */
  const startCue = (ctx: ModuleContext<MediaModuleState>, itemId: string | null, durationMs: number, paidId: string | null) => {
    const startedAt = now();
    const cue: MediaCue = { id: id(), itemId, startedAt, endsAt: startedAt + durationMs, ...(paidId ? { paidId } : {}) };
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
    testWaiting = false;
    if (head && !voiced) return startCue(ctx, null, PAID_ALERT_MS, head.id);
    const microsoft = ctx.state.speechProvider === "microsoft";
    const text = head ? paidSpeech(head, microsoft ? "kn" : "en")
      : microsoft ? "ಮನೆಯ ಸದಸ್ಯರೇ, ನಿಮ್ಮ ಬೆಂಬಲಕ್ಕೆ ಧನ್ಯವಾದಗಳು. ಮುಂದಿನ ಸವಾಲಿಗೆ ಸಿದ್ಧರಾಗಿ!"
        : "Thank you for supporting the stream!";
    const paidId = head?.id ?? null;
    const started = epoch;
    const controller = new AbortController();
    generation = controller;
    ctx.setState({ ttsStatus: "Preparing speech…" });
    try {
      const data = microsoft
        ? await cloudVoice(text, controller.signal, { key: ctx.state.speechKey, region: ctx.state.speechRegion })
        : await options.voice!(text, controller.signal);
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
      if (paidId) startCue(ctx, null, PAID_ALERT_MS, paidId);
      else void advance(ctx);
    }
  };

  const module: GameModuleDef<MediaModuleState> = {
    id: MEDIA_ID,
    title: "Media",
    overlay: true,
    initialState: { items: [], active: null, speech: null, ttsEnabled: true, paid: [], ttsStatus: voiceStatus(),
      speechProvider: "system", speechRegion: "centralindia", speechKey: "", hasSpeechKey: false },
    // Her library survives. Playback does not: a server restart stops the lane
    // rather than claiming a clip is still audible after the process died. The
    // paid queue survives too, and its head is read again from the start.
    persist: ["items", "ttsEnabled", "paid", "speechProvider", "speechRegion", "speechKey"],
    serverOnly: ["speechKey"],

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
      testVoice: {
        label: "Test voice",
        run(_input, ctx) {
          if (!ready(ctx)) return ctx.refuse(voiceStatus(ctx.state));
          if (!ctx.state.ttsEnabled) return ctx.refuse("Turn paid-message speech on first");
          if (testWaiting) return ctx.refuse("Test voice is already waiting");
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
          startCue(ctx, item.id, paidId ? Math.max(item.durationMs, PAID_ALERT_MS) : item.durationMs, paidId);
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
      ctx.setState({ hasSpeechKey: Boolean(ctx.state.speechKey), ttsStatus: voiceStatus(ctx.state) });
      ctx.on("paid-event", (event) => {
        if (ctx.state.paid.length >= MAX_PAID_QUEUE) {
          ctx.setState({ ttsStatus: "Paid message queue is full. New messages are being skipped." });
          return;
        }
        ctx.setState((state) => ({ paid: [...state.paid, paidMessage(event, id())] }));
        void advance(ctx);
      });
      context = ctx;
      const present = ctx.state.items.filter((item) => options.files.exists(item));
      if (present.length !== ctx.state.items.length) ctx.setState({ items: present });
      // Whatever was waiting when the server last stopped is still owed.
      void advance(ctx);
    },

    teardown(ctx) {
      interrupt(ctx);
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
