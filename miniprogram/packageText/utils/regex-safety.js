'use strict';
/**
 * packageText/utils/regex-safety.js
 *
 * Regex execution wrapper that never freezes the UI.
 *
 * JavaScript has no way to interrupt a running RegExp.exec, so protection is
 * layered from cheapest to most expensive:
 *   1. Static shape analysis (a small recursive-descent parser over the
 *      pattern source) detects the catastrophic families *before* anything is
 *      executed: an unbounded quantifier over a variable-length body
 *      ((a+)+, (\d{1,3})+), an unbounded quantifier over an alternation whose
 *      branches can start with the same character ((a|aa)+, (\w|\d)+), and
 *      adjacent overlapping unbounded atoms (.*.*, \d+\d+x).
 *   2. Escalating prefix probe on the real input (8/16/24/32 chars) - catches
 *      super-linear behaviour the static layer classified as safe.
 *   3. The main pass runs over the whole text with a wall-clock deadline and a
 *      match cap checked after every match; hitting either reports
 *      "interrupted" plus whatever was already collected.
 *
 * Matches are NOT produced chunk-by-chunk: splitting the input would silently
 * break anchors (^/$), \b and matches spanning a boundary, so correctness wins
 * over slicing here. Layer 1+2 are what keep a single exec bounded.
 */

const DEFAULT_TIMEOUT_MS = 1000;
const MAX_MATCHES = 5000;
const PROBE_LENGTHS = [8, 16, 24, 32];
const MAX_CODEPOINT = 0x10ffff;

/* ------------------------------------------------------------------ */
/* pattern parser                                                      */
/* ------------------------------------------------------------------ */

function Parser(src) {
  this.src = src;
  this.i = 0;
}

Parser.prototype.err = function (msg) {
  const e = new Error(msg);
  e.parseError = true;
  return e;
};

Parser.prototype.parse = function () {
  const alt = this.parseAlternation();
  if (this.i < this.src.length) throw this.err('未闭合的分组');
  return alt;
};

// alternation := concat ('|' concat)*
Parser.prototype.parseAlternation = function () {
  const options = [this.parseConcat()];
  while (this.i < this.src.length && this.peek() === '|') {
    this.i++;
    options.push(this.parseConcat());
  }
  return options.length === 1 ? options[0] : { t: 'alt', options: options };
};

// concat := quantified*
Parser.prototype.parseConcat = function () {
  const items = [];
  while (this.i < this.src.length) {
    const c = this.peek();
    if (c === '|' || c === ')') break;
    items.push(this.parseQuantified());
  }
  return items.length === 1 ? items[0] : { t: 'cat', items: items };
};

Parser.prototype.parseQuantified = function () {
  let atom = this.parseAtom();
  while (this.i < this.src.length) {
    const c = this.peek();
    let min;
    let max;
    if (c === '*') { min = 0; max = Infinity; this.i++; }
    else if (c === '+') { min = 1; max = Infinity; this.i++; }
    else if (c === '?') { min = 0; max = 1; this.i++; }
    else if (c === '{') {
      const m = /^\{(\d+)(?:,(\d*))?\}/.exec(this.src.slice(this.i));
      if (!m) break; // literal brace
      min = parseInt(m[1], 10);
      max = m[2] === undefined ? min : (m[2] === '' ? Infinity : parseInt(m[2], 10));
      if (max < min) throw this.err('量词范围不合法');
      this.i += m[0].length;
    } else break;
    if (this.peek() === '?') this.i++; // lazy marker: same shape risk
    atom = { t: 'repeat', min: min, max: max, body: atom };
  }
  return atom;
};

Parser.prototype.peek = function () {
  return this.src[this.i];
};

Parser.prototype.parseAtom = function () {
  const c = this.src[this.i];
  if (c === undefined) throw this.err('表达式意外结束');
  if (c === '(') return this.parseGroup();
  if (c === '[') return this.parseClass();
  if (c === '^') { this.i++; return { t: 'anchor', kind: 'start' }; }
  if (c === '$') { this.i++; return { t: 'anchor', kind: 'end' }; }
  if (c === '.') { this.i++; return { t: 'any' }; }
  if (c === '\\') return this.parseEscape();
  if (c === '*' || c === '+' || c === '?') throw this.err('量词前缺少可重复元素');
  if (c === '{') {
    // bare brace not followed by a valid quantifier = literal
    this.i++;
    return { t: 'literal', code: c.charCodeAt(0) };
  }
  this.i++;
  if (c === '\ud840' || (c.charCodeAt(0) >= 0xd800 && c.charCodeAt(0) <= 0xdbff)) {
    const next = this.src[this.i];
    if (next && next.charCodeAt(0) >= 0xdc00 && next.charCodeAt(0) <= 0xdfff) {
      this.i++;
      return { t: 'literal', code: (c.charCodeAt(0) - 0xd800) * 0x400 + next.charCodeAt(0) - 0xdc00 + 0x10000 };
    }
  }
  return { t: 'literal', code: c.charCodeAt(0) };
};

