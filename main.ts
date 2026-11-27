// png-squeeze-01 v4 — a lossless PNG rewriter, by rommya33.
//
// It reads each stored RGBA screenshot and rewrites it in the smallest exact
// form it can take: a palette when the image holds at most 256 colours, grey
// or grey-and-alpha when every pixel is grey, RGB or RGBA otherwise, with a
// tRNS key standing in for an alpha channel when exactly one fully transparent
// value exists and no opaque pixel uses it.
//
// v4 keeps v3's correct optimal-parse DEFLATE (a shortest-path dynamic program
// over the filtered bytes, hash-chain LZ77 matcher, length-limited Huffman
// codes, iterated so the cost model converges) and adds the thing v3 lacked:
// a hard time budget. v3 scored 713,779 on the practice set but took 66.9 s
// on the hardest generated set — past the 60 s wall, which would score 0.
// v4 measures each set's hardness up front from the screen itself (the best
// level-6 size of every image, which Phase A already computes) and spends its
// optimal-parse work where it buys the most points per second, so the run
// finishes well under 60 s on any set while never scoring below v2.
//
// The budget is deterministic: every decision comes from the input bytes, not
// from the clock, so two runs are byte-identical. A clock guard at 50 s is a
// last resort only, to keep a pathologically slow machine from timing out.
//
// Node 22, standard library only. No network, no randomness.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { constants, deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/* ------------------------------------------------------------------ */
/* CRC-32 (ISO 3309)                                                   */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/* ------------------------------------------------------------------ */
/* PNG writing                                                         */
/* ------------------------------------------------------------------ */

const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out[at + 4] = type.charCodeAt(0);
    out[at + 5] = type.charCodeAt(1);
    out[at + 6] = type.charCodeAt(2);
    out[at + 7] = type.charCodeAt(3);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8; // bit depth; compression 0, filter 0, interlace 0 are already zero
  d[9] = colourType;
  return d;
}

function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/* ------------------------------------------------------------------ */
/* PNG filters                                                         */
/* ------------------------------------------------------------------ */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// Filter row `cur` (stride samples, bpp bytes a pixel) against `prev` (the row
// above, or null) by `type`, into out[0, stride).
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      out[i] = cur[i] - ((a + b) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

// The minimum-sum heuristic's cost: the filtered bytes read as signed,
// absolute values summed (PNG specification section 12.8).
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// The fewest-distinct-pairs heuristic's cost: how many distinct pairs of
// neighbouring bytes a filtered row holds. `seen` is a stamp table shared by
// the rows of one image, `stamp` a fresh mark per row counted.
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

// How many bytes written before a row brute force weighs its trials after.
const BRUTE_CONTEXT = 32768;
// The zlib level brute force weighs a row's trials at.
const BRUTE_LEVEL = 4;

// The raw data of `samples` (height rows of width x bpp samples), each row
// behind its filter byte, written into `out` (a fresh buffer when not given).
// `choice` is one fixed filter type (0 to 4) for every row, or 'minsum' (each
// row the type whose filtered bytes have the least signed sum), 'pairs' (each
// row the type with the fewest distinct byte pairs), or 'brute' (each row the
// type whose zlib stream at level 4, after the 32 KiB written before it, is
// smallest); the lower type on a tie.
function filterImage(samples, width, height, bpp, choice, out = null) {
  const stride = width * bpp;
  const raw = out ?? new Uint8Array(height * (stride + 1));
  if (typeof choice === 'number') {
    for (let y = 0; y < height; y++) {
      const cur = samples.subarray(y * stride, (y + 1) * stride);
      const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
      raw[y * (stride + 1)] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    }
    return raw;
  }
  const trial = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride + 1));
  for (let t = 0; t < 5; t++) trial[t][0] = t;
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    let type = 0;
    let best = Infinity;
    if (choice === 'brute') {
      const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
      const opts = before.length === 0
        ? { level: BRUTE_LEVEL, memLevel: 9 }
        : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before };
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t].subarray(1));
        const cost = deflateSync(trial[t], opts).length;
        if (cost < best) {
          best = cost;
          type = t;
        }
      }
    } else {
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t].subarray(1));
        const cost = choice === 'minsum' ? signedSum(trial[t].subarray(1)) : pairsOf(trial[t].subarray(1), seen, ++stamp);
        if (cost < best) {
          best = cost;
          type = t;
        }
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

