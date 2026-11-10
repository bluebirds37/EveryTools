'use strict';
/**
 * packageText/utils/numsys.js
 * Radix conversion (BigInt, bases 2..36) and bitwise ops with optional
 * 32/64-bit two's-complement semantics.
 */

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';

/** Parse an integer string in given base (2..36). Returns { ok, value } or { ok:false, message }. */
function parseIntBase(str, base) {
  if (base < 2 || base > 36) return { ok: false, message: '参数错误：进制需在 2–36 之间' };
  const s = String(str).trim().replace(/\s|_/g, '');
  if (!s) return { ok: false, message: '请输入内容' };
  let sign = 1n;
  let body = s;
  if (body[0] === '+') body = body.slice(1);
  else if (body[0] === '-') { sign = -1n; body = body.slice(1); }
  if (body === '') return { ok: false, message: '参数错误：仅有符号位，缺少数字' };
  let v = 0n;
  const bigBase = BigInt(base);
  for (let i = 0; i < body.length; i++) {
    const d = DIGITS.indexOf(body[i].toLowerCase());
    if (d < 0 || d >= base) {
      return { ok: false, message: '参数错误：含非法字符 "' + body[i] + '"（第 ' + (i + 1) + ' 个字符，' + base + ' 进制）' };
    }
    v = v * bigBase + BigInt(d);
  }
  return { ok: true, value: sign * v };
}

/** BigInt -> digit string in base (no 0x prefix, lowercase, sign kept). */
function toStringBase(v, base) {
  if (base < 2 || base > 36) return '';
  const bigBase = BigInt(base);
  let n = v < 0n ? -v : v;
  if (n === 0n) return '0';
  let s = '';
  while (n > 0n) {
    s = DIGITS[Number(n % bigBase)] + s;
    n = n / bigBase;
  }
  return (v < 0n ? '-' : '') + s;
}

/** Width-limited two's-complement reinterpretation. width null = plain value. */
function toSignedWidth(v, width) {
  if (!width) return v;
  const w = BigInt(width);
  const mod = ((v % (1n << w)) + (1n << w)) % (1n << w);
  return mod >= (1n << (w - 1n)) ? mod - (1n << w) : mod;
}

function toUnsignedWidth(v, width) {
  if (!width) return v < 0n ? v : v;
  const w = BigInt(width);
  return ((v % (1n << w)) + (1n << w)) % (1n << w);
}

/** Binary string grouped by 4 for readability. */
function groupBin(bits) {
  // 必须从低位对齐（同千分位），从左切会得到「1111 1111 1」这种没法读的形状
  return String(bits).replace(/\B(?=([01]{4})+(?![01]))/g, ' ')
}

/**
 * Conversion summary for one value.
 * @param {string} raw input string
 * @param {number} base source base
 * @returns { ok, value, decimal, hex, octal, binary, binGrouped, w32:{signed,hex}, w64:{signed,hex}, twos32Bin, twos64Bin } | {ok:false,message}
 */
function convert(raw, base) {
  const p = parseIntBase(raw, base);
  if (!p.ok) return p;
  const v = p.value;
  const fits32 = v >= -2147483648n && v <= 4294967295n;
  const fits64 = v >= -(1n << 63n) && v < (1n << 64n);
  const u32 = toUnsignedWidth(v, 32);
  const u64 = toUnsignedWidth(v, 64);
  const twos32Bin = u32.toString(2).padStart(32, '0');
  const twos64Bin = u64.toString(2).padStart(64, '0');
  return {
    ok: true,
    value: v,
    decimal: v.toString(10),
    binary: toStringBase(v, 2),
    octal: toStringBase(v, 8),
    hex: toStringBase(v, 16),
    binGrouped: (v < 0n ? '-' : '') + groupBin(toStringBase(v < 0n ? -v : v, 2)),
    w32: fits32 ? { signed: toSignedWidth(v, 32).toString(10), hex: u32.toString(16) } : null,
    w64: fits64 ? { signed: toSignedWidth(v, 64).toString(10), hex: u64.toString(16) } : null,
    twos32Bin: fits32 ? groupBin(twos32Bin) : null,
    twos32Hex: fits32 ? u32.toString(16).padStart(8, '0') : null,
    twos64Bin: fits64 ? groupBin(twos64Bin) : null,
    twos64Hex: fits64 ? u64.toString(16).padStart(16, '0') : null,
    outOfRange32: !fits32,
    outOfRange64: !fits64,
  };
}

/**
 * Bitwise op between two values (BigInt). width: null | 32 | 64 — when set,
 * operands are reinterpreted as unsigned within width and the result is
 * truncated to width.
 * @returns { ok, unsigned: string(hex+dec), signed } | { ok:false, message }
 */
function bitOp(aRaw, base, bRaw, op, width) {
  const a = parseIntBase(aRaw, base);
  if (!a.ok) return a;
  const x = a.value;
  let y = 0n;
  if (op !== 'not') {
    const b = parseIntBase(bRaw === '' ? '0' : bRaw, base);
    if (!b.ok) return b;
    y = b.value;
  }
  const w = width ? BigInt(width) : null;
  const wrap = (v) => (w ? ((v % (1n << w)) + (1n << w)) % (1n << w) : v);
  const signedOf = (v) => (w ? toSignedWidth(v, width) : v);
  const shift = y < 0n ? -y : y;
  let r;
  switch (op) {
    case 'and': r = wrap(x) & wrap(y); break;
    case 'or': r = wrap(x) | wrap(y); break;
    case 'xor': r = wrap(x) ^ wrap(y); break;
    case 'not': r = wrap(~x); break;
    case 'shl': r = wrap(x << shift); break;
    case 'shrArith': r = wrap(signedOf(wrap(x)) >> shift); break;
    case 'shrLogic': r = wrap(x) >> shift; break;
    default: return { ok: false, message: '参数错误：未知位运算 "' + op + '"' };
  }
  return {
    ok: true,
    signed: signedOf(r).toString(10),
    unsigned: w ? r.toString(10) : (r >= 0n ? r.toString(10) : null),
    hex: (w ? r.toString(16) : toStringBase(r, 16)),
    binary: w ? groupBin(r.toString(2)) : (r < 0n ? '-' : '') + groupBin(toStringBase(r < 0n ? -r : r, 2)),
    width: width || null,
  };
}

module.exports = { parseIntBase, toStringBase, toSignedWidth, toUnsignedWidth, convert, bitOp, groupBin, DIGITS };
