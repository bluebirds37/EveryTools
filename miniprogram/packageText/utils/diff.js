'use strict';
/**
 * packageText/utils/diff.js
 * Line-level Myers O(ND) diff (greedy forward-path with per-d trace snapshots
 * + backtrack reconstruction — the base algorithm of Myers 1986).
 * Produces ops {type:'eq'|'del'|'ins'}, pairs adjacent del/ins blocks into
 * 'mod' rows, computes similarity, renders unified diff.
 * Guards: total lines <= 6000, edit script D <= 600 (beyond that inputs are
 * essentially unrelated: fall back to delete-all + insert-all, still a valid
 * script, documented in the page hint).
 */

const D_CAP = 600;
const TOTAL_CAP = 6000;

/** @returns ops list [{type,text}] — shortest edit script for a vs b */
function myersOps(a, b) {
  const n = a.length, m = b.length;
  const maxD = Math.min(n + m, D_CAP);
  if (n + m > TOTAL_CAP) {
    const ops = [];
    for (let i = 0; i < n; i++) ops.push({ type: 'del', text: a[i] });
    for (let j = 0; j < m; j++) ops.push({ type: 'ins', text: b[j] });
    return ops;
  }
  const off = maxD + 2;
  const vSize = 2 * off + 1;
  const V = new Int32Array(vSize);
  const trace = [];
  V[off + 1] = 0;
  let foundD = -1;
  outer:
  for (let d = 0; d <= maxD; d++) {
    for (let k = -d; k <= d; k += 2) {
      let x;
      if (k === -d || (k !== d && V[off + k - 1] < V[off + k + 1])) x = V[off + k + 1];
      else x = V[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      V[off + k] = x;
      if (x >= n && y >= m) { foundD = d; break outer; }
    }
    trace.push(V.slice());
  }
  if (foundD < 0) {
    // edit distance beyond D_CAP: valid non-minimal fallback
    const ops = [];
    for (let i = 0; i < n; i++) ops.push({ type: 'del', text: a[i] });
    for (let j = 0; j < m; j++) ops.push({ type: 'ins', text: b[j] });
    return ops;
  }
  // backtrack to build the edit script
  const rev = [];
  let x = n, y = m;
  for (let d = foundD; d > 0; d--) {
    const Vd = trace[d - 1];
    const k = x - y;
    let prevK;
    if (k === -d || (k !== d && Vd[off + k - 1] < Vd[off + k + 1])) prevK = k + 1;
    else prevK = k - 1;
    const prevX = Vd[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      rev.push({ type: 'eq', text: a[x - 1], idxA: x - 1, idxB: y - 1 });
      x--; y--;
    }
    if (d === foundD || true) {
      if (x === prevX) rev.push({ type: 'ins', text: b[prevY], idxA: null, idxB: prevY });
      else rev.push({ type: 'del', text: a[prevX], idxA: prevX, idxB: null });
    }
    x = prevX; y = prevY;
  }
  while (x > 0 && y > 0) {
    rev.push({ type: 'eq', text: a[x - 1], idxA: x - 1, idxB: y - 1 });
    x--; y--;
  }
  return rev.reverse();
}

/** Diff two arrays of lines with common prefix/suffix trimming. */
function diffArrays(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'eq', text: a[i], idxA: i, idxB: i });
  const midOps = myersOps(midA, midB);
  for (const o of midOps) {
    ops.push({
      type: o.type,
      text: o.text,
      idxA: o.idxA === null || o.idxA === undefined ? null : o.idxA + start,
      idxB: o.idxB === null || o.idxB === undefined ? null : o.idxB + start,
    });
  }
  for (let k = 0; k < a.length - endA; k++) ops.push({ type: 'eq', text: a[endA + k], idxA: endA + k, idxB: endB + k });
  // attach 1-based line numbers
  for (const o of ops) {
    o.lineA = o.idxA === null ? null : o.idxA + 1;
    o.lineB = o.idxB === null ? null : o.idxB + 1;
  }
  return ops;
}