Parser.prototype.parseGroup = function () {
  this.i++; // consume '('
  let kind = 'capture';
  let name = '';
  if (this.peek() === '?') {
    const c2 = this.src[this.i + 1];
    if (c2 === ':') { kind = 'noncapture'; this.i += 2; }
    else if (c2 === '=' ) { kind = 'lookahead'; this.i += 2; }
    else if (c2 === '!') { kind = 'lookahead'; this.i += 2; }
    else if (c2 === '<') {
      const c3 = this.src[this.i + 2];
      if (c3 === '=') { kind = 'lookbehind'; this.i += 3; }
      else if (c3 === '!') { kind = 'lookbehind'; this.i += 3; }
      else {
        const m = /^\?<([A-Za-z_$][\w]*)>/.exec(this.src.slice(this.i));
        if (!m) throw this.err('命名分组名称不合法');
        kind = 'named';
        name = m[1];
        this.i += m[0].length;
      }
    } else throw this.err('不支持的分组语法');
  }
  const body = this.parseAlternation();
  if (this.peek() !== ')') throw this.err('未闭合的分组');
  this.i++;
  return { t: 'group', kind: kind, name: name, body: body };
};

Parser.prototype.parseEscape = function () {
  this.i++; // backslash
  const c = this.src[this.i];
  if (c === undefined) throw this.err('反斜杠后缺少字符');
  this.i++;
  if ('dDwWsS'.indexOf(c) >= 0) return { t: 'escape', kind: c.toLowerCase(), negate: c !== c.toLowerCase() };
  if (c === 'b' || c === 'B') return { t: 'anchor', kind: c === 'b' ? 'bound' : 'nbound' };
  if (c === 'n') return { t: 'literal', code: 10 };
  if (c === 'r') return { t: 'literal', code: 13 };
  if (c === 't') return { t: 'literal', code: 9 };
  if (c === 'f') return { t: 'literal', code: 12 };
  if (c === 'v') return { t: 'literal', code: 11 };
  if (c === '0') return { t: 'literal', code: 0 };
  if (c === 'u') {
    const rest = this.src.slice(this.i - 1);
    const m = /^u\{([0-9a-fA-F]{1,6})\}|^u([0-9a-fA-F]{4})/.exec(rest);
    if (!m) throw this.err('\\u 转义不合法');
    this.i += m[0].length - 1;
    return { t: 'literal', code: parseInt(m[1] || m[2], 16) };
  }
  if (c === 'x') {
    const m = /^x([0-9a-fA-F]{2})/.exec(this.src.slice(this.i));
    if (!m) throw this.err('\\x 转义不合法');
    this.i += m[0].length;
    return { t: 'literal', code: parseInt(m[1], 16) };
  }
  if (c === 'c') { this.i++; return { t: 'any' }; }
  if (c === 'p' || c === 'P') {
    const m = /^\{([A-Za-z_]+)\}/.exec(this.src.slice(this.i));
    if (!m) throw this.err('\\p 属性不合法');
    this.i += m[0].length;
    // Unicode property sets are not enumerated here: treated as unknown range.
    return { t: 'escape', kind: 'p', negate: c === 'P' };
  }
  if (c >= '1' && c <= '9') {
    let ref = c;
    while (/[0-9]/.test(this.peek() || '')) { ref += this.peek(); this.i++; if (ref.length > 2) break; }
    return { t: 'backref', ref: parseInt(ref, 10) };
  }
  return { t: 'literal', code: c.charCodeAt(0) }; // punctuation escape
};

