// png-squeeze-01 v1 — a lossless PNG rewriter, by rommya33.
//
// It reads each stored RGBA screenshot from the input directory and rewrites it
// in the smallest exact form it can take: a palette when the image holds at most
// 256 colours, grey or grey-and-alpha when every pixel is grey, RGB or RGBA
// otherwise, with a tRNS key standing in for an alpha channel when exactly one
// fully transparent value exists and no opaque pixel uses it. Filters are picked
// per row by the PNG minimum-sum heuristic, and the whole image is also tried
// with each single fixed filter; every candidate is weighed by zlib at level 6
// (plus its PLTE and tRNS chunks) and the winner is written at level 9.
//
// Node 22, standard library only. No network, no clock, no randomness: two runs
// are byte-identical.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/* ------------------------------------------------------------------ */
/* CRC-32 (ISO 3309, PNG's own), from its polynomial, table built once */
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
/* PNG writing: signature, chunks, IHDR                                */
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
  d[8] = 8; // bit depth
  d[9] = colourType; // compression 0, filter 0, interlace 0 are already zero
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

// Row `cur` (stride samples, bpp bytes a pixel), `prev` the row above or null,
// filtered by `type` into out[0, stride).
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

// The minimum-sum heuristic's cost: the filtered bytes read as signed, absolute.
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

// The raw data of `samples` (height rows of width x bpp samples), each row behind
// its filter byte, written into `out` when given (a fresh buffer otherwise).
// `choice` is one fixed filter type (0 to 4) for every row, or 'minsum': each row
// the type whose filtered bytes have the least signed sum, the lower type on a tie.
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
  const trial = [0, 1, 2, 3, 4].map(() => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t]);
      const s = signedSum(trial[t]);
      if (s < best) {
        best = s;
        type = t;
      }
    }
    raw[y * (stride + 1)] = type;
    raw.set(trial[type], y * (stride + 1) + 1);
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
/* Screening and writing                                               */
/* ------------------------------------------------------------------ */

// The zlib setting every candidate is weighed at.
const SCREEN = Object.freeze({ level: 6, memLevel: 8 });

// The bytes a form's PLTE and tRNS chunks take in its file.
const chunkBytes = (form) =>
  (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

// The smallest exact PNG of an image: every form, each with per-row minimum-sum
// filtering and each single fixed filter, weighed at SCREEN with its PLTE and
// tRNS chunks; the winner written at zlib level 9.
function squeeze(rgba, width, height) {
  let best = null;
  let bestData = null;
  for (const form of formsOf(rgba)) {
    const overhead = chunkBytes(form);
    // One scratch buffer per form, rewritten by every candidate; only the
    // winner's data is copied out, so the big RGBA images are not reallocated
    // six times over.
    const scratch = new Uint8Array(height * (width * form.bpp + 1));
    for (const choice of ['minsum', 0, 1, 2, 3, 4]) {
      filterImage(form.samples, width, height, form.bpp, choice, scratch);
      const zlib = deflateSync(scratch, SCREEN);
      const bytes = zlib.length + overhead;
      if (best === null || bytes < best.bytes) {
        best = { form, bytes };
        bestData = scratch.slice();
      }
    }
  }
  const idat = deflateSync(bestData, { level: 9 });
  return pngOfForm(width, height, best.form, idat);
}

/* ------------------------------------------------------------------ */
/* Driver: every instance in the input directory                       */
/* ------------------------------------------------------------------ */

for (const id of readdirSync(INPUT_DIR).sort()) {
  const image = decodePng(new Uint8Array(readFileSync(join(INPUT_DIR, id, 'image.png'))));
  if (!image.ok) throw new Error(`${id}/image.png: ${image.why}`);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'image.png'), squeeze(image.rgba, image.width, image.height));
}