/* ------------------------------------------------------------------ */
/* PNG reading: a general decoder back to RGBA                         */
/* ------------------------------------------------------------------ */

const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

function decodePng(bytes) {
  if (bytes.length < SIGNATURE.length) return { ok: false, why: 'shorter than the PNG signature' };
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) return { ok: false, why: 'no PNG signature' };
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let width = 0;
  let height = 0;
  let colourType = -1;
  let palette = null;
  let trns = null;
  const idatParts = [];
  let sawIEND = false;
  while (at + 8 <= bytes.length && !sawIEND) {
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return { ok: false, why: 'a chunk overruns the file' };
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return { ok: false, why: `${type} fails its CRC` };
    const data = bytes.subarray(at + 8, at + 8 + len);
    if (type === 'IHDR') {
      if (len !== 13) return { ok: false, why: 'IHDR is not 13 bytes' };
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (data[8] !== 8) return { ok: false, why: 'bit depth is not 8' };
      colourType = data[9];
      if (!Object.hasOwn(CHANNELS, colourType)) return { ok: false, why: `colour type ${colourType}` };
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0) return { ok: false, why: 'not compression 0, filter 0, no interlace' };
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      sawIEND = true;
    } else {
      return { ok: false, why: `chunk ${type} is not read` };
    }
    at += 12 + len;
  }
  if (!sawIEND) return { ok: false, why: 'no IEND' };
  if (idatParts.length === 0) return { ok: false, why: 'no IDAT' };
  if (colourType < 0) return { ok: false, why: 'no IHDR' };
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  let raw;
  try {
    const stream = idatParts.length === 1 ? idatParts[0] : Buffer.concat(idatParts);
    raw = inflateSync(stream, { maxOutputLength: expected + 1 });
  } catch (err) {
    return { ok: false, why: `IDAT does not inflate (${String(err && err.message).split('\n')[0]})` };
  }
  if (raw.length !== expected) return { ok: false, why: `IDAT inflates to ${raw.length} bytes, not ${expected}` };

  // Unfilter in place, row by row.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return { ok: false, why: `row ${y} has filter ${ft}` };
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        samples[o + i] = raw[src + i] + ((a + b) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  // Expand the samples to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return { ok: false, why: `pixel ${i} names palette entry ${e}` };
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, rgba };
}

/* ------------------------------------------------------------------ */
/* Analysis: what an RGBA image holds                                  */
/* ------------------------------------------------------------------ */

// The image's pixels as 32-bit words (a copy when the bytes are not
// word-aligned), so colour counting and palette lookup share one view.
function wordsOf(rgba) {
  const n = rgba.length >>> 2;
  if (rgba.byteOffset % 4 === 0) return new Uint32Array(rgba.buffer, rgba.byteOffset, n);
  return new Uint32Array(rgba.slice().buffer, 0, n);
}

// Whether every pixel is opaque, whether every pixel is grey, and the colours
// (each with its count and its four channels) when there are at most 256.
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const w = u32[i];
      const found = counts.get(w);
      if (found === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(w, { word: w, r: rgba[d], g: rgba[d + 1], b: rgba[d + 2], a: rgba[d + 3], count: 1 });
      } else {
        found.count++;
      }
    }
  }
  return { opaque, grey, colours: many ? null : [...counts.values()] };
}

// The one fully transparent value (grey, or RGB) the image may key by tRNS
// instead of an alpha channel: every pixel opaque or that exact value at
// alpha 0, and no opaque pixel of the same value. Null when there is none.
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

// The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA.
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Colour forms: palette, grey, RGB, RGBA                              */
/* ------------------------------------------------------------------ */

// A palette's entries in the order a trial writes them: the transparent ones
// first (by alpha), then by `order` — most used, or by luminance.
function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map();
  entries.forEach((c, i) => index.set(c.word, i));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(u32.length);
  for (let i = 0; i < u32.length; i++) indices[i] = index.get(u32[i]);
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

// The forms an image can be written in, each {colourType, bpp, samples, plte, trns}.
// A palette (both orders) when it holds at most 256 colours; a palette of a
// non-grey image holds it in a third of the bytes of RGB or less, so its RGB or
// RGBA form is not tried. A grey image is also tried in its channel form.
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns });
  return forms;
}

