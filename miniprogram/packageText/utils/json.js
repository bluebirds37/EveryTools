'use strict';
/**
 * packageText/utils/json.js
 * JSON format / minify / validate with precise error location, plus a flat
 * node list for the tree view (fold + JSON Pointer copy).
 * Error strategy: we never rely on the JS engine's exception text — a small
 * recursive-descent syntax scanner locates the first illegal offset itself.
 */

const MAX_PTR_NODES = 20000; // hard cap for the flattened tree

/** Convert a 0-based char offset into {line, col} (1-based). */
function offsetToLineCol(text, offset) {
  let line = 1;
  let col = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1; }
    else col++;
  }
  return { line, col };
}

/** Context snippet around an offset: start-of-line trimmed, +-40 chars. */
function contextSnippet(text, offset) {
  const start = Math.max(0, offset - 40);
  const end = Math.min(text.length, offset + 40);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end).replace(/\n/g, '\\n') + suffix;
}

/**
 * Syntax-only JSON scanner (recursive descent). Returns null when valid, or
 * { offset, expected } describing the first failure. Whitespace-tolerant.
 */
function findSyntaxError(text) {
  let i = 0;
  const n = text.length;
  const WS = ' \t\n\r';
  const err = (msg, at) => ({ offset: at === undefined ? i : at, expected: msg });
  function skipWs() { while (i < n && WS.indexOf(text[i]) >= 0) i++; }
  function parseValue(depth) {
    if (depth > 200) return err('嵌套层级过深');
    skipWs();
    if (i >= n) return err('意外的结尾（输入不完整）');
    const c = text[i];
    if (c === '{') return parseObject(depth);
    if (c === '[') return parseArray(depth);
    if (c === '"') return parseString();
    if (c === 't') return expectLiteral('true');
    if (c === 'f') return expectLiteral('false');
    if (c === 'n') return expectLiteral('null');
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    return err('意外的字符 "' + c + '"', i);
  }
  function expectLiteral(word) {
    if (text.substr(i, word.length) === word) { i += word.length; return null; }
    return err('意外的字符 "' + text[i] + '"（应为 ' + word + '）');
  }
  function parseString() {
    // fast path: regex anchored at i
    const rest = text.slice(i);
    const m = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(rest);
    if (m) { i += m[0].length; return null; }
    // find failure point: walk char by char
    let j = i + 1;
    while (j < n) {
      const c = text[j];
      if (c === '\\') {
        const nx = text[j + 1];
        if ('"\\/bfnrt'.indexOf(nx) >= 0) { j += 2; continue; }
        if (nx === 'u' && /^[0-9a-fA-F]{4}$/.test(text.substr(j + 2, 4))) { j += 6; continue; }
        return err('非法转义 "\\' + (nx || '') + '"', j);
      }
      if (c === '"') { i = j + 1; return null; }
      if (c < ' ') return err('字符串内出现未转义控制字符', j);
      j++;
    }
    return err('字符串未闭合', j);
  }
  function parseNumber() {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) return err('非法数字', i);
    const after = text[i + m[0].length];
    if (after !== undefined && /[A-Za-z_]/.test(after)) return err('非法数字（尾随字符 "' + after + '"）', i + m[0].length);
    i += m[0].length;
    return null;
  }
  function parseObject(depth) {
    i++; // {
    skipWs();
    if (text[i] === '}') { i++; return null; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') return err('对象键名必须是字符串，发现 "' + (text[i] || '结尾') + '"');
      const e1 = parseString(); if (e1) return e1;
      skipWs();
      if (text[i] !== ':') return err('键名后缺少冒号');
      i++;
      const e2 = parseValue(depth + 1); if (e2) return e2;
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; return null; }
      return err('对象中缺少 "," 或 "}"，发现 "' + (text[i] || '结尾') + '"');
    }
  }
  function parseArray(depth) {
    i++; // [
    skipWs();
    if (text[i] === ']') { i++; return null; }
    for (;;) {
      const e = parseValue(depth + 1); if (e) return e;
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; return null; }
      return err('数组中缺少 "," 或 "]"，发现 "' + (text[i] || '结尾') + '"');
    }
  }
  const topErr = parseValue(0);
  if (topErr) return topErr;
  skipWs();
  if (i < n) return err('顶层值之后存在多余字符 "' + text[i] + '"', i);
  return null;
}

/**
 * Parse with full error reporting.
 * @returns { ok: true, value } | { ok: false, message, line, col, snippet }
 */
