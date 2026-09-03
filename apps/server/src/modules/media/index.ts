import { randomBytes, randomUUID } from "node:crypto";
import {
  MAX_MEDIA_BYTES,
  MAX_MEDIA_DURATION_MS,
  MAX_MEDIA_ITEMS,
  MEDIA_ID,
  MEDIA_TYPES,
  type GameModuleDef,
  type MediaItem,
  type MediaState,
  type ModuleContext,
} from "@saarathi/shared";
import type { MediaFiles } from "./files.js";
import { inspectMedia } from "./inspect.js";

const MAX_LABEL = 48;
const MIN_DURATION_MS = 500;

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
  module: GameModuleDef<MediaState>;
  add(upload: MediaUpload): MediaResult<MediaItem>;
  remove(id: string): MediaResult;
  asset(id: string, key: string): { item: MediaItem; path: string } | null;
}

export interface MediaOptions {
  files: MediaFiles;
  now?: () => number;
  id?: () => string;
  assetKey?: () => string;
}

/** The media library and its one server-timed playback lane. */
export function createMedia(options: MediaOptions): MediaController {
  const now = options.now ?? Date.now;
  const id = options.id ?? randomUUID;
  const assetKey = options.assetKey ?? (() => randomBytes(18).toString("base64url"));
  let context: ModuleContext<MediaState> | null = null;

  const module: GameModuleDef<MediaState> = {
    id: MEDIA_ID,
    title: "Media",
    overlay: true,
    initialState: { items: [], active: null },
    // Her library survives. Playback does not: a server restart stops the lane
    // rather than claiming a clip is still audible after the process died.
    persist: ["items"],

    actions: {
      play: {
        label: "Play a clip",
        needsArgs: true,
        run(input, ctx) {
          const item = ctx.state.items.find((candidate) => candidate.id === input.args[0]);
          if (!item) return ctx.refuse("That clip is gone");
          const startedAt = now();
          const cue = {
            id: id(),
            itemId: item.id,
            startedAt,
            endsAt: startedAt + item.durationMs,
          };
          // Replacing is the v1 queue policy. The old timer may still wake up,
          // but the cue id stops it from clearing the replacement.
          ctx.setState({ active: cue });
          ctx.after(item.durationMs, () => {
            if (ctx.state.active?.id === cue.id) ctx.setState({ active: null });
          });
        },
      },
      stop: {
        label: "Stop all media",
        run(_input, ctx) {
          if (!ctx.state.active) return ctx.refuse("Nothing is playing");
          ctx.setState({ active: null });
        },
      },
    },

    setup(ctx) {
      context = ctx;
      const present = ctx.state.items.filter((item) => options.files.exists(item));
      if (present.length !== ctx.state.items.length) ctx.setState({ items: present });
    },

    teardown(ctx) {
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
      return { ok: true, value: undefined };
    },
    asset(itemId, key) {
      const item = context?.state.items.find((candidate) => candidate.id === itemId);
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
