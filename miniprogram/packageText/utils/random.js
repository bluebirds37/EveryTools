'use strict';
/**
 * packageText/utils/random.js
 * Random sources for UUID v4 / snowflake / shuffle.
 * Prefers wx.getRandomValues (CSPRNG); when unavailable (older base library
 * or non-mp test environment) falls back to a Math.random stream re-seeded by
 * a time+counter mixer so output never degenerates into a repeatable LCG, and
 * the caller is informed via secureSource=false.
 */

let _secure = null; // cached availability flag

function hasSecure() {
  if (_secure !== null) return _secure;
  _secure = typeof wx !== 'undefined' && wx && typeof wx.getRandomValues === 'function';
  return _secure;
}

let _mixCounter = 0;

/** Fallback entropy: xorshift seeded from time + counter + Math.random. */
function fallbackBytes(n) {
  const out = new Uint8Array(n);
  let seed = (Date.now() ^ ((++_mixCounter) * 2654435761) ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
  if (seed === 0) seed = 0x9e3779b9;
  for (let i = 0; i < n; i++) {
    // xorshift32
    seed ^= seed << 13; seed >>>= 0;
    seed ^= seed >>> 17;
    seed ^= seed << 5; seed >>>= 0;
    out[i] = seed & 0xff;
  }
  // final scramble of Math.random bytes across half the buffer
  for (let i = 0; i < n; i += 2) {
    out[i] = (out[i] + Math.floor(Math.random() * 256)) & 0xff;
  }
  return out;
}

/** Get n random bytes. Returns { bytes, secure }. */
function getRandomBytes(n) {
  if (hasSecure()) {
    try {
      const res = wx.getRandomValues({ length: Math.min(n, 1024) });
      if (res && res.randomValues) {
        const src = new Uint8Array(res.randomValues);
        if (src.length >= n) return { bytes: src.slice(0, n), secure: true };
        // base library returned fewer than asked: stitch
        const out = new Uint8Array(n);
        out.set(src);
        const more = fallbackBytes(n - src.length);
        out.set(more, src.length);
        return { bytes: out, secure: true };
      }
    } catch (e) { /* fall through */ }
  }
  return { bytes: fallbackBytes(n), secure: false };
}

const HEX = '0123456789abcdef';

/** Single RFC-4122 v4 UUID from supplied bytes (version/variant bits set). */
function uuidV4FromBytes(bytes) {
  let s = '';
  for (let i = 0; i < 16; i++) {
    let b = bytes[i] & 0xff;
    if (i === 6) b = (b & 0x0f) | 0x40; // version 4
    if (i === 8) b = (b & 0x3f) | 0x80; // variant 10xx
    s += HEX[b >> 4] + HEX[b & 15];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += '-';
  }
  return s;
}

/**
 * Generate count UUIDs (1..1000). Deduplicates by construction: if a repeat
 * is detected it is regenerated and the fact reported.
 * @returns { ids: string[], secure: boolean, duplicatesFixed: number }
 */
function uuidV4Batch(count) {
  const n = Math.max(1, Math.min(1000, count | 0));
  const seen = Object.create(null);
  const ids = [];
  let duplicatesFixed = 0;
  let secure = false;
  let guard = 0;
  while (ids.length < n && guard < n + 64) {
    guard++;
    const need = n - ids.length;
    const { bytes, secure: s } = getRandomBytes(16 * need);
    secure = secure || s;
    for (let k = 0; k < need; k++) {
      const id = uuidV4FromBytes(bytes.subarray(k * 16, k * 16 + 16));
      if (seen[id]) { duplicatesFixed++; continue; }
      seen[id] = true;
      ids.push(id);
    }
  }
  return { ids, secure, duplicatesFixed };
}

/* Snowflake: 41-bit ms timestamp (custom epoch 2020-01-01) + 5-bit datacenter
   + 5-bit worker + 12-bit sequence.
   The composed value needs 63 bits, which exceeds Number.MAX_SAFE_INTEGER, so
   the assembly is done with BigInt and only the decimal string is returned
   (a plain Number would silently collapse neighbouring ids). */
const SNOWFLAKE_EPOCH = 1577836800000; // 2020-01-01T00:00:00Z
const WORKER_BITS = 5;
const DATACENTER_BITS = 5;
const SEQUENCE_BITS = 12;
const MAX_WORKER = (1 << WORKER_BITS) - 1;
const MAX_DATACENTER = (1 << DATACENTER_BITS) - 1;
const MAX_SEQUENCE = (1 << SEQUENCE_BITS) - 1;

/**
 * Generate count snowflake ids. workerId (0..31) and datacenterId (0..31)
 * configurable; rejects out-of-range per C6 style.
 * @returns { ids: string[] } or { error }
 */
function snowflakeBatch(count, workerId, datacenterId, startTime) {
  const w = workerId === undefined || workerId === null || workerId === '' ? 1 : Number(workerId);
  const dc = datacenterId === undefined || datacenterId === null || datacenterId === '' ? 0 : Number(datacenterId);
  if (!(w >= 0 && w <= MAX_WORKER && Math.floor(w) === w)) {
    return { error: '参数错误：workerId 需在 0–31 之间' };
  }
  if (!(dc >= 0 && dc <= MAX_DATACENTER && Math.floor(dc) === dc)) {
    return { error: '参数错误：datacenterId 需在 0–31 之间' };
  }
  const n = Math.max(1, Math.min(1000, count | 0));
  const ids = [];
  let ts = startTime !== undefined && startTime !== null ? Number(startTime) : Date.now();
  if (!isFinite(ts) || ts < SNOWFLAKE_EPOCH) ts = SNOWFLAKE_EPOCH; // clock before epoch
  let seq = -1;
  const dcB = BigInt(dc);
  const wB = BigInt(w);
  for (let i = 0; i < n; i++) {
    seq = (seq + 1) & MAX_SEQUENCE;
    if (seq === 0 && i > 0) ts = ts + 1; // sequence rolled over: advance one ms
    const id = (BigInt(ts - SNOWFLAKE_EPOCH) << 22n)
      | (dcB << 17n)
      | (wB << 12n)
      | BigInt(seq);
    ids.push(id.toString());
  }
  return { ids };
}

/** Decode a snowflake id back to its parts (used by the page to verify output). */
function snowflakeParse(idStr) {
  let v;
  try {
    v = BigInt(String(idStr).trim());
  } catch (e) {
    return { error: '参数错误：雪花 ID 需为数字' };
  }
  const ts = Number((v >> 22n) & ((1n << 41n) - 1n)) + SNOWFLAKE_EPOCH;
  return {
    timestamp: ts,
    datacenterId: Number((v >> 17n) & 31n),
    workerId: Number((v >> 12n) & 31n),
    sequence: Number(v & 4095n),
  };
}

/** Fisher-Yates using the secure-or-fallback byte source; returns {result, secure}. */
function shuffleArray(arr) {
  const out = arr.slice();
  const { bytes, secure } = getRandomBytes(out.length * 2);
  let p = 0;
  for (let i = out.length - 1; i > 0; i--) {
    const r = (bytes[p % bytes.length] << 8 | bytes[(p + 1) % bytes.length]) & 0xffff;
    p += 2;
    const j = Math.floor((r / 65536) * (i + 1));
    const t = out[i]; out[i] = out[j]; out[j] = t;
  }
  return { result: out, secure };
}

module.exports = {
  getRandomBytes,
  uuidV4Batch,
  snowflakeBatch,
  shuffleArray,
  snowflakeParse,
  SNOWFLAKE_EPOCH,
  MAX_WORKER,
  MAX_DATACENTER,
};