function parseWithLocation(text) {
  if (text === null || text === undefined || String(text).trim() === '') {
    return { ok: false, message: '请输入内容', line: 1, col: 1, snippet: '' };
  }
  const raw = String(text);
  const scanErr = findSyntaxError(raw);
  if (scanErr) {
    const loc = offsetToLineCol(raw, scanErr.offset);
    return {
      ok: false,
      message: '第 ' + loc.line + ' 行:' + loc.col + ' 列 解析失败（' + scanErr.expected + '）',
      line: loc.line,
      col: loc.col,
      snippet: contextSnippet(raw, scanErr.offset),
    };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (e) {
    // syntax scan passed but JSON.parse failed (rare, e.g. deep nesting)
    return { ok: false, message: '解析失败：' + e.message, line: 1, col: 1, snippet: '' };
  }
}

/** Recursively sort object keys (arrays keep their order). */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort(function (a, b) {
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const out = {};
    for (let i = 0; i < keys.length; i++) out[keys[i]] = sortKeysDeep(value[keys[i]]);
    return out;
  }
  return value;
}

/** Escape every codepoint > 0x7e as \uXXXX (surrogate pairs kept as two escapes). */
function toAsciiEscaped(str) {
  let out = '';
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 128) out += str.charAt(i);
    else out += '\\u' + ('000' + c.toString(16)).slice(-4);
  }
  return out;
}

/**
 * format(text, indentSize, opts)
 * @param indentSize number of spaces, or a literal string such as '\t'
 * @param opts { sortKeys: boolean, ensureAscii: boolean }
 */
function format(text, indentSize, opts) {
  const r = parseWithLocation(text);
  if (!r.ok) return r;
  const o = opts || {};
  let value = r.value;
  if (o.sortKeys) value = sortKeysDeep(value);
  const pad = typeof indentSize === 'string' && indentSize.length ? indentSize : (typeof indentSize === 'number' ? indentSize : 2);
  let out = JSON.stringify(value, null, pad);
  if (out === undefined) return { ok: false, message: '无法序列化（值可能是 undefined）', line: 1, col: 1, snippet: '' };
  if (o.ensureAscii) out = toAsciiEscaped(out);
  return { ok: true, value: out };
}

function minify(text, opts) {
  const r = parseWithLocation(text);
  if (!r.ok) return r;
  const o = opts || {};
  let value = r.value;
  if (o.sortKeys) value = sortKeysDeep(value);
  let out = JSON.stringify(value);
  if (o.ensureAscii) out = toAsciiEscaped(out);
  return { ok: true, value: out };
}

function previewValue(v) {
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return String(v);
  return '';
}

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'object') return 'object';
  return typeof v;
}

/**
 * Flatten parsed JSON into tree rows for rendering.
 * Each row: { id, pointer, depth, key, type, preview, childCount, expandable, collapsed }
 * Arrays show [i] as key; objects show the key name.
 */
function flatten(value) {
  const rows = [];
  let truncated = false;
  const esc = (k) => String(k).replace(/~/g, '~0').replace(/\//g, '~1');
  function walk(v, pointer, depth, key, collapsedHere) {
    if (rows.length >= MAX_PTR_NODES) { truncated = true; return; }
    const t = typeOf(v);
    const container = t === 'object' || t === 'array';
    let childCount = 0;
    if (t === 'object') childCount = Object.keys(v).length;
    else if (t === 'array') childCount = v.length;
    rows.push({
      id: rows.length,
      pointer: pointer === '' ? '/' : pointer,
      depth,
      key: key === null ? '(root)' : key,
      type: t,
      preview: container ? (t === 'array' ? '[ ' + childCount + ' 项 ]' : '{ ' + childCount + ' 项 }') : previewValue(v),
      childCount,
      expandable: container && childCount > 0,
      collapsed: false,
    });
    if (!container) return;
    const keys = t === 'object' ? Object.keys(v) : v.map((_, idx) => idx);
    for (const k of keys) {
      walk(v[k], pointer + '/' + esc(k), depth + 1, String(k));
      if (truncated) return;
    }
  }
  walk(value, '', 0, null);
  return { rows, truncated, total: rows.length };
}

/**
 * Rows whose ancestors are collapsed are filtered out. `rows` are in pre-order
 * with contiguous subtrees, so a depth stack is enough (no recursion).
 * @param collapsed map-like object: { rowId: true }
 */
function visibleRows(rows, collapsed) {
  const out = [];
  const stack = []; // depths currently hidden by a collapsed ancestor
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    while (stack.length && row.depth <= stack[stack.length - 1]) stack.pop();
    const hidden = stack.length > 0;
    if (!hidden) out.push(row);
    if (!hidden && collapsed && collapsed[row.id] && row.expandable) stack.push(row.depth);
  }
  return out;
}

/** Default collapse state: every container deeper than `depth` starts folded.
 *  depth < 0 means "expand everything". */
function collapseByDepth(rows, depth) {
  const map = {};
  if (!(depth >= 0)) return map;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.expandable && row.depth >= depth) map[row.id] = true;
  }
  return map;
}

module.exports = {
  parseWithLocation,
  format,
  minify,
  flatten,
  visibleRows,
  collapseByDepth,
  sortKeysDeep,
  toAsciiEscaped,
  offsetToLineCol,
  contextSnippet,
  MAX_PTR_NODES,
};
