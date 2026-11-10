'use strict';
/**
 * packageText/utils/codec.js
 * UTF-8 byte level codecs used by base64 / url / hex / unicode / html tools.
 * Strict validation: every decode error carries the offending character index.
 * No wx / network dependency (offline safe).
 */

const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Encode a JS string into a Uint8Array of UTF-8 bytes. Lone surrogates -> throw with position. */
function utf8ToBytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let cp = str.charCodeAt(i);
    if (cp >= 0xd800 && cp <= 0xdbff) {
      const lo = i + 1 < str.length ? str.charCodeAt(i + 1) : -1;
      if (lo >= 0xdc00 && lo <= 0xdfff) {
        cp = ((cp - 0xd800) << 10) + (lo - 0xdc00) + 0x10000;
        i++;
      } else {
        const err = new Error('参数错误：含非法字符（第 ' + (i + 1) + ' 个字符为孤立高位代理）');
        err.index = i;
        throw err;
      }
    } else if (cp >= 0xdc00 && cp <= 0xdfff) {
      const err = new Error('参数错误：含非法字符（第 ' + (i + 1) + ' 个字符为孤立低位代理）');
      err.index = i;
      throw err;
    }
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

/** Decode UTF-8 bytes -> string. Invalid sequence -> throw. */
function bytesToUtf8(bytes) {
  let out = '';
  let i = 0;
  const n = bytes.length;
  while (i < n) {
    const b = bytes[i];
    let cp;
    let size;
    if (b < 0x80) { cp = b; size = 1; }
    else if ((b & 0xe0) === 0xc0) { cp = b & 0x1f; size = 2; }
    else if ((b & 0xf0) === 0xe0) { cp = b & 0x0f; size = 3; }
    else if ((b & 0xf8) === 0xf0) { cp = b & 0x07; size = 4; }
    else { const e = new Error('解码失败：第 ' + (i + 1) + ' 字节不是合法的 UTF-8 序列'); e.index = i; throw e; }
    if (i + size > n) { const e = new Error('解码失败：第 ' + (i + 1) + ' 字节起 UTF-8 序列不完整'); e.index = i; throw e; }
    for (let k = 1; k < size; k++) {
      const c = bytes[i + k];
      if ((c & 0xc0) !== 0x80) { const e = new Error('解码失败：第 ' + (i + k + 1) + ' 字节不是合法的 UTF-8 续字节'); e.index = i + k; throw e; }
      cp = (cp << 6) | (c & 0x3f);
    }
    // reject overlong / surrogates / out of range
    if ((size === 2 && cp < 0x80) || (size === 3 && cp < 0x800) || (size === 4 && cp < 0x10000) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      const e = new Error('解码失败：第 ' + (i + 1) + ' 字节起为非法 UTF-8 编码'); e.index = i; throw e;
    }
    if (cp < 0x10000) out += String.fromCharCode(cp);
    else {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    }
    i += size;
  }
  return out;
}

/** Uint8Array -> base64 string. variant: 'std' | 'url' (url omits padding). */
function bytesToBase64(bytes, variant) {
  const alpha = variant === 'url' ? B64_URL : B64_STD;
  let out = '';
  const n = bytes.length;
  for (let i = 0; i < n; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < n ? bytes[i + 1] : 0;
    const b2 = i + 2 < n ? bytes[i + 2] : 0;
    const v = (b0 << 16) | (b1 << 8) | b2;
    out += alpha[(v >> 18) & 63] + alpha[(v >> 12) & 63];
    out += i + 1 < n ? alpha[(v >> 6) & 63] : (variant === 'url' ? '' : '=');
    out += i + 2 < n ? alpha[v & 63] : (variant === 'url' ? '' : '=');
  }
  return out;
}

