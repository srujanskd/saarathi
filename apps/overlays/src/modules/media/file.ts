import {
  DEFAULT_IMAGE_DURATION_MS,
  MAX_MEDIA_DURATION_MS,
  MEDIA_TYPES,
  type MediaMime,
} from "@saarathi/shared";

export interface InspectedMedia {
  durationMs: number;
  mime: MediaMime;
}

export async function inspectMedia(file: File): Promise<InspectedMedia | null> {
  if (!(file.type in MEDIA_TYPES)) return null;
  const mime = file.type as MediaMime;
  if (MEDIA_TYPES[mime].kind === "image") {
    return { mime, durationMs: DEFAULT_IMAGE_DURATION_MS };
  }

  const element = document.createElement(MEDIA_TYPES[mime].kind);
  const url = URL.createObjectURL(file);
  element.preload = "metadata";
  element.src = url;
  try {
    const duration = await new Promise<number>((resolve, reject) => {
      element.onloadedmetadata = () => resolve(element.duration);
      element.onerror = () => reject(new Error("metadata"));
    });
    const durationMs = Math.round(duration * 1000);
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > MAX_MEDIA_DURATION_MS) {
      return null;
    }
    return { mime, durationMs };
  } catch {
    return null;
  } finally {
    element.removeAttribute("src");
    element.load();
    URL.revokeObjectURL(url);
  }
}
