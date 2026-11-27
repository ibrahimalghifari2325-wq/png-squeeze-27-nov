// PNG squeeze — a lossless PNG compressor for 1280x720 screenshots.
// Written from scratch by an AI agent for make.fun's "Squeeze screenshots into
// the smallest PNG" bounty (png-squeeze-01-run-20261127).
//
// Strategy: decode each screenshot to RGBA, reduce its colour type where the
// pixels allow (palette for <=256 colours, grey / grey+alpha for grey images,
// RGB for opaque images), choose the PNG row filter per image from six
// strategies (four fixed filters and two per-row adaptive ones) by actually
// compressing each at zlib level 6 and keeping the smallest, then compress
// the winner at zlib level 9 with both the default and filtered strategies
// and keep the smaller. Everything is deterministic: no clock, no randomness,
// no environment input besides the input/output directories. One run answers
// all eight instances in /input/<id>/image.png, writing /output/<id>/image.png.
//
// Node 22 runs this file as it is (erasable TypeScript only).

import { inflateSync, deflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------- CRC-32 (PNG, ISO 3309) ----------
const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number = 0, end: number = bytes.length): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const ascii = (s: string): Uint8Array => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

function pngOf(chunks: Array<[string, Uint8Array]>): Uint8Array {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width: number, height: number, colorType: number): Uint8Array {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth
  d[9] = colorType;
  d[10] = 0; // compression
  d[11] = 0; // filter method
  d[12] = 0; // no interlace
  return d;
}

// ---------- PNG decode to RGBA (bit depth 8, non-interlaced) ----------
function paethPredictor(left: number, above: number, upLeft: number): number {
  const p = left + above - upLeft;
  const pLeft = Math.abs(p - left);
  const pAbove = Math.abs(p - above);
  const pUpLeft = Math.abs(p - upLeft);
  if (pLeft <= pAbove && pLeft <= pUpLeft) return left;
  if (pAbove <= pUpLeft) return above;
  return upLeft;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(buf: Buffer): { rgba: Uint8Array; width: number; height: number } {
  if (buf.length < 8 || !SIGNATURE.every((b, i) => buf[i] === b)) throw new Error('bad PNG signature');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  const idat: Buffer[] = [];
  let plte: Buffer | null = null;
  let trns: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data as Buffer);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0) throw new Error('unsupported bit depth or interlace');
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error('unsupported colour type ' + colorType);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const rgba = new Uint8Array(width * height * 4);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const row = raw.subarray(rp, rp + stride);
    rp += stride;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < channels; c++) {
        const i = x * channels + c;
        let v = row[i];
        const left = x >= channels ? row[i - channels] : 0;
        const up = y > 0 ? rgba[(y - 1) * width * 4 + x * 4 + c] : 0;
        const upLeft = y > 0 && x >= channels ? rgba[(y - 1) * width * 4 + (x - channels) * 4 + c] : 0;
        if (filter === 1) v = (v + left) & 255;
        else if (filter === 2) v = (v + up) & 255;
        else if (filter === 3) v = (v + ((left + up) >> 1)) & 255;
        else if (filter === 4) v = (v + paethPredictor(left, up, upLeft)) & 255;
        const o = (y * width + x) * 4;
        if (colorType === 6) rgba[o + c] = v;
        else if (colorType === 2) {
          rgba[o + c] = v;
          if (c === 2) rgba[o + 3] = 255;
        } else if (colorType === 0) {
          rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; rgba[o + 3] = 255;
        } else if (colorType === 4) {
          if (c === 0) { rgba[o] = v; rgba[o + 1] = v; rgba[o + 2] = v; }
          else rgba[o + 3] = v;
        } else if (colorType === 3) {
          const pi = v * 3;
          rgba[o] = plte![pi]; rgba[o + 1] = plte![pi + 1]; rgba[o + 2] = plte![pi + 2];
          rgba[o + 3] = trns && v < trns.length ? trns[v] : 255;
        }
      }
    }
  }
  return { rgba, width, height };
}