Parser.prototype.parseClass = function () {
  this.i++; // '['
  let negate = false;
  if (this.peek() === '^') { negate = true; this.i++; }
  const ranges = [];
  let unknown = false; // set when a class member cannot be enumerated (\p{…})
  while (this.i < this.src.length && this.peek() !== ']') {
    let lo = null;
    let hi = null;
    if (this.peek() === '\\') {
      const esc = this.parseEscape();
      if (esc.t === 'literal') lo = esc.code;
      else if (esc.t === 'escape' && 'dws'.indexOf(esc.kind) >= 0) {
        const rs = escapeRanges(esc.kind, esc.negate);
        for (let k = 0; k < rs.length; k++) ranges.push(rs[k]);
        lo = null;
      } else unknown = true;
    } else {
      lo = this.src.charCodeAt(this.i);
      this.i++;
      if (lo >= 0xd800 && lo <= 0xdbff && this.peek() && this.peek().charCodeAt(0) >= 0xdc00 && this.peek().charCodeAt(0) <= 0xdfff) {
        const pair = this.src.charCodeAt(this.i);
        this.i++;
        lo = (lo - 0xd800) * 0x400 + pair - 0xdc00 + 0x10000;
      }
    }
    hi = lo;
    if (lo !== null && this.peek() === '-' && this.src[this.i + 1] !== undefined && this.src[this.i + 1] !== ']') {
      this.i++;
      if (this.peek() === '\\') {
        const esc2 = this.parseEscape();
        if (esc2.t === 'literal') hi = esc2.code;
        else { unknown = true; hi = MAX_CODEPOINT; }
      } else {
        hi = this.src.charCodeAt(this.i);
        this.i++;
      }
      if (hi < lo) throw this.err('字符类范围倒置');
      ranges.push([lo, hi]);
    } else if (lo !== null) {
      ranges.push([lo, hi]);
    }
  }
  if (this.peek() !== ']') throw this.err('未闭合的字符类');
  this.i++;
  if (unknown && !negate) return { t: 'any' };
  return { t: 'class', ranges: unknown ? [[0, MAX_CODEPOINT]] : ranges, negate: negate };
};

/* ------------------------------------------------------------------ */
/* character-set algebra (interval lists)                              */
/* ------------------------------------------------------------------ */

function escapeRanges(kind, negate) {
  let base;
  if (kind === 'd') base = [[48, 57]];
  else if (kind === 'w') base = [[48, 57], [65, 90], [95, 95], [97, 122]];
  else if (kind === 's') base = [[9, 13], [32, 32], [160, 160], [5760, 5760], [8192, 8202], [8232, 8233], [8239, 8239], [8287, 8287], [12288, 12288]];
  else base = [[0, MAX_CODEPOINT]];
  if (!negate) return base;
  return complement(base);
}

function normalize(list) {
  if (!list.length) return [];
  const sorted = list.slice().sort(function (a, b) { return a[0] - b[0]; });
  const out = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = out[out.length - 1];
    if (sorted[i][0] <= last[1] + 1) last[1] = Math.max(last[1], sorted[i][1]);
    else out.push([sorted[i][0], sorted[i][1]]);
  }
  return out;
}

function complement(list) {
  const n = normalize(list);
  const out = [];
  let cur = 0;
  for (let i = 0; i < n.length; i++) {
    if (n[i][0] > cur) out.push([cur, n[i][0] - 1]);
    cur = Math.max(cur, n[i][1] + 1);
  }
  if (cur <= MAX_CODEPOINT) out.push([cur, MAX_CODEPOINT]);
  return out;
}

function union(a, b) {
  return normalize(a.concat(b));
}

function overlaps(a, b) {
  const na = normalize(a);
  const nb = normalize(b);
  for (let i = 0; i < na.length; i++) {
    for (let j = 0; j < nb.length; j++) {
      if (na[i][0] <= nb[j][1] && nb[j][0] <= na[i][1]) return true;
    }
  }
  return false;
}

function setOf(node) {
  switch (node.t) {
    case 'literal': return [[node.code, node.code]];
    case 'class': return node.negate ? complement(node.ranges) : normalize(node.ranges);
    case 'escape': return escapeRanges(node.kind, node.negate);
    case 'any': return [[0, MAX_CODEPOINT]];
    case 'anchor':
    case 'backref':
    case 'empty': return [];
    case 'group':
    case 'lookaround': return node.kind === 'capture' || node.kind === 'named' || node.kind === 'noncapture' ? firstOf(node.body) : [];
    case 'repeat': return firstOf(node.body);
    case 'cat': return firstOf(node);
    case 'alt': return firstOf(node);
    default: return [];
  }
}

