import { DEFAULT_IMAGE_DURATION_MS, type MediaMime } from "@saarathi/shared";

export interface InspectedMedia {
  mime: MediaMime;
  durationMs: number;
}

/** Read the file itself. Browser metadata is a preview, never authority. */
export function inspectMedia(data: Buffer): InspectedMedia | null {
  const image = imageMime(data);
  if (image) return { mime: image, durationMs: DEFAULT_IMAGE_DURATION_MS };
  if (ascii(data, 0, "RIFF") && ascii(data, 8, "WAVE")) {
    return duration("audio/wav", wavDuration(data));
  }
  if (ascii(data, 0, "OggS")) {
    const ogg = oggDuration(data);
    return ogg ? duration(ogg.mime, ogg.durationMs) : null;
  }
  if (ascii(data, 4, "ftyp")) return duration("video/mp4", mp4Duration(data));
  if (data.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    return duration("video/webm", webmDuration(data));
  }
  return duration("audio/mpeg", mp3Duration(data));
}

function duration(mime: MediaMime, durationMs: number | null): InspectedMedia | null {
  return durationMs === null || !Number.isFinite(durationMs)
    ? null
    : { mime, durationMs: Math.round(durationMs) };
}

function imageMime(data: Buffer): MediaMime | null {
  if (
    data.length >= 45 &&
    data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    data.readUInt32BE(8) === 13 && ascii(data, 12, "IHDR") &&
    data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0 &&
    data.readUInt32BE(data.length - 12) === 0 && ascii(data, data.length - 8, "IEND")
  ) {
    return "image/png";
  }
  if (
    data.length >= 16 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff &&
    data[data.length - 2] === 0xff && data[data.length - 1] === 0xd9 && hasJpegFrame(data)
  ) return "image/jpeg";
  if (
    data.length >= 14 && (ascii(data, 0, "GIF87a") || ascii(data, 0, "GIF89a")) &&
    data.readUInt16LE(6) > 0 && data.readUInt16LE(8) > 0 && data[data.length - 1] === 0x3b
  ) return "image/gif";
  if (
    data.length >= 20 && ascii(data, 0, "RIFF") && ascii(data, 8, "WEBP") &&
    data.readUInt32LE(4) + 8 === data.length && ["VP8 ", "VP8L", "VP8X"].some((kind) => ascii(data, 12, kind))
  ) return "image/webp";
  return null;
}

function hasJpegFrame(data: Buffer): boolean {
  let offset = 2;
  while (offset + 4 <= data.length - 2) {
    if (data[offset] !== 0xff) return false;
    while (data[offset] === 0xff) offset++;
    const marker = data[offset++]!;
    if (marker === 0xd9 || marker === 0xda) return false;
    const size = data.readUInt16BE(offset);
    if (size < 2 || offset + size > data.length) return false;
    if (marker >= 0xc0 && marker <= 0xc3 && size >= 8) {
      return data.readUInt16BE(offset + 3) > 0 && data.readUInt16BE(offset + 5) > 0;
    }
    offset += size;
  }
  return false;
}

function wavDuration(data: Buffer): number | null {
  let offset = 12;
  let byteRate = 0;
  let bytes = 0;
  while (offset + 8 <= data.length) {
    const size = data.readUInt32LE(offset + 4);
    const end = offset + 8 + size;
    if (end > data.length) return null;
    if (ascii(data, offset, "fmt ") && size >= 16) byteRate = data.readUInt32LE(offset + 16);
    if (ascii(data, offset, "data")) bytes += size;
    offset = end + (size % 2);
  }
  return byteRate > 0 && bytes > 0 ? bytes / byteRate * 1_000 : null;
}

function oggDuration(data: Buffer): { mime: "audio/ogg"; durationMs: number } | null {
  let offset = 0;
  let sampleRate = 0;
  let preSkip = 0;
  let lastGranule = 0n;
  while (offset + 27 <= data.length) {
    if (!ascii(data, offset, "OggS")) return null;
    const segments = data[offset + 26]!;
    if (offset + 27 + segments > data.length) return null;
    let bodySize = 0;
    for (let i = 0; i < segments; i++) bodySize += data[offset + 27 + i]!;
    const body = offset + 27 + segments;
    const end = body + bodySize;
    if (end > data.length) return null;
    if (offset === 0) {
      if (ascii(data, body, "OpusHead") && bodySize >= 19) {
        sampleRate = 48_000;
        preSkip = data.readUInt16LE(body + 10);
      } else if (data[body] === 1 && ascii(data, body + 1, "vorbis") && bodySize >= 16) {
        sampleRate = data.readUInt32LE(body + 12);
      } else {
        return null;
      }
    }
    const granule = data.readBigUInt64LE(offset + 6);
    if (granule !== 0xffff_ffff_ffff_ffffn) lastGranule = granule;
    offset = end;
  }
  if (offset !== data.length || sampleRate <= 0 || lastGranule <= BigInt(preSkip)) return null;
  return {
    mime: "audio/ogg",
    durationMs: Number(lastGranule - BigInt(preSkip)) / sampleRate * 1_000,
  };
}

function mp4Duration(data: Buffer): number | null {
  const movie = findMp4Box(data, 0, data.length, "mvhd", 0);
  if (movie === null || movie + 20 > data.length) return null;
  const version = data[movie];
  if (version === 0) {
    const timescale = data.readUInt32BE(movie + 12);
    const ticks = data.readUInt32BE(movie + 16);
    return timescale > 0 ? ticks / timescale * 1_000 : null;
  }
  if (version === 1 && movie + 32 <= data.length) {
    const timescale = data.readUInt32BE(movie + 20);
    const ticks = data.readBigUInt64BE(movie + 24);
    return timescale > 0 ? Number(ticks) / timescale * 1_000 : null;
  }
  return null;
}