// ---------- row filtering ----------
function filterRowInto(samples: Uint8Array, rowStart: number, prevStart: number, byteWidth: number, bpp: number, f: number, out: Uint8Array): void {
  for (let x = 0; x < byteWidth; x++) {
    const v = samples[rowStart + x];
    const left = x >= bpp ? samples[rowStart + x - bpp] : 0;
    const up = prevStart >= 0 ? samples[prevStart + x] : 0;
    const upLeft = prevStart >= 0 && x >= bpp ? samples[prevStart + x - bpp] : 0;
    let r: number;
    if (f === 0) r = v;
    else if (f === 1) r = v - left;
    else if (f === 2) r = v - up;
    else if (f === 3) r = v - ((left + up) >> 1);
    else r = v - paethPredictor(left, up, upLeft);
    out[x] = r & 255;
  }
}

function rowScoreSumAbs(buf: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) {
    const v = buf[i];
    s += v > 127 ? 256 - v : v;
  }
  return s;
}

function rowScoreEntropy(buf: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) hist[buf[i]]++;
  let cost = 0;
  for (let i = 0; i < 256; i++) {
    if (hist[i]) cost += hist[i] * Math.log2(buf.length / hist[i]);
  }
  return cost;
}

// Filter a whole image with one strategy:
//   0..4: the same filter on every row.
//   5: per-row, the filter with the smallest sum of |signed byte|.
//   6: per-row, the filter with the smallest histogram entropy.
function filterImage(samples: Uint8Array, width: number, height: number, bpp: number, mode: number): Uint8Array {
  const byteWidth = width * bpp;
  const out = new Uint8Array((byteWidth + 1) * height);
  const scr: Uint8Array[] = [];
  for (let f = 0; f < 5; f++) scr.push(new Uint8Array(byteWidth));
  let op = 0;
  for (let y = 0; y < height; y++) {
    const rs = y * byteWidth;
    const ps = y > 0 ? (y - 1) * byteWidth : -1;
    let bestF = 0;
    if (mode <= 4) bestF = mode;
    else {
      let bestScore = Infinity;
      for (let f = 0; f < 5; f++) {
        filterRowInto(samples, rs, ps, byteWidth, bpp, f, scr[f]);
        const score = mode === 5 ? rowScoreSumAbs(scr[f]) : rowScoreEntropy(scr[f]);
        if (score < bestScore) { bestScore = score; bestF = f; }
      }
    }
    filterRowInto(samples, rs, ps, byteWidth, bpp, bestF, scr[bestF]);
    out[op++] = bestF;
    out.set(scr[bestF], op);
    op += byteWidth;
  }
  return out;
}

// ---------- per-image compression ----------
// A candidate encoding: its sample bytes, bytes per pixel, colour type and,
// for palettes, the palette and transparency bytes.
type Candidate = {
  kind: string;
  samples: Uint8Array;
  bpp: number;
  colorType: number;
  plte: Uint8Array | null;
  trns: Uint8Array | null;
};

function luminanceOf(key: number): number {
  return 0.299 * ((key >>> 24) & 255) + 0.587 * ((key >>> 16) & 255) + 0.114 * ((key >>> 8) & 255);
}