/* ------------------------------------------------------------------ */
/* Optimal-parse DEFLATE (from first principles)                       */
/*                                                                     */
/* A zlib stream: header, dynamic-Huffman deflate blocks, Adler-32.    */
/* The parse is a shortest-path dynamic program over the filtered      */
/* bytes: at each position the cheapest way to reach it, by literal or */
/* by an LZ77 match, under the current Huffman code lengths. A fast    */
/* lazy parse seeds the cost model; two DP passes converge it.         */
/* ------------------------------------------------------------------ */

// Length code 257..285: [base length, extra bits]
const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31,
  35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
];
const LEN_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2,
  3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
// Distance code 0..29: [base distance, extra bits]
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193,
  257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6,
  7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

function lengthCode(len) {
  let lo = 0, hi = 28;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (LEN_BASE[mid] <= len) lo = mid; else hi = mid - 1;
  }
  return [257 + lo, LEN_EXTRA[lo], len - LEN_BASE[lo]];
}

function distCode(dist) {
  let lo = 0, hi = 29;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (DIST_BASE[mid] <= dist) lo = mid; else hi = mid - 1;
  }
  return [lo, DIST_EXTRA[lo], dist - DIST_BASE[lo]];
}

// Bit writer, LSB-first as DEFLATE requires.
class BitWriter {
  constructor(capacity = 1 << 20) {
    this.buf = new Uint8Array(capacity);
    this.pos = 0;
    this.bitbuf = 0;
    this.bitcnt = 0;
  }
  _grow(need) {
    if (this.pos + need + 8 > this.buf.length) {
      const nb = new Uint8Array(Math.max(this.buf.length * 2, this.pos + need + 8));
      nb.set(this.buf.subarray(0, this.pos));
      this.buf = nb;
    }
  }
  writeBits(value, count) {
    this.bitbuf |= (value << this.bitcnt) >>> 0;
    this.bitcnt += count;
    while (this.bitcnt >= 8) {
      this._grow(1);
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf >>>= 8;
      this.bitcnt -= 8;
    }
  }
  writeCode(revCode, len) {
    this.writeBits(revCode, len);
  }
  result() {
    if (this.bitcnt > 0) {
      this._grow(1);
      this.buf[this.pos++] = this.bitbuf & 0xff;
      this.bitbuf = 0;
      this.bitcnt = 0;
    }
    return this.buf.subarray(0, this.pos);
  }
}

function reverseBits(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>>= 1;
  }
  return r;
}