/** Characters that a match of `node` can start with. */
function firstOf(node) {
  if (!node) return [];
  switch (node.t) {
    case 'cat': {
      let acc = [];
      for (let i = 0; i < node.items.length; i++) {
        acc = union(acc, setOf(node.items[i]));
        if (!canMatchEmpty(node.items[i])) break;
      }
      return acc;
    }
    case 'alt': {
      let acc = [];
      for (let i = 0; i < node.options.length; i++) acc = union(acc, setOf(node.options[i]));
      return acc;
    }
    case 'group': return node.kind === 'lookahead' || node.kind === 'lookbehind' ? [] : firstOf(node.body);
    case 'repeat': return firstOf(node.body);
    default: return setOf(node);
  }
}

function canMatchEmpty(node) {
  if (!node) return true;
  switch (node.t) {
    case 'anchor':
    case 'backref':
    case 'empty': return true;
    case 'literal':
    case 'class':
    case 'escape':
    case 'any': return false;
    case 'repeat': return node.min === 0 || canMatchEmpty(node.body);
    case 'group': return node.kind === 'lookahead' || node.kind === 'lookbehind' ? true : canMatchEmpty(node.body);
    case 'cat': {
      for (let i = 0; i < node.items.length; i++) if (!canMatchEmpty(node.items[i])) return false;
      return true;
    }
    case 'alt': {
      for (let i = 0; i < node.options.length; i++) if (canMatchEmpty(node.options[i])) return true;
      return false;
    }
    default: return true;
  }
}

/* ------------------------------------------------------------------ */
/* risk analysis                                                       */
/* ------------------------------------------------------------------ */

/** A body is "flexible" when one of its repetitions can consume a variable
 *  number of characters, which is what makes an enclosing unbounded quantifier
 *  exponential. */
function hasFlexibleRepeat(node) {
  if (!node) return false;
  switch (node.t) {
    case 'repeat':
      if (node.max === Infinity || node.max >= 2) {
        if (node.min !== node.max || node.max === Infinity) return true;
      }
      return hasFlexibleRepeat(node.body);
    case 'group': return hasFlexibleRepeat(node.body);
    case 'cat': return node.items.some(hasFlexibleRepeat);
    case 'alt': return node.options.some(hasFlexibleRepeat);
    default: return false;
  }
}

/** Two alternatives of some alternation can start with the same character. */
function hasOverlappingAlternation(node) {
  if (!node) return false;
  if (node.t === 'alt') {
    const starts = node.options.map(firstOf);
    for (let i = 0; i < starts.length; i++) {
      for (let j = i + 1; j < starts.length; j++) {
        if (starts[i].length && starts[j].length && overlaps(starts[i], starts[j])) return true;
      }
    }
  }
  if (node.t === 'cat') return node.items.some(hasOverlappingAlternation);
  if (node.t === 'alt') return node.options.some(hasOverlappingAlternation);
  if (node.t === 'group' || node.t === 'repeat') return hasOverlappingAlternation(node.body);
  return false;
}

function quantifierIsOpen(node) {
  return node.max === Infinity || node.max >= 2;
}

/** Adjacent atoms that both repeat and can match the same character. */
function hasAdjacentOverlap(items) {
  for (let i = 0; i + 1 < items.length; i++) {
    const a = items[i];
    const b = items[i + 1];
    const ra = a.t === 'repeat' ? a : null;
    const rb = b.t === 'repeat' ? b : null;
    if (!ra || !rb) continue;
    if (!quantifierIsOpen(ra) || !quantifierIsOpen(rb)) continue;
    if (overlaps(firstOf(ra.body), firstOf(rb.body))) return true;
  }
  return false;
}

/**
 * detectUnsafePattern(pattern) -> {unsafe:boolean, reason:string}
 * Conservative: only the known exponential families are reported.
 */
function detectUnsafePattern(pattern) {
  let ast;
  try {
    ast = new Parser(pattern).parse();
  } catch (e) {
    return { unsafe: false, reason: '', parseFailed: true };
  }
  const found = walkRisk(ast);
  return found;
}