const MP4_CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "edts", "udta", "meta"]);

function findMp4Box(
  data: Buffer,
  start: number,
  limit: number,
  wanted: string,
  depth: number,
): number | null {
  if (depth > 8) return null;
  let offset = start;
  while (offset + 8 <= limit) {
    let size = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > limit) return null;
      const wide = data.readBigUInt64BE(offset + 8);
      if (wide > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(wide);
      header = 16;
    } else if (size === 0) {
      size = limit - offset;
    }
    if (size < header || offset + size > limit) return null;
    const content = offset + header + (type === "meta" ? 4 : 0);
    if (type === wanted) return content;
    if (MP4_CONTAINERS.has(type)) {
      const found = findMp4Box(data, content, offset + size, wanted, depth + 1);
      if (found !== null) return found;
    }
    offset += size;
  }
  return null;
}

function webmDuration(data: Buffer): number | null {
  if (data.indexOf(Buffer.from("webm")) < 0) return null;
  const scaleAt = data.indexOf(Buffer.from([0x2a, 0xd7, 0xb1]));
  const durationAt = data.indexOf(Buffer.from([0x44, 0x89]));
  const scale = scaleAt < 0 ? 1_000_000 : readEbmlUnsigned(data, scaleAt + 3);
  const ticks = durationAt < 0 ? null : readEbmlFloat(data, durationAt + 2);
  return scale === null || ticks === null ? null : ticks * scale / 1_000_000;
}

function readEbmlUnsigned(data: Buffer, offset: number): number | null {
  const value = readEbmlPayload(data, offset);
  if (!value || value.size > 6) return null;
  let out = 0;
  for (let i = 0; i < value.size; i++) out = out * 256 + data[value.offset + i]!;
  return out;
}

function readEbmlFloat(data: Buffer, offset: number): number | null {
  const value = readEbmlPayload(data, offset);
  if (!value) return null;
  if (value.size === 4) return data.readFloatBE(value.offset);
  if (value.size === 8) return data.readDoubleBE(value.offset);
  return null;
}

function readEbmlPayload(data: Buffer, offset: number): { offset: number; size: number } | null {
  const first = data[offset];
  if (!first) return null;
  let width = 1;
  let marker = 0x80;
  while (width <= 8 && !(first & marker)) {
    width++;
    marker >>= 1;
  }
  if (width > 8 || offset + width > data.length) return null;
  let size = first & (marker - 1);
  for (let i = 1; i < width; i++) size = size * 256 + data[offset + i]!;
  const payload = offset + width;
  return payload + size <= data.length ? { offset: payload, size } : null;
}

const MPEG1 = [
  [],
  [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
] as const;
const MPEG2 = [
  [],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
] as const;

function mp3Duration(data: Buffer): number | null {
  let offset = id3Size(data);
  const last = ascii(data, data.length - 128, "TAG") ? data.length - 128 : data.length;
  let frames = 0;
  let seconds = 0;
  while (offset + 4 <= last) {
    const frame = mpegFrame(data, offset);
    if (!frame) {
      if (frames > 0 || offset - id3Size(data) > 4_096) return null;
      offset++;
      continue;
    }
    frames++;
    seconds += frame.samples / frame.sampleRate;
    offset += frame.bytes;
  }
  return frames >= 2 && offset === last ? seconds * 1_000 : null;
}

function id3Size(data: Buffer): number {
  if (!ascii(data, 0, "ID3") || data.length < 10) return 0;
  const size = ((data[6]! & 0x7f) << 21) | ((data[7]! & 0x7f) << 14) |
    ((data[8]! & 0x7f) << 7) | (data[9]! & 0x7f);
  return Math.min(data.length, 10 + size);
}

function mpegFrame(data: Buffer, offset: number): { bytes: number; samples: number; sampleRate: number } | null {
  const bits = data.readUInt32BE(offset);
  if ((bits >>> 21) !== 0x7ff) return null;
  const version = (bits >>> 19) & 3;
  const layer = (bits >>> 17) & 3;
  const bitrateIndex = (bits >>> 12) & 15;
  const rateIndex = (bits >>> 10) & 3;
  if (version === 1 || layer === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const bitrate = (version === 3 ? MPEG1 : MPEG2)[layer]?.[bitrateIndex] ?? 0;
  const divisor = version === 3 ? 1 : version === 2 ? 2 : 4;
  const sampleRate = [44_100, 48_000, 32_000][rateIndex]! / divisor;
  const padding = (bits >>> 9) & 1;
  const samples = layer === 3 ? 384 : layer === 2 || version === 3 ? 1_152 : 576;
  const coefficient = layer === 3 ? 12 : layer === 1 && version !== 3 ? 72 : 144;
  const bytes = Math.floor(coefficient * bitrate * 1_000 / sampleRate + padding) * (layer === 3 ? 4 : 1);
  return bitrate > 0 && offset + bytes <= data.length ? { bytes, samples, sampleRate } : null;
}

function ascii(data: Buffer, offset: number, expected: string): boolean {
  return offset >= 0 && offset + expected.length <= data.length &&
    data.toString("ascii", offset, offset + expected.length) === expected;
}