// Huffman code lengths from frequencies, no length above `maxLen` (15).
// A heap-based Huffman build, then zlib's overflow repair so the Kraft sum
// stays 1 and no code is longer than the limit.
function huffmanLengths(freq, maxLen = 15) {
  const n = freq.length;
  const lengths = new Uint8Array(n);
  let count = 0;
  for (let i = 0; i < n; i++) if (freq[i] > 0) count++;
  if (count === 0) return lengths;
  if (count === 1) {
    for (let i = 0; i < n; i++) if (freq[i] > 0) { lengths[i] = 1; break; }
    return lengths;
  }
  const heap = [];
  const heapPush = (node) => {
    heap.push(node);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  for (let i = 0; i < n; i++) if (freq[i] > 0) heapPush([freq[i], i, null, null]);
  while (heap.length > 1) {
    const a = heapPop();
    const b = heapPop();
    heapPush([a[0] + b[0], -1, a, b]);
  }
  const stack = [[heap[0], 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop();
    if (node[1] >= 0) lengths[node[1]] = depth;
    else {
      stack.push([node[2], depth + 1]);
      stack.push([node[3], depth + 1]);
    }
  }
  let overflow = 0;
  const blCount = new Int32Array(maxLen + 1);
  for (let i = 0; i < n; i++) {
    const l = lengths[i];
    if (l === 0) continue;
    if (l > maxLen) {
      overflow++;
      blCount[maxLen]++;
    } else {
      blCount[l]++;
    }
  }
  if (overflow > 0) {
    for (let i = 0; i < n; i++) if (lengths[i] > maxLen) lengths[i] = maxLen;
    // The capped lengths are over-subscribed: their Kraft sum exceeds 1.
    // Each repair step below lowers that sum by exactly 2^-maxLen, so run
    // precisely the number of steps that brings it back to 1 (counted in
    // integer units of 2^-maxLen). The old loop ran overflow/2 steps, which
    // is only right when every over-long subtree holds exactly two leaves;
    // deeper subtrees need more steps, and too few leaves an invalid code.
    let K = 0;
    for (let l = 1; l <= maxLen; l++) K += blCount[l] * (1 << (maxLen - l));
    let steps = K - (1 << maxLen);
    while (steps > 0) {
      let bits = maxLen - 1;
      while (bits > 0 && blCount[bits] === 0) bits--;
      if (bits === 0) break;
      blCount[bits]--;
      blCount[bits + 1] += 2;
      blCount[maxLen]--;
      steps--;
    }
    const order = [];
    for (let i = 0; i < n; i++) if (freq[i] > 0) order.push(i);
    order.sort((a, b) => freq[b] - freq[a] || a - b);
    let idx = 0;
    for (let len = 1; len <= maxLen; len++) {
      for (let k = 0; k < blCount[len]; k++) lengths[order[idx++]] = len;
    }
  }
  return lengths;
}

// Canonical Huffman codes from lengths; `rev` holds each code bit-reversed
// for LSB-first packing.
function huffmanCodes(lengths) {
  const n = lengths.length;
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const nextCode = new Int32Array(16);
  let code = 0;
  for (let len = 1; len <= 15; len++) {
    code = (code + blCount[len - 1]) << 1;
    nextCode[len] = code;
  }
  const codes = new Uint32Array(n);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const len = lengths[i];
    if (len === 0) continue;
    codes[i] = nextCode[len];
    nextCode[len]++;
    rev[i] = reverseBits(codes[i], len);
  }
  return { codes, rev, lengths };
}

// Adler-32 checksum (the zlib trailer).
function adler32(data) {
  let a = 1, b = 0;
  const MOD = 65521;
  let i = 0;
  const n = data.length;
  while (i < n) {
    const end = Math.min(i + 5552, n);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= MOD;
    b %= MOD;
  }
  return ((b << 16) | a) >>> 0;
}

// LZ77 matcher: hash chains over 3-byte sequences.
const HASH_BITS = 15;
const HASH_SIZE = 1 << HASH_BITS;
const HASH_MASK = HASH_SIZE - 1;

function hash3(data, i) {
  let h = (data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2];
  h = (h * 2654435761) >>> 0;
  return (h >>> (32 - HASH_BITS)) & HASH_MASK;
}

// The longest match of data[pos..] in the window [max(0, pos-32768), pos).
// A run of identical bytes matches at distance 1 (optimal for a pure run).
// Otherwise the hash chain is walked, up to maxChain candidates; the byte at
// the current best length must match before a full comparison runs.
function longestMatch(data, pos, head, prev, maxChain) {
  const n = data.length;
  const maxLen = Math.min(258, n - pos);
  if (maxLen < 3) return [0, 0];
  if (pos > 0 && data[pos] === data[pos - 1]) {
    let len = 1;
    const b = data[pos];
    while (len < maxLen && data[pos + len] === b) len++;
    if (len >= 3) return [len, 1];
  }
  const h = hash3(data, pos);
  let cand = head[h];
  let bestLen = 2;
  let bestDist = 0;
  let chain = 0;
  const limit = pos - 32768;
  while (cand >= 0 && cand >= limit && chain < maxChain) {
    chain++;
    if (data[cand + bestLen] === data[pos + bestLen]) {
      let len = 0;
      while (len < maxLen && data[cand + len] === data[pos + len]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = pos - cand;
        if (len === maxLen) break;
      }
    }
    cand = prev[cand];
  }
  return bestLen >= 3 ? [bestLen, bestDist] : [0, 0];
}

function insertPos(data, pos, head, prev) {
  const h = hash3(data, pos);
  prev[pos] = head[h];
  head[h] = pos;
}

// Match lengths worth considering: the length-code boundaries, plus the
// longest length itself (the bit cost only changes at boundaries).
const LEN_BOUNDS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];

function matchCost(L, D, litLen, distLen) {
  const [lc, le] = lengthCode(L);
  const [dc, de] = distCode(D);
  return litLen[lc] + le + distLen[dc] + de;
}

