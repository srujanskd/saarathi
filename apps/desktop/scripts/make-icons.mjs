import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The app icon, drawn rather than converted. apps/overlays/public/icon.svg is
 * the mark, but turning an SVG into a PNG needs a rasterizer that is on
 * nobody's machine by default and on neither CI runner, and the alternative is
 * committing a binary nobody can regenerate. So this redraws the same four
 * shapes with supersampled coverage and writes the PNGs and the .ico itself.
 *
 * Outputs are committed. Rerun it only when the mark changes -- and change the
 * SVG too, because that one is what her phone shows on its home screen.
 */

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "resources");
const BG = [0x14, 0x15, 0x1a];
const FG = [0x4a, 0xde, 0x80];
const SS = 4; // subsamples per axis

/** Everything below is in the SVG's 32-unit space, so the two stay in step. */
function coverage(x, y, size) {
  const u = (x / size) * 32;
  const v = (y / size) * 32;
  const dx = u - 16;
  const dy = v - 16;
  const d = Math.hypot(dx, dy);

  // The ring, the hub, and the four ticks.
  if (Math.abs(d - 11) <= 1.25) return "fg";
  if (d <= 3) return "fg";
  const tick = (a, b, c, e) => onSegment(u, v, a, b, c, e, 1);
  if (tick(16, 5, 16, 11) || tick(16, 21, 16, 27)) return "fg";
  if (tick(5, 16, 11, 16) || tick(21, 16, 27, 16)) return "fg";

  // The rounded square behind them.
  const r = 8;
  const qx = Math.abs(u - 16) - (16 - r);
  const qy = Math.abs(v - 16) - (16 - r);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - r;
  return outside <= 0 ? "bg" : "none";
}

function onSegment(px, py, x1, y1, x2, y2, half) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const len2 = vx * vx + vy * vy;
  const t = Math.max(0, Math.min(1, ((px - x1) * vx + (py - y1) * vy) / len2));
  return Math.hypot(px - (x1 + t * vx), py - (y1 + t * vy)) <= half;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let fg = 0;
      let bg = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const hit = coverage(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
          if (hit === "fg") fg++;
          else if (hit === "bg") bg++;
        }
      }
      const total = SS * SS;
      const alpha = (fg + bg) / total;
      const i = (y * size + x) * 4;
      if (alpha === 0) continue;
      // Composite the mark over the plate first, then carry one alpha, so the
      // rounded corners stay clean instead of fringing dark on a light taskbar.
      const mix = fg / (fg + bg);
      for (let c = 0; c < 3; c++) pixels[i + c] = Math.round(FG[c] * mix + BG[c] * (1 - mix));
      pixels[i + 3] = Math.round(alpha * 255);
    }
  }
  return pixels;
}

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function png(size) {
  const pixels = render(size);
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico is a directory of PNGs, which is why this is six lines and not a
 * dependency. 256 is written as 0, per the format. */
function ico(sizes) {
  const images = sizes.map((size) => png(size));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = 6 + sizes.length * 16;
  const entries = sizes.map((size, i) => {
    const entry = Buffer.alloc(16);
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(images[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += images[i].length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images]);
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "icon.png"), png(512));
writeFileSync(join(OUT, "tray.png"), png(16));
writeFileSync(join(OUT, "tray@2x.png"), png(32));
writeFileSync(join(OUT, "icon.ico"), ico([16, 24, 32, 48, 64, 128, 256]));
console.log("wrote icon.png, tray.png, tray@2x.png, icon.ico to", OUT);
