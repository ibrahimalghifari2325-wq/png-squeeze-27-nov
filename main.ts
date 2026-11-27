// PNG squeeze — a lossless PNG compressor for 1280x720 screenshots.
// Written from scratch by an AI agent for make.fun's "Squeeze screenshots into
// the smallest PNG" bounty (png-squeeze-01-run-20261127).
//
// Strategy: decode each screenshot to RGBA, reduce its colour type where the
// pixels allow (palette for <=256 colours, grey / grey+alpha for grey images,
// RGB for opaque images), choose the PNG row filter per image from ten
// strategies (four fixed filters, two per-row adaptive ones, and four
// per-block trial-compression ones) with a two-stage ranking — level 6 to
// shortlist, level 9 to decide — then compress the winner at zlib level 9
// with both the default and filtered strategies and keep the smaller.
// Everything is deterministic: no clock, no randomness, no environment input
// besides the input/output directories. One run answers all eight instances
// in /input/<id>/image.png, writing /output/<id>/image.png.
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
//   7..10: per block of 8/16/32/64 rows, the filter with the smallest real
//   zlib level-6 size of the block's filtered bytes (trial compression, not
//   a proxy: on i003 the per-row entropy proxy loses to fixed Paeth, while
//   block trial beats it by ~2.5 KB).
function filterImage(samples: Uint8Array, width: number, height: number, bpp: number, mode: number): Uint8Array {
  const byteWidth = width * bpp;
  const out = new Uint8Array((byteWidth + 1) * height);
  const scr: Uint8Array[] = [];
  for (let f = 0; f < 5; f++) scr.push(new Uint8Array(byteWidth));
  let op = 0;
  if (mode >= 7) {
    const blockRows = [8, 16, 32, 64][mode - 7];
    const tmp = new Uint8Array((byteWidth + 1) * blockRows);
    for (let y0 = 0; y0 < height; y0 += blockRows) {
      const y1 = Math.min(height, y0 + blockRows);
      let bestF = 0;
      let bestSize = Infinity;
      for (let f = 0; f < 5; f++) {
        let tp = 0;
        for (let y = y0; y < y1; y++) {
          filterRowInto(samples, y * byteWidth, y > 0 ? (y - 1) * byteWidth : -1, byteWidth, bpp, f, scr[f]);
          tmp[tp++] = f;
          tmp.set(scr[f], tp);
          tp += byteWidth;
        }
        const sz = deflateSync(tmp.subarray(0, tp), { level: 6, memLevel: 8, strategy: 0 }).length;
        if (sz < bestSize) { bestSize = sz; bestF = f; }
      }
      for (let y = y0; y < y1; y++) {
        filterRowInto(samples, y * byteWidth, y > 0 ? (y - 1) * byteWidth : -1, byteWidth, bpp, bestF, scr[bestF]);
        out[op++] = bestF;
        out.set(scr[bestF], op);
        op += byteWidth;
      }
    }
    return out;
  }
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

function compressImage(rgba: Uint8Array, width: number, height: number): { png: Uint8Array; filtered: Uint8Array; idat: Uint8Array; cand: Candidate; width: number; height: number } {
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

  // Two-stage ranking. Stage 1 ranks every (candidate, filter mode) at zlib
  // level 6 and keeps only the top 3 plus each candidate's best mode-0
  // (unfiltered) stream — raw streams gain most from level 9's deeper
  // matching, so level 6 underrates them (on one practice image mode 0 is
  // level-6 rank 8 but the level-9 winner). Stage 2 re-ranks the kept
  // streams at level 9 with both strategies and takes the smallest. Only
  // the kept streams are retained, so memory stays small (the 512 MB box).
  type Ranked = { size: number; filtered: Uint8Array; cand: Candidate; mode: number };
  const MODES = [0, 1, 2, 4, 5, 6, 7, 8, 9, 10];
  const TOP_N = 3;
  const top: Ranked[] = [];
  const bestM0 = new Map<Candidate, Ranked>();
  for (const cand of candidates) {
    for (const mode of MODES) {
      const filtered = filterImage(cand.samples, width, height, cand.bpp, mode);
      const size = deflateSync(filtered, { level: 6, memLevel: 8, strategy: 0 }).length;
      const entry: Ranked = { size, filtered, cand, mode };
      if (mode === 0) {
        const cur = bestM0.get(cand);
        if (!cur || size < cur.size) bestM0.set(cand, entry);
      }
      if (top.length < TOP_N || size < top[top.length - 1].size) {
        top.push(entry);
        top.sort((a, b) => a.size - b.size);
        if (top.length > TOP_N) top.length = TOP_N;
      }
    }
  }
  const reRank: Ranked[] = [];
  const take = (r: Ranked) => {
    if (!reRank.some((e) => e.cand === r.cand && e.mode === r.mode)) reRank.push(r);
  };
  top.forEach(take);
  for (const r of bestM0.values()) take(r);
  let bestComp: Buffer | null = null;
  let bestCandidate: Candidate | null = null;
  let bestFiltered: Uint8Array | null = null;
  for (const r of reRank) {
    for (const s of [0, 1]) {
      const c = deflateSync(r.filtered, { level: 9, memLevel: 9, strategy: s });
      if (!bestComp || c.length < bestComp.length) {
        bestComp = c;
        bestCandidate = r.cand;
        bestFiltered = r.filtered;
      }
    }
  }
  const cand = bestCandidate!;
  return { png: buildPng(cand, width, height, new Uint8Array(bestComp!)), filtered: bestFiltered!, idat: new Uint8Array(bestComp!), cand, width, height };
}

function buildPng(cand: Candidate, width: number, height: number, idat: Uint8Array): Uint8Array {
  const chunks: Array<[string, Uint8Array]> = [['IHDR', ihdrOf(width, height, cand.colorType)]];
  if (cand.plte) chunks.push(['PLTE', cand.plte]);
  if (cand.trns) chunks.push(['tRNS', cand.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// Optimal-parse DEFLATE encoder, written from scratch from the DEFLATE
// format (RFC 1951). No copied code: hash-chain match finding, a shortest-path
// (dynamic programming) parse with iterative Huffman cost refinement, and a
// dynamic-Huffman block writer with code-length RLE.
//
// Input: the filtered byte stream of one PNG image. Output: a complete zlib
// stream (header + raw DEFLATE blocks + Adler-32) that decodes to exactly the
// same bytes. Deterministic: every budget is a work count, never a clock.
//
// Design notes:
// - The stream is split into fixed-size blocks (BLOCK_BYTES); each block gets
//   its own Huffman tables and its own parse, so statistics stay local.
// - Match finding is one pass over the whole stream (matches may reach up to
//   32 KiB into the previous block, as DEFLATE allows); the parse is per
//   block, with match lengths capped at the block end.
// - Two parse passes per block: first with fixed-Huffman costs, then with
//   costs learned from the first pass's symbol frequencies. A third pass
//   gains little and costs a full DP.

// ---------- DEFLATE tables (RFC 1951 section 3.2.5) ----------
const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
// Lengths where the length symbol changes (plus 258): the only lengths an
// optimal parse needs to consider for a match, since shorter lengths with
// the same symbol cost the same symbol bits but save fewer bytes.
const LEN_BOUNDARIES = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];

function lenSymbol(len: number): number {
  let lo = 0;
  let hi = LEN_BASE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid;
    else hi = mid - 1;
  }
  return 257 + lo;
}

function distSymbol(dist: number): number {
  let lo = 0;
  let hi = DIST_BASE.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Fixed-Huffman code lengths (RFC 1951 section 3.2.6): literals 0-143: 8,
// 144-255: 9, 256-279: 7, 280-287: 8; distances: 5.
const FIXED_LIT_COST = new Uint8Array(288);
for (let i = 0; i < 288; i++) FIXED_LIT_COST[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_DIST_COST = new Uint8Array(30).fill(5);

// ---------- Huffman code construction ----------
// Build length-limited Huffman code lengths from symbol frequencies.
// Tree built by repeated smallest-pair combination; if any length exceeds
// maxBits, redistribute with the standard overflow fix (move one leaf down,
// its overflow brother up) and reassign lengths by frequency order.
function buildLengths(freq: Uint32Array, maxBits: number): Uint8Array {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  const syms: number[] = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return lengths;
  if (syms.length === 1) {
    lengths[syms[0]] = 1;
    return lengths;
  }
  // Node arrays: leaves are 0..syms.length-1, internal nodes follow.
  const nodeFreq: number[] = [];
  const nodeLeft: number[] = [];
  const nodeRight: number[] = [];
  const nodeSym: number[] = [];
  for (const s of syms) {
    nodeFreq.push(freq[s]);
    nodeLeft.push(-1);
    nodeRight.push(-1);
    nodeSym.push(s);
  }
  const active: number[] = syms.map((_, i) => i);
  while (active.length > 1) {
    // Two smallest by frequency (ties: smaller node index first, stable).
    let m1 = 0;
    let m2 = 1;
    if (nodeFreq[active[m2]] < nodeFreq[active[m1]]) { const t = m1; m1 = m2; m2 = t; }
    for (let k = 2; k < active.length; k++) {
      const f = nodeFreq[active[k]];
      if (f < nodeFreq[active[m1]]) { m2 = m1; m1 = k; }
      else if (f < nodeFreq[active[m2]]) { m2 = k; }
    }
    const a = active[m1];
    const b = active[m2];
    const parent = nodeFreq.length;
    nodeFreq.push(nodeFreq[a] + nodeFreq[b]);
    nodeLeft.push(a);
    nodeRight.push(b);
    nodeSym.push(-1);
    active.splice(Math.max(m1, m2), 1);
    active.splice(Math.min(m1, m2), 1);
    active.push(parent);
  }
  const root = active[0];
  // Depth of each leaf = its code length.
  const parent = new Int32Array(nodeFreq.length).fill(-1);
  for (let i = syms.length; i < nodeFreq.length; i++) {
    parent[nodeLeft[i]] = i;
    parent[nodeRight[i]] = i;
  }
  const blCount = new Uint32Array(300);
  let maxDepth = 0;
  for (let leaf = 0; leaf < syms.length; leaf++) {
    let d = 0;
    let p = leaf;
    while (parent[p] >= 0) { d++; p = parent[p]; }
    lengths[syms[leaf]] = d;
    blCount[d]++;
    if (d > maxDepth) maxDepth = d;
  }
  if (maxDepth > maxBits) {
    // Length-limited fallback: a balanced complete code. Sort by frequency
    // (most frequent first); with K = ceil(log2(m)), give the first
    // (2^K - m) symbols length K-1 and the rest length K. Kraft sum:
    // (2^K - m)*2^-(K-1) + (2m - 2^K)*2^-K = 1, so the code is complete
    // and valid, with every length <= K <= 9 (m <= 288). Only used when the
    // Huffman tree is pathologically skewed (rare: real PNG data gives
    // depths well under 15); the cost is slightly suboptimal lengths.
    const m = syms.length;
    const K = Math.max(1, Math.ceil(Math.log2(m)));
    const short = (1 << K) - m;
    const byFreq = [...syms].sort((a, b) => freq[b] - freq[a] || a - b);
    for (let i = 0; i < m; i++) lengths[byFreq[i]] = i < short ? K - 1 : K;
    return lengths;
  }
  return lengths;
}

// Canonical Huffman codes from code lengths (RFC 1951 section 3.2.2).
function canonicalCodes(lengths: Uint8Array): Uint32Array {
  const maxBits = Math.max(1, ...lengths);
  const blCount = new Uint32Array(maxBits + 1);
  for (const l of lengths) if (l) blCount[l]++;
  const nextCode = new Uint32Array(maxBits + 1);
  let code = 0;
  for (let bits = 1; bits <= maxBits; bits++) {
    code = (code + blCount[bits - 1]) << 1;
    nextCode[bits] = code;
  }
  const codes = new Uint32Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    const l = lengths[s];
    if (l) codes[s] = nextCode[l]++;
  }
  return codes;
}

function reverseBits(value: number, len: number): number {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | ((value >> i) & 1);
  }
  return r;
}

// ---------- bit writer (LSB-first packing; Huffman codes MSB-first) ----------
class BitWriter {
  bytes: number[] = [];
  bitBuf = 0;
  bitCnt = 0;
  put(value: number, len: number): void {
    this.bitBuf |= (value << this.bitCnt) >>> 0;
    this.bitCnt += len;
    while (this.bitCnt >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  putCode(code: number, len: number): void {
    this.put(reverseBits(code, len), len);
  }
  finish(): Uint8Array {
    if (this.bitCnt > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

// ---------- match finding (hash chains over the whole stream) ----------
// For each position, records the LONGEST match and, separately, the longest
// match among the closest few chain entries (small distances). The DP needs
// both: a 258-byte match 30 KiB away is often worse than a 100-byte match
// 100 bytes away, because distance codes cost extra bits. Only the longest
// match would hide the near one.
const MAX_CHAIN = 32;
const NEAR_ENTRIES = 8;
const HASH_BITS = 15;

function findMatches(data: Uint8Array, maxChain: number = MAX_CHAIN): { lens: Uint16Array; dists: Uint16Array; lens2: Uint16Array; dists2: Uint16Array } {
  const n = data.length;
  const lens = new Uint16Array(n);
  const dists = new Uint16Array(n);
  const lens2 = new Uint16Array(n);
  const dists2 = new Uint16Array(n);
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(n);
  const mask = (1 << HASH_BITS) - 1;
  for (let i = 0; i < n; i++) {
    if (i + 2 >= n) continue;
    // Multiplicative hash of the 3-byte sequence (Math.imul keeps the low
    // 32 bits; the top 15 are the bucket). A hash collision must NOT be
    // trusted: the candidate's first 3 bytes are verified explicitly below.
    const v = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    const h = (Math.imul(v, 2654435761) >>> 17) & mask;
    let cand = head[h];
    let bestLen = 0;
    let bestDist = 0;
    let nearLen = 0;
    let nearDist = 0;
    let chain = 0;
    const maxLen = Math.min(258, n - i);
    while (cand >= 0 && chain < maxChain) {
      const dist = i - cand;
      if (dist > 32768) break;
      chain++;
      // Verify the first 3 bytes: a hash bucket holds different triples too.
      if (data[cand] === data[i] && data[cand + 1] === data[i + 1] && data[cand + 2] === data[i + 2]) {
        let len = 3;
        while (len < maxLen && data[i + len] === data[cand + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len >= maxLen) break;
        }
        if (chain <= NEAR_ENTRIES && len > nearLen) {
          nearLen = len;
          nearDist = dist;
        }
      }
      cand = prev[cand];
    }
    if (bestLen >= 3) {
      lens[i] = bestLen;
      dists[i] = bestDist;
      if (nearLen >= 3 && (nearDist !== bestDist || nearLen !== bestLen)) {
        lens2[i] = nearLen;
        dists2[i] = nearDist;
      }
    }
    prev[i] = head[h];
    head[h] = i;
  }
  return { lens, dists, lens2, dists2 };
}

// ---------- optimal parse of one block ----------
// Tokens: {len: 1, byte} for a literal, {len >= 3, dist} for a match.
type Token = { len: number; byte: number; dist: number };

function parseBlock(
  data: Uint8Array,
  start: number,
  end: number,
  lens: Uint16Array,
  dists: Uint16Array,
  lens2: Uint16Array,
  dists2: Uint16Array,
  litCost: Uint8Array,
  lenCost: Uint8Array,
  distCost: Uint8Array,
): Token[] {
  const n = end - start;
  const INF = 1 << 30;
  const cost = new Int32Array(n + 1).fill(INF);
  const prevLen = new Uint16Array(n + 1);
  const prevDist = new Uint16Array(n + 1);
  cost[0] = 0;
  const relaxMatch = (i: number, base: number, ml: number, d: number): void => {
    const dsym = distSymbol(d);
    const dc = distCost[dsym] + DIST_EXTRA[dsym];
    const maxL = Math.min(ml, n - i);
    for (const bl of LEN_BOUNDARIES) {
      if (bl > maxL) break;
      const sym = lenSymbol(bl);
      const c = base + lenCost[sym] + LEN_EXTRA[sym - 257] + dc;
      if (c < cost[i + bl]) {
        cost[i + bl] = c;
        prevLen[i + bl] = bl;
        prevDist[i + bl] = d;
      }
    }
    if (maxL > 3 && !LEN_BOUNDARIES.includes(maxL)) {
      const sym = lenSymbol(maxL);
      const c = base + lenCost[sym] + LEN_EXTRA[sym - 257] + dc;
      if (c < cost[i + maxL]) {
        cost[i + maxL] = c;
        prevLen[i + maxL] = maxL;
        prevDist[i + maxL] = d;
      }
    }
  };
  for (let i = 0; i < n; i++) {
    const base = cost[i];
    if (base === INF) continue;
    // Literal.
    const lc = base + litCost[data[start + i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      prevLen[i + 1] = 1;
      prevDist[i + 1] = 0;
    }
    // Matches: the longest match and the near match (different distances).
    if (lens[start + i] >= 3) relaxMatch(i, base, lens[start + i], dists[start + i]);
    if (lens2[start + i] >= 3) relaxMatch(i, base, lens2[start + i], dists2[start + i]);
  }
  // Reconstruct by walking back from the end.
  const tokens: Token[] = [];
  let i = n;
  while (i > 0) {
    const len = prevLen[i];
    if (len === 1) {
      tokens.push({ len: 1, byte: data[start + i - 1], dist: 0 });
      i -= 1;
    } else {
      tokens.push({ len, byte: 0, dist: prevDist[i] });
      i -= len;
    }
  }
  tokens.reverse();
  return tokens;
}

function countFrequencies(tokens: Token[]): { litFreq: Uint32Array; distFreq: Uint32Array } {
  const litFreq = new Uint32Array(288);
  const distFreq = new Uint32Array(30);
  for (const t of tokens) {
    if (t.len === 1) litFreq[t.byte]++;
    else {
      litFreq[lenSymbol(t.len)]++;
      distFreq[distSymbol(t.dist)]++;
    }
  }
  litFreq[256]++; // end of block
  // A dynamic block needs at least one distance code.
  let anyDist = false;
  for (let i = 0; i < 30; i++) if (distFreq[i]) { anyDist = true; break; }
  if (!anyDist) distFreq[0] = 1;
  return { litFreq, distFreq };
}

// ---------- dynamic block emission ----------
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function emitBlock(
  bw: BitWriter,
  tokens: Token[],
  litLengths: Uint8Array,
  distLengths: Uint8Array,
  isLast: boolean,
): void {
  bw.put(isLast ? 1 : 0, 1);
  bw.put(2, 2); // BTYPE = 10, dynamic Huffman
  let hlit = 286;
  while (hlit > 257 && litLengths[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist--;
  bw.put(hlit - 257, 5);
  bw.put(hdist - 1, 5);
  // RLE of the lit+dist code lengths into code-length symbols.
  const all: number[] = [];
  for (let i = 0; i < hlit; i++) all.push(litLengths[i]);
  for (let i = 0; i < hdist; i++) all.push(distLengths[i]);
  const clSyms: number[] = [];
  const clExtra: number[] = [];
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    if (v === 0) {
      let run = 1;
      while (i + run < all.length && all[i + run] === 0) run++;
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        clSyms.push(18);
        clExtra.push(take - 11);
        r -= take;
      }
      if (r >= 3) {
        clSyms.push(17);
        clExtra.push(r - 3);
        r = 0;
      }
      for (let k = 0; k < r; k++) {
        clSyms.push(0);
        clExtra.push(0);
      }
      i += run;
    } else {
      clSyms.push(v);
      clExtra.push(0);
      let run = 1;
      while (i + run < all.length && all[i + run] === v) run++;
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        clSyms.push(16);
        clExtra.push(take - 3);
        r -= take;
      }
      for (let k = 0; k < r; k++) {
        clSyms.push(v);
        clExtra.push(0);
      }
      i += run;
    }
  }
  const clFreq = new Uint32Array(19);
  for (const s of clSyms) clFreq[s]++;
  const clLengths = buildLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLengths[CL_ORDER[hclen - 1]] === 0) hclen--;
  bw.put(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.put(clLengths[CL_ORDER[k]], 3);
  const clCodes = canonicalCodes(clLengths);
  for (let k = 0; k < clSyms.length; k++) {
    const s = clSyms[k];
    bw.putCode(clCodes[s], clLengths[s]);
    if (s === 16) bw.put(clExtra[k], 2);
    else if (s === 17) bw.put(clExtra[k], 3);
    else if (s === 18) bw.put(clExtra[k], 7);
  }
  const litCodes = canonicalCodes(litLengths);
  const distCodes = canonicalCodes(distLengths);
  for (const t of tokens) {
    if (t.len === 1) {
      bw.putCode(litCodes[t.byte], litLengths[t.byte]);
    } else {
      const sym = lenSymbol(t.len);
      bw.putCode(litCodes[sym], litLengths[sym]);
      bw.put(t.len - LEN_BASE[sym - 257], LEN_EXTRA[sym - 257]);
      const dsym = distSymbol(t.dist);
      bw.putCode(distCodes[dsym], distLengths[dsym]);
      bw.put(t.dist - DIST_BASE[dsym], DIST_EXTRA[dsym]);
    }
  }
  bw.putCode(litCodes[256], litLengths[256]); // end of block
}

// ---------- Adler-32 (zlib checksum) ----------
function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- top level ----------
// Compress one filtered stream with optimal parsing. Returns a complete zlib
// stream. BLOCK_BYTES bounds each block's parse; OPT_PASSES is the number of
// cost-refinement passes per block (first pass: fixed-Huffman costs).
const BLOCK_BYTES = 200000;
const OPT_PASSES = 2;

function optimalZlib(data: Uint8Array, blockBytes: number = BLOCK_BYTES, maxChain: number = MAX_CHAIN): Uint8Array {
  const bw = new BitWriter();
  const { lens, dists, lens2, dists2 } = findMatches(data, maxChain);
  const n = data.length;
  for (let start = 0; start < n; start += blockBytes) {
    const end = Math.min(n, start + blockBytes);
    const isLast = end === n;
    // Pass 1: fixed-Huffman costs.
    let tokens = parseBlock(data, start, end, lens, dists, lens2, dists2, FIXED_LIT_COST, FIXED_LIT_COST, FIXED_DIST_COST);
    let { litFreq, distFreq } = countFrequencies(tokens);
    let litLengths = buildLengths(litFreq, 15);
    let distLengths = buildLengths(distFreq, 15);
    // Pass 2: learned costs. IMPORTANT: a symbol unused in pass 1 has learned
    // length 0, which would price it at 0 bits in the DP — a free lunch the
    // parse then exploits (e.g. tens of thousands of free literals of a byte
    // that only ever appeared inside matches). Price every unused symbol at
    // its fixed-Huffman cost instead. The emitted table is rebuilt from the
    // pass-2 token frequencies afterwards, so it always covers exactly the
    // symbols pass 2 actually emits.
    if (OPT_PASSES >= 2) {
      const litCost2 = new Uint8Array(288);
      const distCost2 = new Uint8Array(30);
      for (let i = 0; i < 288; i++) litCost2[i] = litLengths[i] || FIXED_LIT_COST[i];
      for (let i = 0; i < 30; i++) distCost2[i] = distLengths[i] || FIXED_DIST_COST[i];
      tokens = parseBlock(data, start, end, lens, dists, lens2, dists2, litCost2, litCost2, distCost2);
      ({ litFreq, distFreq } = countFrequencies(tokens));
      litLengths = buildLengths(litFreq, 15);
      distLengths = buildLengths(distFreq, 15);
    }
    emitBlock(bw, tokens, litLengths, distLengths, isLast);
  }
  const raw = bw.finish();
  const out = new Uint8Array(2 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(raw, 2);
  const ad = adler32(data);
  out[2 + raw.length] = (ad >>> 24) & 255;
  out[2 + raw.length + 1] = (ad >>> 16) & 255;
  out[2 + raw.length + 2] = (ad >>> 8) & 255;
  out[2 + raw.length + 3] = ad & 255;
  return out;
}

// ---------- main: one run answers the whole set ----------
// Phase 1: decode + rank + zlib for every instance, writing each PNG.
// Phase 2: optimal-parse DEFLATE on the instances where it pays, in
// descending zlib-ratio order and within a fixed work budget. The optimal
// pass wins when zlib's own compression is poor (ratio above ~2.8%: on the
// practice set it wins on the alpha/rich/grey streams and loses on the
// flat, highly compressible ones); the per-instance fallback keeps zlib
// whenever the optimal stream is not smaller, so this can only help.
// Both the ratio gate and the byte budget are work counts, never the clock.
const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const OPT_RATIO_GATE = 0.028;
const OPT_BYTE_BUDGET = 8000000;

type Done = { id: string; filtered: Uint8Array; idat: Uint8Array; cand: Candidate; width: number; height: number };
const done: Done[] = [];
for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(readFileSync(join(INPUT_DIR, id, 'image.png')));
  const r = compressImage(image.rgba, image.width, image.height);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), r.png);
  done.push({ id, filtered: r.filtered, idat: r.idat, cand: r.cand, width: r.width, height: r.height });
}
const byRatio = [...done].sort((a, b) => (b.idat.length / b.filtered.length) - (a.idat.length / a.filtered.length));
let optBudget = OPT_BYTE_BUDGET;
for (const d of byRatio) {
  const ratio = d.idat.length / d.filtered.length;
  if (ratio <= OPT_RATIO_GATE) continue;
  if (d.filtered.length > optBudget) continue;
  optBudget -= d.filtered.length;
  const opt = optimalZlib(d.filtered);
  if (opt.length < d.idat.length) {
    writeFileSync(join(OUTPUT_DIR, d.id, 'image.png'), buildPng(d.cand, d.width, d.height, opt));
  }
}