/** Group ops into display rows (mod-pairing of adjacent del/ins blocks). */
function toDisplayRows(ops) {
  const rows = [];
  let i = 0;
  while (i < ops.length) {
    const op = ops[i];
    if (op.type === 'eq') {
      rows.push({ type: 'eq', text: op.text, lineA: op.lineA, lineB: op.lineB, mark: '  ' });
      i++;
      continue;
    }
    const dels = [];
    const ins = [];
    let j = i;
    while (j < ops.length && ops[j].type === 'del') { dels.push(ops[j]); j++; }
    while (j < ops.length && ops[j].type === 'ins') { ins.push(ops[j]); j++; }
    if (dels.length && ins.length) {
      const pair = Math.min(dels.length, ins.length);
      for (let k = 0; k < pair; k++) {
        rows.push({ type: 'mod', textA: dels[k].text, textB: ins[k].text, lineA: dels[k].lineA, lineB: ins[k].lineB });
      }
      for (let k = pair; k < dels.length; k++) rows.push({ type: 'del', text: dels[k].text, lineA: dels[k].lineA, lineB: null, mark: '- ' });
      for (let k = pair; k < ins.length; k++) rows.push({ type: 'add', text: ins[k].text, lineA: null, lineB: ins[k].lineB, mark: '+ ' });
    } else {
      for (const d of dels) rows.push({ type: 'del', text: d.text, lineA: d.lineA, lineB: null, mark: '- ' });
      for (const s of ins) rows.push({ type: 'add', text: s.text, lineA: null, lineB: s.lineB, mark: '+ ' });
    }
    i = j;
  }
  return rows;
}

function similarity(ops) {
  let eq = 0, dels = 0, ins = 0;
  for (const op of ops) {
    if (op.type === 'eq') eq++;
    else if (op.type === 'del') dels++;
    else ins++;
  }
  const la = eq + dels, lb = eq + ins;
  if (la === 0 && lb === 0) return 1;
  return (2 * eq) / (la + lb);
}

/** Unified diff rendering with `context` unchanged lines around each hunk. */
function toUnified(ops, context) {
  const ctx = context === undefined ? 3 : context;
  const changes = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].type !== 'eq') changes.push(i);
  if (!changes.length) return '';
  const hunks = [];
  let cur = null;
  let last = -Infinity;
  for (const idx of changes) {
    if (cur && idx - last <= ctx * 2 + 1) cur.push(idx);
    else {
      if (cur) hunks.push(cur);
      cur = [idx];
    }
    last = idx;
  }
  if (cur) hunks.push(cur);
  const out = [];
  for (const hunk of hunks) {
    const s = Math.max(0, hunk[0] - ctx);
    const e = Math.min(ops.length - 1, hunk[hunk.length - 1] + ctx);
    let aCount = 0, bCount = 0;
    const body = [];
    for (let i = s; i <= e; i++) {
      const op = ops[i];
      if (op.type === 'eq') { body.push(' ' + op.text); aCount++; bCount++; }
      else if (op.type === 'mod') { body.push('-' + op.textA); body.push('+' + op.textB); aCount++; bCount++; }
      else if (op.type === 'del') { body.push('-' + op.text); aCount++; }
      else { body.push('+' + op.text); bCount++; }
    }
    const aStart = s < ops.length ? (ops[s].lineA || ops[s].lineB || 1) : 1;
    const bStart = s < ops.length ? (ops[s].lineB || ops[s].lineA || 1) : 1;
    out.push('@@ -' + aStart + ',' + aCount + ' +' + bStart + ',' + bCount + ' @@');
    out.push.apply(out, body);
  }
  return out.join('\n');
}

/**
 * Top-level entry for the diff page.
 * @returns { rows, stats:{add,del,mod,eq,similarity}, unified, linesA, linesB, capped }
 */
function diffLines(aText, bText) {
  const a = String(aText).replace(/\r\n?/g, '\n').split('\n');
  const b = String(bText).replace(/\r\n?/g, '\n').split('\n');
  const ops = diffArrays(a, b);
  const rows = toDisplayRows(ops);
  const sim = similarity(ops);
  let add = 0, del = 0, mod = 0, eq = 0;
  for (const r of rows) {
    if (r.type === 'add') add++;
    else if (r.type === 'del') del++;
    else if (r.type === 'mod') mod++;
    else eq++;
  }
  return {
    rows,
    stats: { add, del, mod, eq, similarity: Math.round(sim * 1000) / 10 },
    unified: toUnified(ops, 3),
    linesA: a.length,
    linesB: b.length,
    capped: a.length + b.length > TOTAL_CAP,
  };
}

module.exports = { diffLines, diffArrays, toDisplayRows, similarity, toUnified, D_CAP, TOTAL_CAP };