// Parse `data` into literals and matches minimising total bits under the
// given Huffman code lengths (a shortest-path dynamic program). Returns
// { ops, litFreq, distFreq }.
function parseOptimal(data, litLen, distLen, maxChain = 64) {
  const n = data.length;
  const cost = new Float64Array(n + 1);
  cost.fill(Infinity);
  cost[0] = 0;
  const prevPos = new Int32Array(n + 1);
  const matchLen = new Int16Array(n + 1);
  const matchDist = new Int32Array(n + 1);
  prevPos[0] = -1;
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    if (cost[i] === Infinity) continue;
    const lc = cost[i] + litLen[data[i]];
    if (lc < cost[i + 1]) {
      cost[i + 1] = lc;
      prevPos[i + 1] = i;
      matchLen[i + 1] = 0;
    }
    if (i + 3 <= n) {
      const [len, dist] = longestMatch(data, i, head, prev, maxChain);
      if (len >= 3) {
        let last = -1;
        for (let b = 0; b < LEN_BOUNDS.length; b++) {
          const L = LEN_BOUNDS[b];
          if (L > len) break;
          if (L === last) continue;
          last = L;
          const c = cost[i] + matchCost(L, dist, litLen, distLen);
          if (c < cost[i + L]) {
            cost[i + L] = c;
            prevPos[i + L] = i;
            matchLen[i + L] = L;
            matchDist[i + L] = dist;
          }
        }
        if (last !== len) {
          const c = cost[i] + matchCost(len, dist, litLen, distLen);
          if (c < cost[i + len]) {
            cost[i + len] = c;
            prevPos[i + len] = i;
            matchLen[i + len] = len;
            matchDist[i + len] = dist;
          }
        }
      }
    }
    if (i + 3 <= n) insertPos(data, i, head, prev);
  }
  const ops = [];
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  let i = n;
  while (i > 0) {
    const p = prevPos[i];
    const L = matchLen[i];
    if (L === 0) {
      ops.push({ lit: data[p] });
      litFreq[data[p]]++;
    } else {
      ops.push({ len: L, dist: matchDist[i] });
      litFreq[lengthCode(L)[0]]++;
      distFreq[distCode(matchDist[i])[0]]++;
    }
    i = p;
  }
  ops.reverse();
  litFreq[256] = 1;
  return { ops, litFreq, distFreq };
}

// A fast lazy-matching parse (the cost model's first estimate, and the
// fallback). At each position the longest match is taken unless the next
// position has a strictly longer one, in which case a literal is emitted.
function parseLazy(data, maxChain = 128) {
  const n = data.length;
  const ops = [];
  const litFreq = new Uint32Array(286);
  const distFreq = new Uint32Array(30);
  const head = new Int32Array(HASH_SIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  let i = 0;
  while (i < n) {
    let len = 0, dist = 0;
    if (i + 3 <= n) {
      [len, dist] = longestMatch(data, i, head, prev, maxChain);
      if (len >= 3 && i + 1 + 3 <= n) {
        const [len2] = longestMatch(data, i + 1, head, prev, maxChain);
        if (len2 > len) len = 0;
      }
    }
    if (len >= 3) {
      ops.push({ len, dist });
      litFreq[lengthCode(len)[0]]++;
      distFreq[distCode(dist)[0]]++;
      for (let k = 0; k < len && i + k + 3 <= n; k++) insertPos(data, i + k, head, prev);
      i += len;
    } else {
      ops.push({ lit: data[i] });
      litFreq[data[i]]++;
      if (i + 3 <= n) insertPos(data, i, head, prev);
      i++;
    }
  }
  litFreq[256] = 1;
  return { ops, litFreq, distFreq };
}

// The order the code-length code's lengths are written in (RFC 1951).
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Run-length-encode the literal/length and distance code lengths (repeat
// codes 16, 17, 18) and build the code-length code.
function encodeCodeLengths(litLen, distLen) {
  let hlit = 286;
  while (hlit > 257 && litLen[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && distLen[hdist - 1] === 0) hdist--;
  const all = [];
  for (let i = 0; i < hlit; i++) all.push(litLen[i]);
  for (let i = 0; i < hdist; i++) all.push(distLen[i]);
  const seq = [];
  let i = 0;
  while (i < all.length) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) {
        const take = Math.min(r, 138);
        seq.push({ sym: 18, extra: take - 11, extraBits: 7 });
        r -= take;
      }
      if (r >= 3) {
        seq.push({ sym: 17, extra: r - 3, extraBits: 3 });
        r = 0;
      }
      while (r > 0) {
        seq.push({ sym: 0, extra: 0, extraBits: 0 });
        r--;
      }
    } else {
      seq.push({ sym: v, extra: 0, extraBits: 0 });
      let r = run - 1;
      while (r >= 3) {
        const take = Math.min(r, 6);
        seq.push({ sym: 16, extra: take - 3, extraBits: 2 });
        r -= take;
      }
      while (r > 0) {
        seq.push({ sym: v, extra: 0, extraBits: 0 });
        r--;
      }
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const s of seq) clFreq[s.sym]++;
  const clLen = huffmanLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && clLen[CL_ORDER[hclen - 1]] === 0) hclen--;
  return { hlit, hdist, hclen, clLen, seq };
}