function compressImage(rgba: Uint8Array, width: number, height: number): Uint8Array {
  const n = width * height;
  // One analysis pass: unique colours (capped at 257), grey?, opaque?
  const colourIndex = new Map<number, number>();
  const colourFreq = new Map<number, number>();
  let isGrey = true;
  let isOpaque = true;
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const a = rgba[i * 4 + 3];
    if (r !== g || g !== b) isGrey = false;
    if (a !== 255) isOpaque = false;
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    colourFreq.set(key, (colourFreq.get(key) ?? 0) + 1);
    if (colourIndex.size <= 256 && !colourIndex.has(key)) colourIndex.set(key, colourIndex.size);
  }
  const unique = colourIndex.size;

  const candidates: Candidate[] = [];
  if (unique <= 256) {
    const entries = [...colourIndex.keys()];
    const orders: number[][] = [
      entries,
      [...entries].sort((x, y) => luminanceOf(x) - luminanceOf(y)),
      [...entries].sort((x, y) => (colourFreq.get(y) ?? 0) - (colourFreq.get(x) ?? 0)),
    ];
    for (const order of orders) {
      const indexOf = new Map<number, number>();
      order.forEach((k, i) => indexOf.set(k, i));
      const samples = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const key = ((rgba[i * 4] << 24) | (rgba[i * 4 + 1] << 16) | (rgba[i * 4 + 2] << 8) | rgba[i * 4 + 3]) >>> 0;
        samples[i] = indexOf.get(key)!;
      }
      const plte = new Uint8Array(order.length * 3);
      const trnsFull = new Uint8Array(order.length);
      let lastAlpha = -1;
      order.forEach((k, i) => {
        plte[i * 3] = (k >>> 24) & 255;
        plte[i * 3 + 1] = (k >>> 16) & 255;
        plte[i * 3 + 2] = (k >>> 8) & 255;
        trnsFull[i] = k & 255;
        if ((k & 255) !== 255) lastAlpha = i;
      });
      // tRNS only needs to run up to the last non-opaque entry.
      const trns = lastAlpha >= 0 ? trnsFull.subarray(0, lastAlpha + 1) : null;
      candidates.push({ kind: 'palette', samples, bpp: 1, colorType: 3, plte, trns });
    }
  }
  if (isGrey) {
    if (isOpaque) {
      const samples = new Uint8Array(n);
      for (let i = 0; i < n; i++) samples[i] = rgba[i * 4];
      candidates.push({ kind: 'grey', samples, bpp: 1, colorType: 0, plte: null, trns: null });
    } else {
      const samples = new Uint8Array(n * 2);
      for (let i = 0; i < n; i++) { samples[i * 2] = rgba[i * 4]; samples[i * 2 + 1] = rgba[i * 4 + 3]; }
      candidates.push({ kind: 'grey-alpha', samples, bpp: 2, colorType: 4, plte: null, trns: null });
    }
  } else if (isOpaque) {
    const samples = new Uint8Array(n * 3);
    for (let i = 0; i < n; i++) { samples[i * 3] = rgba[i * 4]; samples[i * 3 + 1] = rgba[i * 4 + 1]; samples[i * 3 + 2] = rgba[i * 4 + 2]; }
    candidates.push({ kind: 'rgb', samples, bpp: 3, colorType: 2, plte: null, trns: null });
  } else {
    candidates.push({ kind: 'rgba', samples: rgba, bpp: 4, colorType: 6, plte: null, trns: null });
  }

  // Rank every (candidate, filter mode) at zlib level 6, then compress the
  // winner at level 9 with both strategies and keep the smaller.
  const MODES = [0, 1, 2, 4, 5, 6];
  let bestFiltered: Uint8Array | null = null;
  let bestCandidate: Candidate | null = null;
  let bestRankSize = Infinity;
  for (const cand of candidates) {
    for (const mode of MODES) {
      const filtered = filterImage(cand.samples, width, height, cand.bpp, mode);
      const size = deflateSync(filtered, { level: 6, memLevel: 8, strategy: 0 }).length;
      if (size < bestRankSize) {
        bestRankSize = size;
        bestFiltered = filtered;
        bestCandidate = cand;
      }
    }
  }
  const cand = bestCandidate!;
  const filtered = bestFiltered!;
  let bestComp = deflateSync(filtered, { level: 9, memLevel: 9, strategy: 0 });
  const altComp = deflateSync(filtered, { level: 9, memLevel: 9, strategy: 1 });
  if (altComp.length < bestComp.length) bestComp = altComp;

  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, cand.colorType)]];
  if (cand.plte) chunks.push(['PLTE', cand.plte]);
  if (cand.trns) chunks.push(['tRNS', cand.trns]);
  chunks.push(['IDAT', new Uint8Array(bestComp)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- main: one run answers the whole set ----------
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(readFileSync(join(INPUT_DIR, id, 'image.png')));
  const png = compressImage(image.rgba, image.width, image.height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), png);
}
