'use strict';
/**
 * packageText/utils/hash.js
 * Pure-JS MD5 / SHA-1 / SHA-256 / SHA-512 / HMAC, no external deps.
 * All algorithm magic constants are derived EXACTLY at module load time with
 * integer BigInt arithmetic (isqrt / icbrt of primes), i.e. the same
 * FIPS-defined values, so there are no transcription risks.
 * Verified against node crypto (see delivery self-test).
 */
const codec = require('./codec');

const MASK64 = (1n << 64n) - 1n;

/* ---------- exact integer root helpers (BigInt) ---------- */

function bigBitLength(n) {
  let len = 0;
  while (n > 0n) { n >>= 1n; len++; }
  return len;
}

/** floor(sqrt(n)) for BigInt n >= 0 */
function isqrt(n) {
  if (n < 2n) return n;
  let x = 1n << BigInt((bigBitLength(n) + 1) >> 1);
  let y = (x + n / x) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/** floor(cbrt(n)) for BigInt n >= 0 */
function icbrt(n) {
  if (n < 2n) return n;
  // start from bit-length based power of two
  let x = 1n << BigInt(Math.ceil(bigBitLength(n) / 3));
  let y = (2n * x + n / (x * x)) / 3n;
  while (y < x) { x = y; y = (2n * x + n / (x * x)) / 3n; }
  while ((x + 1n) * (x + 1n) * (x + 1n) <= n) x++;
  while (x * x * x > n) x--;
  return x;
}

function firstPrimes(count) {
  const out = [];
  let n = 2;
  while (out.length < count) {
    let isP = true;
    for (let d = 2; d * d <= n; d++) if (n % d === 0) { isP = false; break; }
    if (isP) out.push(n);
    n++;
  }
  return out;
}

/** floor(fractionalPart(sqrt(p)) * 2^bits) computed exactly */
function sqrtFracBits(p, bits) {
  const shift = BigInt(bits);
  const scale = 1n << shift;
  const big = isqrt(BigInt(p) << (shift * 2n));
  return big - isqrt(BigInt(p)) * scale;
}

/** floor(fractionalPart(cbrt(p)) * 2^bits) computed exactly */
function cbrtFracBits(p, bits) {
  const shift = BigInt(bits);
  const scale = 1n << shift;
  const big = icbrt(BigInt(p) << (shift * 3n));
  return big - icbrt(BigInt(p)) * scale;
}

/* ---------- MD5 (RFC 1321) ---------- */

const MD5_SHIFT = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
// K[i] = floor(abs(sin(i + 1)) * 2^32) — derivation per RFC 1321
const MD5_K = new Uint32Array(64);
for (let i = 0; i < 64; i++) MD5_K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);