// Write one dynamic-Huffman deflate block.
function writeDynamicBlock(bw, ops, litLen, distLen, isFinal) {
  const { hlit, hdist, hclen, clLen, seq } = encodeCodeLengths(litLen, distLen);
  const litCodes = huffmanCodes(litLen);
  const distCodes = huffmanCodes(distLen);
  const clCodes = huffmanCodes(clLen);
  bw.writeBits(isFinal ? 1 : 0, 1);
  bw.writeBits(2, 2); // BTYPE = 10 dynamic
  bw.writeBits(hlit - 257, 5);
  bw.writeBits(hdist - 1, 5);
  bw.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) bw.writeBits(clLen[CL_ORDER[k]], 3);
  for (const s of seq) {
    bw.writeCode(clCodes.rev[s.sym], clLen[s.sym]);
    if (s.extraBits > 0) bw.writeBits(s.extra, s.extraBits);
  }
  for (const op of ops) {
    if (op.lit !== undefined) {
      bw.writeCode(litCodes.rev[op.lit], litLen[op.lit]);
    } else {
      const [lc, le, lv] = lengthCode(op.len);
      bw.writeCode(litCodes.rev[lc], litLen[lc]);
      if (le > 0) bw.writeBits(lv, le);
      const [dc, de, dv] = distCode(op.dist);
      bw.writeCode(distCodes.rev[dc], distLen[dc]);
      if (de > 0) bw.writeBits(dv, de);
    }
  }
  bw.writeCode(litCodes.rev[256], litLen[256]);
}

// Compress `data` into a zlib stream by optimal parsing: a lazy parse seeds
// the model, two DP passes converge it, then the final parse is encoded.
// Each 1 MiB block gets its own Huffman tree; the last block is final.
function deflateOptimal(data, iterations = 2, maxChain = 64) {
  const bw = new BitWriter(data.length + 1024);
  bw._grow(2);
  bw.buf[bw.pos++] = 0x78;
  bw.buf[bw.pos++] = 0x9c;
  const n = data.length;
  const blockSize = 1 << 20;
  let offset = 0;
  while (offset < n) {
    const end = Math.min(offset + blockSize, n);
    const chunk = data.subarray(offset, end);
    const isFinal = end === n;
    const lazy = parseLazy(chunk, Math.max(32, maxChain));
    let litLen = huffmanLengths(lazy.litFreq, 15);
    let distLen = huffmanLengths(lazy.distFreq, 15);
    if (litLen[256] === 0) litLen[256] = 1;
    let parsed = parseOptimal(chunk, litLen, distLen, maxChain);
    for (let it = 1; it < iterations; it++) {
      litLen = huffmanLengths(parsed.litFreq, 15);
      distLen = huffmanLengths(parsed.distFreq, 15);
      if (litLen[256] === 0) litLen[256] = 1;
      parsed = parseOptimal(chunk, litLen, distLen, maxChain);
    }
    litLen = huffmanLengths(parsed.litFreq, 15);
    distLen = huffmanLengths(parsed.distFreq, 15);
    if (litLen[256] === 0) litLen[256] = 1;
    writeDynamicBlock(bw, parsed.ops, litLen, distLen, isFinal);
    offset = end;
  }
  const adler = adler32(data);
  const tail = bw.result();
  const out = new Uint8Array(tail.length + 4);
  out.set(tail, 0);
  out[tail.length] = (adler >>> 24) & 0xff;
  out[tail.length + 1] = (adler >>> 16) & 0xff;
  out[tail.length + 2] = (adler >>> 8) & 0xff;
  out[tail.length + 3] = adler & 0xff;
  return out;
}