function walkRisk(node) {
  if (!node) return { unsafe: false, reason: '' };
  if (node.t === 'repeat') {
    if (quantifierIsOpen(node) && node.max === Infinity) {
      if (hasFlexibleRepeat(node.body)) {
        return { unsafe: true, reason: '量词嵌套（如 (a+)+ / (\\d{1,3})+）' };
      }
      if (hasOverlappingAlternation(node.body)) {
        return { unsafe: true, reason: '重复分组内的分支可匹配相同起始字符（如 (a|aa)+）' };
      }
    }
    const inner = walkRisk(node.body);
    if (inner.unsafe) return inner;
    return { unsafe: false, reason: '' };
  }
  if (node.t === 'cat') {
    if (hasAdjacentOverlap(node.items)) {
      return { unsafe: true, reason: '相邻且可重叠的量词（如 .*.* / \\d+\\d+）' };
    }
    for (let i = 0; i < node.items.length; i++) {
      const r = walkRisk(node.items[i]);
      if (r.unsafe) return r;
    }
    return { unsafe: false, reason: '' };
  }
  if (node.t === 'alt') {
    for (let i = 0; i < node.options.length; i++) {
      const r = walkRisk(node.options[i]);
      if (r.unsafe) return r;
    }
    return { unsafe: false, reason: '' };
  }
  if (node.t === 'group') return walkRisk(node.body);
  return { unsafe: false, reason: '' };
}

/* ------------------------------------------------------------------ */
/* capture group labels                                                */
/* ------------------------------------------------------------------ */

/** Human labels for capture groups, in order: name when the group is named. */
function groupLabels(pattern) {
  const labels = [];
  const src = String(pattern || '');
  let inClass = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (inClass) { if (c === ']') inClass = false; continue; }
    if (c === '[') { inClass = true; continue; }
    if (c !== '(') continue;
    const rest = src.slice(i + 1);
    const named = /^\?<([A-Za-z_$][\w]*)>/.exec(rest);
    if (named) { labels.push(named[1]); i += named[0].length - 1; continue; }
    const open = /^\?(?:<=|<!|[:=!])/.exec(rest);
    if (open) { i += open[0].length; continue; } // non-capturing / lookaround
    labels.push('');
  }
  return labels;
}

/* ------------------------------------------------------------------ */
/* main API                                                            */
/* ------------------------------------------------------------------ */

/**
 * safeMatchAll(pattern, flags, text, opts)
 * @returns {
 *   ok:true, matches:[{index,text,groups:[{index,value,name}],named:{}}],
 *   interrupted:false, elapsedMs, truncated
 * } | {
 *   ok:false, interrupted:true, reason:'timeout'|'catastrophic-detected'|'too-many',
 *   detail, partial:[...], elapsedMs
 * } | { ok:false, syntaxError:'message' }
 */
function safeMatchAll(pattern, flags, text, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  flags = flags || '';
  const hasGlobal = flags.indexOf('g') >= 0;
  text = text == null ? '' : String(text);

  let re;
  try {
    re = new RegExp(pattern, hasGlobal ? flags : flags.replace(/g/g, ''));
  } catch (e) {
    return syntaxFail(e);
  }

  // Layer 1 - static shape analysis (only for repeated search / replace mode,
  // where a runaway scan is the failure mode).
  const risk = detectUnsafePattern(pattern);
  if (risk.unsafe) {
    return {
      ok: false,
      interrupted: true,
      reason: 'catastrophic-detected',
      detail: '存在灾难性回溯风险：' + risk.reason,
      partial: [],
      elapsedMs: Date.now() - started,
    };
  }

  // Layer 2 - prefix probe on the real input, aborting on super-linear growth.
  const probe = probeRun(pattern, flags, text, timeoutMs, started);
  if (probe) return probe;

  // Layer 3 - the real pass with a wall-clock deadline and a match cap.
  const labels = groupLabels(pattern);
  const matches = [];
  let interrupted = false;
  let reason = '';
  let detail = '';
  let iterations = 0;

  try {
    if (hasGlobal) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        iterations++;
        const named = {};
        if (m.groups) {
          for (const k in m.groups) {
            if (Object.prototype.hasOwnProperty.call(m.groups, k)) named[k] = m.groups[k];
          }
        }
        matches.push({ index: m.index, text: m[0], groups: collectGroups(m, labels), named: named });
        if (m[0] === '') re.lastIndex++;
        if (matches.length >= MAX_MATCHES) { interrupted = true; reason = 'too-many'; detail = '匹配数量超过 ' + MAX_MATCHES + ' 条上限'; break; }
        if (iterations % 32 === 0 && Date.now() - started > timeoutMs) {
          interrupted = true; reason = 'timeout';
          detail = '执行超过 ' + timeoutMs + ' ms 已中断，仅保留前 ' + matches.length + ' 条结果';
          break;
        }
      }
    } else {
      const m = re.exec(text);
      if (m !== null) {
        const named = {};
        if (m.groups) {
          for (const k in m.groups) {
            if (Object.prototype.hasOwnProperty.call(m.groups, k)) named[k] = m.groups[k];
          }
        }
        matches.push({ index: m.index, text: m[0], groups: collectGroups(m, labels), named: named });
      }
    }
  } catch (e) {
    return syntaxFail(e);
  }

  const elapsedMs = Date.now() - started;
  if (interrupted) {
    return { ok: false, interrupted: true, reason: reason, detail: detail, partial: matches, elapsedMs: elapsedMs };
  }
  return { ok: true, matches: matches, interrupted: false, elapsedMs: elapsedMs, truncated: false };
}