/** base64 string -> Uint8Array. Throws Error with .index (1-based msg) on illegal char. */
function base64ToBytes(str, variant) {
  const alpha = variant === 'url' ? B64_URL : B64_STD;
  const rev = {};
  for (let i = 0; i < 64; i++) rev[alpha[i]] = i;
  let clean = '';
  const posMap = []; // original 0-based index of each kept char
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') continue;
    if (ch === '=') continue; // padding stripped below
    if (rev[ch] === undefined) {
      const e = new Error('参数错误：含非法字符 "' + ch + '"（第 ' + (i + 1) + ' 个字符）');
      e.index = i;
      throw e;
    }
    clean += ch;
    posMap.push(i);
  }
  const rem = clean.length % 4;
  if (rem === 1) {
    const lastIdx = posMap[posMap.length - 1];
    const e = new Error('参数错误：Base64 长度不合法（结尾多出 1 个编码字符，位于第 ' + (lastIdx + 1) + ' 个字符附近）');
    e.index = lastIdx;
    throw e;
  }
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = rev[clean[i]];
    const c1 = rev[clean[i + 1]];
    const c2 = i + 2 < clean.length ? rev[clean[i + 2]] : -1;
    const c3 = i + 3 < clean.length ? rev[clean[i + 3]] : -1;
    let v = (c0 << 18) | (c1 << 12);
    if (c2 >= 0) v |= c2 << 6;
    if (c3 >= 0) v |= c3;
    bytes[p++] = (v >> 16) & 0xff;
    if (c2 >= 0) bytes[p++] = (v >> 8) & 0xff;
    if (c3 >= 0) bytes[p++] = v & 0xff;
  }
  return bytes.subarray(0, p);
}

function encodeBase64(text, variant) {
  return bytesToBase64(utf8ToBytes(text), variant);
}

function decodeBase64ToStr(b64, variant) {
  return bytesToUtf8(base64ToBytes(b64, variant));
}

/** byte array -> lowercase hex */
function bytesToHex(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] >> 4).toString(16) + (bytes[i] & 15).toString(16);
  }
  return s;
}

/** hex string -> Uint8Array; illegal char throws with index */
function hexToBytes(hex) {
  let h = hex.replace(/^0x/i, '').replace(/\s+/g, '');
  if (h.length % 2 !== 0) {
    const e = new Error('参数错误：Hex 长度为奇数（第 ' + (h.length + 1) + ' 个字符无法配对）');
    e.index = h.length - 1;
    throw e;
  }
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    const hi = parseInt(h[i * 2], 16);
    const lo = parseInt(h[i * 2 + 1], 16);
    if (isNaN(hi) || isNaN(lo)) {
      const bad = isNaN(hi) ? i * 2 : i * 2 + 1;
      const e = new Error('参数错误：含非法字符 "' + h[bad] + '"（第 ' + (bad + 1) + ' 个字符）');
      e.index = bad;
      throw e;
    }
    out[i] = (hi << 4) | lo;
  }
  return out;
}

/** Escape non-ASCII (and existing backslashes) into \uXXXX / \xNN form. */
function unicodeEscape(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    const code = str.charCodeAt(i);
    if (c === '\\') out += '\\\\';
    else if (code >= 0x20 && code < 0x7f) out += c;
    else if (code < 0x100) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += '\\u' + code.toString(16).padStart(4, '0');
  }
  return out;
}