/* ------------------------------------------------------------------ */
/* Screening and writing                                               */
/* ------------------------------------------------------------------ */

// The zlib setting every candidate is weighed at.
const SCREEN = Object.freeze({ level: 6, memLevel: 8 });

// The bytes a form's PLTE and tRNS chunks take in its file.
const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// The zlib settings the final stream is tried at, in order: plain level 9,
// level 9 with the filtered-data strategy, level 9 with the deepest memory,
// and level 9 with both.
const FINAL_SETTINGS = Object.freeze([
  { level: 9 },
  { level: 9, strategy: constants.Z_FILTERED },
  { level: 9, memLevel: 9 },
  { level: 9, memLevel: 9, strategy: constants.Z_FILTERED },
]);

// Phase A only: screen every form with the five fixed filters, the
// minimum-sum and the fewest-pairs choices per row, at SCREEN with its PLTE
// and tRNS chunks. Returns the forms and every candidate (with its filtered
// data, kept for the finish), plus the best screen bytes overall.
function screenImage(rgba, width, height) {
  const forms = formsOf(rgba);
  const candidates = [];
  const scratchFor = (form) => new Uint8Array(height * (width * form.bpp + 1));
  for (const form of forms) {
    const overhead = chunkBytes(form);
    const scratch = scratchFor(form);
    let formBest = Infinity;
    for (const choice of [0, 1, 2, 3, 4, 'minsum', 'pairs']) {
      filterImage(form.samples, width, height, form.bpp, choice, scratch);
      const bytes = deflateSync(scratch, SCREEN).length + overhead;
      if (bytes < formBest) formBest = bytes;
      candidates.push({ form, choice, bytes, data: scratch.slice() });
    }
    form._screenBest = formBest;
  }
  let bestScreen = Infinity;
  for (const c of candidates) if (c.bytes < bestScreen) bestScreen = c.bytes;
  return { forms, candidates, bestScreen, width, height };
}

// The rest of an image: brute force on the form the cheap screen liked best,
// the best three candidates re-weighed at level 9, then — when `allowOptimal`
// — the optimal-parse stream on the winner's filtered data, kept only when
// it is smaller, so v4 never scores below v2 on any instance. Palette forms
// are skipped for the optimal parse outright: their data is so repetitive
// that zlib is already near-optimal and the parse only costs wall.
function finishImage(screened, allowOptimal) {
  const { forms, candidates, width, height } = screened;
  const ranked = [...forms].sort((a, b) => a._screenBest - b._screenBest).slice(0, 1);
  for (const form of ranked) {
    const overhead = chunkBytes(form);
    const data = filterImage(form.samples, width, height, form.bpp, 'brute');
    const bytes = deflateSync(data, SCREEN).length + overhead;
    candidates.push({ form, choice: 'brute', bytes, data });
  }
  candidates.sort((a, b) => a.bytes - b.bytes);
  const finalists = candidates.slice(0, 3);
  let best = null;
  let bestData = null;
  for (let i = 0; i < finalists.length; i++) {
    const cand = finalists[i];
    const overhead = chunkBytes(cand.form);
    const settings = i === 0
      ? FINAL_SETTINGS
      : i === 1
        ? [{ level: 9 }, { level: 9, strategy: constants.Z_FILTERED }]
        : [{ level: 9 }];
    for (const opts of settings) {
      const idat = deflateSync(cand.data, opts);
      const bytes = idat.length + overhead;
      if (best === null || bytes < best.bytes) {
        best = { form: cand.form, bytes, idat };
        bestData = cand.data;
      }
    }
  }
  if (allowOptimal && best.form.colourType !== 3) {
    try {
      const optimal = deflateOptimal(bestData, 2, 64);
      const bytes = optimal.length + chunkBytes(best.form);
      if (bytes < best.bytes) {
        // The optimal encoder must prove its stream: inflate it back and
        // accept it only when it reproduces the filtered data exactly.
        // A corrupt stream falls back to the zlib winner instead of
        // shipping an unreadable PNG.
        const back = inflateSync(optimal, { maxOutputLength: bestData.length + 1 });
        if (back.length === bestData.length && Buffer.compare(back, Buffer.from(bestData)) === 0) {
          best = { form: best.form, bytes, idat: optimal };
        }
      }
    } catch {
      // Any failure in the optimal path falls back to the zlib winner.
    }
  }
  return pngOfForm(width, height, best.form, best.idat);
}