function syntaxFail(e) {
  return {
    ok: false,
    syntaxError: '正则表达式语法不合法：' + (e && e.message ? e.message : '无法编译'),
    elapsedMs: 0,
  };
}

function collectGroups(m, labels) {
  const groups = [];
  for (let gi = 1; gi < m.length; gi++) {
    groups.push({
      index: gi,
      value: m[gi] === undefined ? null : m[gi],
      name: labels[gi - 1] || '',
    });
  }
  return groups;
}

function probeRun(pattern, flags, text, timeoutMs, started) {
  if (text.length < PROBE_LENGTHS[0]) return null;
  const probeFlags = String(flags || '').replace(/g/g, '');
  let prevMs = 0;
  for (let i = 0; i < PROBE_LENGTHS.length; i++) {
    const len = PROBE_LENGTHS[i];
    if (len > text.length) break;
    let t0 = Date.now();
    try {
      const pre = new RegExp(pattern, probeFlags);
      pre.test(text.slice(0, len));
    } catch (e) {
      return null; // syntax already reported by the main pass
    }
    const ms = Date.now() - t0;
    if (Date.now() - started > timeoutMs || ms > 250) {
      return {
        ok: false, interrupted: true, reason: 'timeout',
        detail: '执行超过 ' + timeoutMs + ' ms 已中断，请缩短输入或收紧表达式',
        partial: [], elapsedMs: Date.now() - started,
      };
    }
    if (prevMs > 0 && len !== PROBE_LENGTHS[0] && ms > prevMs * 6 && ms > 30) {
      return {
        ok: false, interrupted: true, reason: 'catastrophic-detected',
        detail: '检测到超线性耗时增长，已中断以避免卡死',
        partial: [], elapsedMs: Date.now() - started,
      };
    }
    prevMs = Math.max(prevMs, ms);
  }
  return null;
}

/**
 * buildReplacement(text, matches, template)
 * $& whole match, $1..$99 positional, $<name> named. Gaps preserved.
 */
function buildReplacement(text, matches, template) {
  let out = '';
  let last = 0;
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    if (m.index > last) out += String(text).slice(last, m.index);
    out += renderTemplate(m, template);
    last = m.index + m.text.length;
  }
  out += String(text).slice(last);
  return out;
}

function renderTemplate(m, template) {
  return String(template).replace(/\$(\$|&|<[^>]*>|\d{1,2})/g, function (_, tok) {
    if (tok === '$') return '$';
    if (tok === '&') return m.text;
    if (tok.charAt(0) === '<') {
      const key = tok.slice(1, -1);
      return m.named && m.named[key] !== undefined && m.named[key] !== null ? m.named[key] : '';
    }
    const gi = parseInt(tok, 10);
    const g = m.groups[gi - 1];
    return g && g.value !== null && g.value !== undefined ? g.value : '';
  });
}

/** Validate only the syntax (used by the page for live feedback). */
function validatePattern(pattern, flags) {
  try {
    new RegExp(pattern, String(flags || '').replace(/g/g, '') + 'g');
    return { ok: true };
  } catch (e) {
    return { ok: false, message: '正则表达式语法不合法：' + (e && e.message ? e.message : '无法编译') };
  }
}

module.exports = {
  safeMatchAll,
  buildReplacement,
  detectUnsafePattern,
  groupLabels,
  validatePattern,
  DEFAULT_TIMEOUT_MS,
  MAX_MATCHES,
};