/** Unescape \uXXXX \xNN \\\\ and common escapes. Illegal escape throws with index. */
function unicodeUnescape(str) {
  let out = '';
  let i = 0;
  const readHex = (start, len) => {
    const seg = str.substr(start, len);
    if (!/^[0-9a-fA-F]+$/.test(seg)) {
      const e = new Error('参数错误：非法转义序列 "\\u' + seg + '"（第 ' + (start + 1) + ' 个字符）');
      e.index = start;
      throw e;
    }
    return parseInt(seg, 16);
  };
  while (i < str.length) {
    const c = str[i];
    if (c !== '\\') { out += c; i++; continue; }
    const n = str[i + 1];
    if (n === 'u' && i + 5 < str.length + 1) {
      const code = readHex(i + 2, 4);
      // combine surrogate pair if followed by another \uXXXX low surrogate
      if (code >= 0xd800 && code <= 0xdbff && str[i + 6] === '\\' && str[i + 7] === 'u') {
        const lo = readHex(i + 8, 4);
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          out += String.fromCharCode(code, lo);
          i += 12;
          continue;
        }
      }
      out += String.fromCharCode(code);
      i += 6;
    } else if (n === 'x') {
      out += String.fromCharCode(readHex(i + 2, 2));
      i += 4;
    } else if (n === 'n') { out += '\n'; i += 2; }
    else if (n === 'r') { out += '\r'; i += 2; }
    else if (n === 't') { out += '\t'; i += 2; }
    else if (n === '0') { out += '\0'; i += 2; }
    else if (n === '\\') { out += '\\'; i += 2; }
    else if (n === '"') { out += '"'; i += 2; }
    else if (n === "'") { out += "'"; i += 2; }
    else {
      const e = new Error('参数错误：非法转义序列 "\\u' + (n === undefined ? '' : n) + '"（第 ' + (i + 1) + ' 个字符）');
      e.index = i;
      throw e;
    }
  }
  return out;
}

const HTML_NAMED = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_NAMED_REV = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };

function htmlEscape(str) {
  return str.replace(/[&<>"']/g, (c) => HTML_NAMED[c]);
}

function htmlUnescape(str) {
  return str.replace(/&(#\d+|#x[0-9a-fA-F]+|\w+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (isNaN(code) || code < 0 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch (e) { return m; }
    }
    const key = body.toLowerCase();
    return Object.prototype.hasOwnProperty.call(HTML_NAMED_REV, key) ? HTML_NAMED_REV[key] : m;
  });
}

/** URL percent-encoding with encodeURIComponent semantics, UTF-8 byte level. */
function urlEncodeComponent(str) {
  const bytes = utf8ToBytes(str);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    const ch = String.fromCharCode(c);
    // encodeURIComponent 不转义的集合：字母数字 与 - _ . ! ~ * ' ( )（缺 !'()* 会与浏览器结果不一致）
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f || c === 0x2e || c === 0x7e || c === 0x21 || c === 0x2a || c === 0x27 || c === 0x28 || c === 0x29) {
      out += ch;
    } else {
      out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

/** Keep unreserved + reserved + path chars, percent-encode the rest (encodeURI semantics). */
function urlEncodeUri(str) {
  const bytes = utf8ToBytes(str);
  let out = '';
  const keep = ";/?:@&=+$,#-_.!~*'()";
  for (let i = 0; i < bytes.length; i++) {
    const c = bytes[i];
    const ch = String.fromCharCode(c);
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || keep.indexOf(ch) >= 0) out += ch;
    else out += '%' + c.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Percent-decode. plusAsSpace: query-string mode ('+' -> ' '). Throws with index. */
function urlDecode(str, plusAsSpace) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '%') {
      const hex = str.substr(i + 1, 2);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) {
        const e = new Error('参数错误：非法转义序列 "%' + hex + '"（第 ' + (i + 1) + ' 个字符）');
        e.index = i;
        throw e;
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else if (c === '+' && plusAsSpace) {
      bytes.push(0x20);
    } else {
      const code = c.charCodeAt(0);
      if (code < 0x80) bytes.push(code);
      else {
        // raw non-ascii char: re-encode its UTF-8 bytes (lenient)
        const b = utf8ToBytes(c);
        for (let k = 0; k < b.length; k++) bytes.push(b[k]);
        if (c === '\ud800' || (code >= 0xd800 && code <= 0xdbff)) i++;
      }
    }
  }
  return bytesToUtf8(new Uint8Array(bytes));
}

module.exports = {
  utf8ToBytes,
  bytesToUtf8,
  bytesToBase64,
  base64ToBytes,
  encodeBase64,
  decodeBase64ToStr,
  bytesToHex,
  hexToBytes,
  unicodeEscape,
  unicodeUnescape,
  htmlEscape,
  htmlUnescape,
  urlEncodeComponent,
  urlEncodeUri,
  urlDecode,
};