/* ------------------------------------------------------------------ */
/* The time budget — measured, not guessed                             */
/*                                                                     */
/* Calibrated on the practice set and four generated sets (40 images,  */
/* per-image v3 and v2 timings). Two facts drive it:                   */
/*                                                                     */
/* - The base pipeline's cost (Phase A + brute on one form + Phase C)  */
/*   grows with the winning form's screen bytes — the level-6 size     */
/*   Phase A already measured. A big, poorly compressible RGBA image   */
/*   costs far more than a small grey one.                             */
/* - The optimal parse's extra cost is nearly constant per colour      */
/*   type, set by the filtered data's size, not by how compressible    */
/*   it is: grey ~1.5 s, RGB ~6.1 s, RGBA ~7.6 s. Palette never gets  */
/*   it (zlib is already near-optimal there).                          */
/*                                                                     */
/* The gain buys roughly 16 points on grey, 23 on RGB, 27 on RGBA,    */
/* so grey is the best points-per-second, then RGB, then RGBA. The    */
/* driver spends the optimal work in that order and stops when the     */
/* predicted total reaches the budget, so a hard set degrades to v2    */
/* (safe) instead of timing out (0 points).                            */
/* ------------------------------------------------------------------ */

// Predicted base-pipeline milliseconds for one image, from its winning
// colour type and its best screen bytes.
function baseCostMs(colourType, screen) {
  if (colourType === 3) return 1000;
  if (colourType === 0) return 900 + 0.04 * screen;
  if (colourType === 4) return 1000 + 0.02 * screen;
  if (colourType === 2) return 900 + 0.008 * screen;
  return 1100 + 0.025 * screen; // colour type 6
}

// Predicted extra milliseconds of the optimal parse on one image.
function optimalCostMs(colourType) {
  if (colourType === 3) return 0;
  if (colourType === 0) return 1500;
  if (colourType === 4) return 4000;
  if (colourType === 2) return 6100;
  return 7600; // colour type 6
}

// Priority for optimal work, best points-per-second first.
function optimalPriority(colourType) {
  if (colourType === 0) return 0;
  if (colourType === 4) return 1;
  if (colourType === 2) return 2;
  return 3; // colour type 6
}

const OVERHEAD_MS = 3000;     // process start, decode, file IO
const BUDGET_MS = 46000;      // predicted total; ~14 s under the 60 s wall
const CLOCK_GUARD_MS = 50000; // last resort only; the proxy should never need it

/* ------------------------------------------------------------------ */
/* Driver: screen every instance, spend the budget, write the answers  */
/* ------------------------------------------------------------------ */

const START = Date.now();
const ids = readdirSync(INPUT_DIR).sort();
const jobs = [];
for (const id of ids) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  const screened = screenImage(image.rgba, image.width, image.height);
  let winnerCt = -1;
  let winnerScreen = Infinity;
  for (const c of screened.candidates) {
    if (c.bytes < winnerScreen) {
      winnerScreen = c.bytes;
      winnerCt = c.form.colourType;
    }
  }
  jobs.push({ id, screened, winnerCt, winnerScreen });
}

// Spend the optimal work in priority order (grey, then RGB, then RGBA;
// larger screen first within a type) while the predicted total stays
// inside the budget.
let predicted = OVERHEAD_MS;
for (const j of jobs) predicted += baseCostMs(j.winnerCt, j.winnerScreen);
const optimalJobs = jobs
  .filter((j) => j.winnerCt !== 3)
  .sort((a, b) => optimalPriority(a.winnerCt) - optimalPriority(b.winnerCt) || b.winnerScreen - a.winnerScreen);
const keepOptimal = new Set();
let spent = 0;
for (const j of optimalJobs) {
  const c = optimalCostMs(j.winnerCt);
  if (predicted + spent + c <= BUDGET_MS) {
    keepOptimal.add(j.id);
    spent += c;
  }
}

for (const j of jobs) {
  const allow = keepOptimal.has(j.id) && Date.now() - START < CLOCK_GUARD_MS;
  mkdirSync(join(OUTPUT_DIR, j.id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, j.id, 'image.png'), finishImage(j.screened, allow));
}