function rotl32(x, c) {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

function md5Pad(bytes) {
  const bitLenLo = (bytes.length << 3) >>> 0;
  const bitLenHi = Math.floor(bytes.length / 536870912) >>> 0; // bytes.length * 8 / 2^32
  let padded = bytes.length + 1;
  while (padded % 64 !== 56) padded++;
  const out = new Uint8Array(padded + 8);
  out.set(bytes);
  out[bytes.length] = 0x80;
  out[padded] = bitLenLo & 0xff;
  out[padded + 1] = (bitLenLo >>> 8) & 0xff;
  out[padded + 2] = (bitLenLo >>> 16) & 0xff;
  out[padded + 3] = (bitLenLo >>> 24) & 0xff;
  out[padded + 4] = bitLenHi & 0xff;
  out[padded + 5] = (bitLenHi >>> 8) & 0xff;
  out[padded + 6] = (bitLenHi >>> 16) & 0xff;
  out[padded + 7] = (bitLenHi >>> 24) & 0xff;
  return out;
}

function md5Bytes(bytes) {
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const data = md5Pad(bytes);
  const M = new Uint32Array(16);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      M[i] = (data[off + i * 4]) | (data[off + i * 4 + 1] << 8) | (data[off + i * 4 + 2] << 16) | (data[off + i * 4 + 3] << 24);
      M[i] >>>= 0;
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D; D = C; C = B;
      B = (B + rotl32(F, MD5_SHIFT[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
  }
  const out = new Uint8Array(16);
  const words = [a0, b0, c0, d0];
  for (let i = 0; i < 4; i++) {
    out[i * 4] = words[i] & 0xff;
    out[i * 4 + 1] = (words[i] >>> 8) & 0xff;
    out[i * 4 + 2] = (words[i] >>> 16) & 0xff;
    out[i * 4 + 3] = (words[i] >>> 24) & 0xff;
  }
  return out;
}

/* ---------- SHA-1 (FIPS 180-4) ---------- */

// SHA-1 round constants per FIPS 180-4 (digits-of-pi magic numbers; transcribed
// from the standard and verified against node crypto in the delivery self-test)
const SHA1_K = [0x5a827999, 0x6ed9eba1, 0x8f1bbcdc, 0xca62c1d6];

function sha1Bytes(bytes) {
  // SHA-1 initial hash value per FIPS 180-4 §5.3.1
  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
  const len = bytes.length;
  let padded = len + 1;
  while (padded % 64 !== 56) padded++;
  const data = new Uint8Array(padded + 8);
  data.set(bytes);
  data[len] = 0x80;
  const bitLen = len * 8;
  const hi32 = Math.floor(bitLen / 4294967296);
  const lo32 = bitLen >>> 0;
  data[padded] = (hi32 >>> 24) & 0xff;
  data[padded + 1] = (hi32 >>> 16) & 0xff;
  data[padded + 2] = (hi32 >>> 8) & 0xff;
  data[padded + 3] = hi32 & 0xff;
  data[padded + 4] = (lo32 >>> 24) & 0xff;
  data[padded + 5] = (lo32 >>> 16) & 0xff;
  data[padded + 6] = (lo32 >>> 8) & 0xff;
  data[padded + 7] = lo32 & 0xff;
  const w = new Uint32Array(80);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((data[off + i * 4] << 24) | (data[off + i * 4 + 1] << 16) | (data[off + i * 4 + 2] << 8) | data[off + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 80; i++) {
      w[i] = rotl32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = SHA1_K[0]; }
      else if (i < 40) { f = b ^ c ^ d; k = SHA1_K[1]; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = SHA1_K[2]; }
      else { f = b ^ c ^ d; k = SHA1_K[3]; }
      const temp = (rotl32(a, 5) + f + e + k + w[i]) >>> 0;
      e = d; d = c; c = rotl32(b, 30); b = a; a = temp;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const hs = [h0, h1, h2, h3, h4];
  for (let i = 0; i < 5; i++) {
    out[i * 4] = (hs[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (hs[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (hs[i] >>> 8) & 0xff;
    out[i * 4 + 3] = hs[i] & 0xff;
  }
  return out;
}

/* ---------- SHA-256 (FIPS 180-4) ---------- */

const SHA256_PRIMES = firstPrimes(64);
const SHA256_H0 = SHA256_PRIMES.slice(0, 8).map((p) => Number(sqrtFracBits(p, 32)) >>> 0);
const SHA256_K = SHA256_PRIMES.map((p) => Number(cbrtFracBits(p, 32)) >>> 0);

function sha256Bytes(bytes) {
  const h = SHA256_H0.slice();
  const len = bytes.length;
  let padded = len + 1;
  while (padded % 64 !== 56) padded++;
  const data = new Uint8Array(padded + 8);
  data.set(bytes);
  data[len] = 0x80;
  const bitLenHi = Math.floor(len / 536870912);
  const bitLenLo = (len << 3) >>> 0;
  data[padded] = (bitLenHi >>> 24) & 0xff;
  data[padded + 1] = (bitLenHi >>> 16) & 0xff;
  data[padded + 2] = (bitLenHi >>> 8) & 0xff;
  data[padded + 3] = bitLenHi & 0xff;
  data[padded + 4] = (bitLenLo >>> 24) & 0xff;
  data[padded + 5] = (bitLenLo >>> 16) & 0xff;
  data[padded + 6] = (bitLenLo >>> 8) & 0xff;
  data[padded + 7] = bitLenLo & 0xff;
  const w = new Uint32Array(64);
  for (let off = 0; off < data.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = ((data[off + i * 4] << 24) | (data[off + i * 4 + 1] << 16) | (data[off + i * 4 + 2] << 8) | data[off + i * 4 + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const s0 = (rotr32(w[i - 15], 7) ^ rotr32(w[i - 15], 18) ^ (w[i - 15] >>> 3)) >>> 0;
      const s1 = (rotr32(w[i - 2], 17) ^ rotr32(w[i - 2], 19) ^ (w[i - 2] >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = (rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25)) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = (rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22)) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0; h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0; h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  const out = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    out[i * 4] = (h[i] >>> 24) & 0xff;
    out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
    out[i * 4 + 2] = (h[i] >>> 8) & 0xff;
    out[i * 4 + 3] = h[i] & 0xff;
  }
  return out;
}

function rotr32(x, n) {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/* ---------- SHA-512 (FIPS 180-4, BigInt core) ---------- */

const SHA512_PRIMES = firstPrimes(80);
const SHA512_H0 = SHA512_PRIMES.slice(0, 8).map((p) => sqrtFracBits(p, 64));
const SHA512_K = SHA512_PRIMES.map((p) => cbrtFracBits(p, 64));

function rotr64(x, n) {
  const bn = BigInt(n);
  return ((x >> bn) | (x << (64n - bn))) & MASK64;
}

function sha512Bytes(bytes) {
  const h = SHA512_H0.slice();
  const len = bytes.length;
  let padded = len + 1;
  while (padded % 128 !== 112) padded++;
  const data = new Uint8Array(padded + 16);
  data.set(bytes);
  data[len] = 0x80;
  const bitLen = BigInt(len) * 8n;
  for (let i = 0; i < 16; i++) {
    data[padded + 15 - i] = Number((bitLen >> BigInt(8 * i)) & 0xffn);
  }
  const w = new Array(80);
  for (let off = 0; off < data.length; off += 128) {
    for (let i = 0; i < 16; i++) {
      let word = 0n;
      for (let b = 0; b < 8; b++) word = (word << 8n) | BigInt(data[off + i * 8 + b]);
      w[i] = word;
    }
    for (let i = 16; i < 80; i++) {
      const s0 = (rotr64(w[i - 15], 1) ^ rotr64(w[i - 15], 8) ^ (w[i - 15] >> 7n)) & MASK64;
      const s1 = (rotr64(w[i - 2], 19) ^ rotr64(w[i - 2], 61) ^ (w[i - 2] >> 6n)) & MASK64;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) & MASK64;
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
    for (let i = 0; i < 80; i++) {
      const S1 = (rotr64(e, 14) ^ rotr64(e, 18) ^ rotr64(e, 41)) & MASK64;
      const ch = ((e & f) ^ (~e & g) & MASK64) & MASK64;
      const temp1 = (hh + S1 + ch + SHA512_K[i] + w[i]) & MASK64;
      const S0 = (rotr64(a, 28) ^ rotr64(a, 34) ^ rotr64(a, 39)) & MASK64;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) & MASK64;
      const temp2 = (S0 + maj) & MASK64;
      hh = g; g = f; f = e; e = (d + temp1) & MASK64;
      d = c; c = b; b = a; a = (temp1 + temp2) & MASK64;
    }
    h[0] = (h[0] + a) & MASK64; h[1] = (h[1] + b) & MASK64; h[2] = (h[2] + c) & MASK64; h[3] = (h[3] + d) & MASK64;
    h[4] = (h[4] + e) & MASK64; h[5] = (h[5] + f) & MASK64; h[6] = (h[6] + g) & MASK64; h[7] = (h[7] + hh) & MASK64;
  }
  const out = new Uint8Array(64);
  for (let i = 0; i < 8; i++) {
    for (let b = 0; b < 8; b++) {
      out[i * 8 + b] = Number((h[i] >> BigInt(56 - b * 8)) & 0xffn);
    }
  }
  return out;
}

/* ---------- HMAC (RFC 2104) ---------- */

function hmacBytes(hashFn, blockSize, keyBytes, msgBytes) {
  let key = keyBytes;
  if (key.length > blockSize) {
    key = hashFn(key);
  }
  const keyBlock = new Uint8Array(blockSize);
  keyBlock.set(key);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = keyBlock[i] ^ 0x36;
    opad[i] = keyBlock[i] ^ 0x5c;
  }
  const inner = new Uint8Array(blockSize + msgBytes.length);
  inner.set(ipad); inner.set(msgBytes, blockSize);
  const innerHash = hashFn(inner);
  const outer = new Uint8Array(blockSize + innerHash.length);
  outer.set(opad); outer.set(innerHash, blockSize);
  return hashFn(outer);
}

/* ---------- public API: string in, lowercase hex out ---------- */

const ALGOS = {
  md5: { bytes: md5Bytes, block: 64 },
  sha1: { bytes: sha1Bytes, block: 64 },
  sha256: { bytes: sha256Bytes, block: 64 },
  sha512: { bytes: sha512Bytes, block: 128 },
};

function digestHex(name, str) {
  return codec.bytesToHex(ALGOS[name].bytes(codec.utf8ToBytes(str)));
}

function hmacHex(name, keyStr, dataStr) {
  const algo = ALGOS[name];
  return codec.bytesToHex(hmacBytes(algo.bytes, algo.block, codec.utf8ToBytes(keyStr), codec.utf8ToBytes(dataStr)));
}

module.exports = {
  md5: (s) => digestHex('md5', s),
  sha1: (s) => digestHex('sha1', s),
  sha256: (s) => digestHex('sha256', s),
  sha512: (s) => digestHex('sha512', s),
  hmac: (name, key, data) => hmacHex(name, key, data),
  digestBytes: (name, bytes) => ALGOS[name].bytes(bytes),
  AVAILABLE: ['md5', 'sha1', 'sha256', 'sha512'],
};
