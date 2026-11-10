'use strict';
/* packageText/utils 已知向量自检：node scripts/selftest-text.js（无头运行，不依赖小程序环境） */
const assert = require('assert');
const path = require('path')
const U = path.join(__dirname, '..', 'miniprogram', 'packageText', 'utils', '')
require('./mock-wx') // 算法模块会碰 wx（随机数/存储），先装 mock 运行时
const codec = require(U + 'codec');
const json = require(U + 'json');
const diff = require(U + 'diff');
const textops = require(U + 'textops');
const numsys = require(U + 'numsys');
const rs = require(U + 'regex-safety');
const rnd = require(U + 'random');
const hash = require(U + 'hash');

// ---------- codec ----------
assert.strictEqual(codec.encodeBase64('hello world', 'std'), 'aGVsbG8gd29ybGQ=');
assert.strictEqual(codec.decodeBase64ToStr('aGVsbG8gd29ybGQ=', 'std'), 'hello world');
assert.strictEqual(codec.encodeBase64('中文测试🚀', 'std'), Buffer.from('中文测试🚀', 'utf8').toString('base64'));
assert.strictEqual(codec.decodeBase64ToStr(Buffer.from('中文测试🚀', 'utf8').toString('base64'), 'std'), '中文测试🚀');
const urlVar = codec.encodeBase64('subjects?_d?=', 'url');
assert.strictEqual(urlVar, Buffer.from('subjects?_d?=', 'utf8').toString('base64url'));
assert.strictEqual(codec.decodeBase64ToStr(urlVar, 'url'), 'subjects?_d?=');
assert.throws(() => codec.decodeBase64ToStr('a!b', 'std'), /第 2 个字符/);
assert.strictEqual(codec.bytesToHex(codec.utf8ToBytes('ABC')), '414243');
assert.strictEqual(codec.unicodeEscape('中a'), '\\u4e2d' + 'a');
assert.strictEqual(codec.unicodeUnescape(codec.unicodeEscape('中🚀abc')), '中🚀abc');
assert.strictEqual(codec.htmlEscape(`<a href="x">&'`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
assert.strictEqual(codec.htmlUnescape('&lt;&amp;&gt;&quot;&#39;&nbsp;&#65;'), `<&>"'\u00A0A`);
assert.strictEqual(codec.urlEncodeComponent('中文 a&b'), '%E4%B8%AD%E6%96%87%20a%26b');
assert.strictEqual(codec.urlDecode('%E4%B8%AD%E6%96%87%20a%26b', false), '中文 a&b');
assert.strictEqual(codec.urlDecode('a+b', true), 'a b');

// ---------- json ----------
assert.ok(json.format('{"a":1,"b":[1,2]}', 2).value.includes('\n  "a": 1'));
assert.strictEqual(json.minify('{ "a" : 1 }').value, '{"a":1}');
const bad = json.parseWithLocation('{"a": 1,, "b": 2}');
assert.ok(!bad.ok && bad.line === 1 && bad.col > 0, JSON.stringify(bad));
const bad2 = json.parseWithLocation('{\n  "a": 1,\n  "b": tru\n}');
assert.ok(!bad2.ok && bad2.line === 3, JSON.stringify(bad2));
assert.ok(bad2.snippet.includes('tru'), 'snippet has context');
const tree = json.flatten(JSON.parse('{"a":{"b":[1,2]},"c/d":null}'));
assert.ok(tree.rows.some((r) => r.pointer === '/a/b/0'));
assert.ok(tree.rows.some((r) => r.pointer === '/c~1d'));
const badNum = json.parseWithLocation('[1, 01]');
assert.ok(!badNum.ok, 'leading zero rejected: ' + badNum.message);

// ---------- diff vs LCS-DP reference ----------
function lcsOps(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = []; let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push(['eq', a[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(['del', a[i]]); i++; }
    else { ops.push(['ins', b[j]]); j++; }
  }
  while (i < n) { ops.push(['del', a[i]]); i++; }
  while (j < m) { ops.push(['ins', b[j]]); j++; }
  return ops;
}
function cost(ops) { let d = 0; for (const o of ops) { const t = Array.isArray(o) ? o[0] : o.type; if (t !== 'eq') d++; } return d; }
const cases = [
  [['a', 'b', 'c'], ['a', 'x', 'c']],
  [['line1', 'line2', 'line3'], ['line1', 'line3']],
  [['old1', 'old2', 'x'], ['new1', 'new2']],
  [[], ['only', 'b']],
  [['a'], []],
  [['x'], ['x']],
];
for (let t = 0; t < 30; t++) { // random fuzz
  const mk = () => Array.from({ length: Math.floor(Math.random() * 12) }, () => 'l' + Math.floor(Math.random() * 5));
  cases.push([mk(), mk()]);
}
for (const [A, B] of cases) {
  const mine = diff.diffArrays(A, B);
  assert.strictEqual(cost(mine), cost(lcsOps(A, B)), 'minimal cost mismatch ' + JSON.stringify([A, B]));
  const ra = mine.filter((o) => o.type !== 'ins').map((o) => o.text);
  const rb = mine.filter((o) => o.type !== 'del').map((o) => o.text);
  assert.deepStrictEqual(ra, A, 'rebuild A');
  assert.deepStrictEqual(rb, B, 'rebuild B');
}
const dres = diff.diffLines('共享行\n旧行A\n旧行B\n尾部', '共享行\n新行A\n尾部');
assert.strictEqual(dres.stats.mod + dres.stats.del + dres.stats.add > 0, true);
assert.ok(dres.unified.includes('@@') && dres.unified.includes('-旧行B') && dres.unified.includes('+新行A'));

// ---------- textops ----------
assert.deepStrictEqual(textops.tokenize('HTTPSRequest2_user-Id'), ['HTTPS', 'Request', '2', 'user', 'Id']);
const styles = textops.namingAll('user name 2');
assert.strictEqual(styles.styles.find((s) => s.key === 'camel').value, 'userName2');
for (const s of ['hello_world_foo', 'HelloWorldFoo', 'hello-world-foo2', 'HELLO_WORLD', '__a__b__', '   ', '123']) {
  const r1 = textops.namingAll(s);
  if (!r1.ok) { assert.strictEqual(s, '   '); continue; }
  for (const st of r1.styles) {
    const back = textops.namingAll(st.value);
    assert.ok(back.ok, 'style output must retokenize: ' + st.label + ' <- ' + s);
    assert.strictEqual(back.styles.find((x) => x.key === st.key).value, st.value, 'idempotent ' + st.key + ' ' + s);
  }
}
const st = textops.countStats('中文abc word 中\n\n第二段 😀');
assert.strictEqual(st.chinese, 6, 'chinese (中文+中+第二段=6 汉字)');
assert.strictEqual(st.englishWords, 2, 'english');
assert.strictEqual(st.lines, 3, 'lines');
assert.strictEqual(st.paragraphs, 2, 'paragraphs');
assert.strictEqual(st.emoji, 1, 'emoji clusters');
assert.strictEqual(st.codepoints, Array.from('中文abc word 中\n\n第二段 😀').length);
assert.strictEqual(st.utf8Bytes, Buffer.from('中文abc word 中\n\n第二段 😀', 'utf8').length);
assert.strictEqual(textops.toHalfWidth('Ａ１？'), 'A1?');
assert.strictEqual(textops.toFullWidth('A1?'), 'Ａ１？');
assert.strictEqual(textops.CASE_MODES.t2s.fn('電腦測試'), '电脑测试');
assert.strictEqual(textops.CASE_MODES.s2t.fn('电脑测试'), '電腦測試');
const chain = textops.applyChain('b\n\na\nb\nc', [{ id: 'nonempty' }, { id: 'dedup' }, { id: 'sortAsc' }, { id: 'number', arg: '10' }]);
assert.strictEqual(chain.output, '10. a\n11. b\n12. c');
assert.strictEqual(chain.chainText, '去空行 → 去重（保留首次） → 升序排序 → 添加行号');
const chain2 = textops.applyChain('x y\nz', [{ id: 'prefix', arg: '> ' }, { id: 'replace', arg: 'x=>X' }]);
assert.strictEqual(chain2.output, '> X y\n> z');
// FR-TXT-12 full op set
assert.strictEqual(textops.applyChain('a\nb\nc', [{ id: 'number', arg: '10,5' }]).output, '10. a\n15. b\n20. c', 'number start/step');
assert.strictEqual(textops.applyChain('1\n2\n3\n4\n5', [{ id: 'slice', arg: '2,4' }]).output, '2\n3\n4', 'slice from/to inclusive');
assert.strictEqual(textops.applyChain('a\nb\nc', [{ id: 'join', arg: ',' }]).output, 'a,b,c', 'join');
assert.strictEqual(textops.applyChain('abcdefg', [{ id: 'split', arg: '3' }]).output, 'abc\ndef\ng', 'split by length');
assert.strictEqual(textops.applyChain('foo1 bar2', [{ id: 'replaceRe', arg: '(\\w+)\\d=>[$1]' }]).output, '[foo] [bar]', 'regex replace with $1');
assert.strictEqual(textops.applyChain('file10\nfile2\nfile1', [{ id: 'sortNat' }]).output, 'file1\nfile2\nfile10', 'natural numeric sort');
assert.strictEqual(textops.applyChain('bbb\na\ncc', [{ id: 'sortLen' }]).output, 'a\ncc\nbbb', 'sort by length');
assert.strictEqual(textops.applyChain('x', [{ id: 'slice', arg: '5,2' }]).notes.length, 1, 'bad arg becomes a note, no crash');
assert.strictEqual(textops.applyChain('x', [{ id: 'replaceRe', arg: '(=>x' }]).notes.length, 1, 'invalid regex becomes a note');
const shufChain = textops.applyChain('1\n2\n3\n4\n5', [{ id: 'shuffle' }]);
assert.strictEqual(shufChain.output.split('\n').sort().join(''), '12345', 'shuffle preserves lines');
assert.strictEqual(shufChain.chainText, '随机打乱', 'chain text lists executed ops');
// FR-TXT-08 extra counters
const st2 = textops.countStats('订单 3 笔，共 12.50 元；abc def!!! 😀😀');
assert.strictEqual(st2.digitRuns, 2, 'digit runs: 3 and 12.50');
assert.ok(st2.punctuation >= 6, 'punctuation counted: ' + st2.punctuation);
assert.strictEqual(st2.emoji, 2, 'two emoji clusters');
assert.strictEqual(st2.whitespace, st2.codepoints - st2.noWs);
// json: sortKeys / ensureAscii / tree folding
const sorted = json.format('{"b":1,"a":{"d":2,"c":1}}', 2, { sortKeys: true });
assert.ok(sorted.value.indexOf('"a"') < sorted.value.indexOf('"b"'), 'top-level keys sorted');
assert.ok(sorted.value.indexOf('"c"') < sorted.value.indexOf('"d"'), 'nested keys sorted');
assert.ok(json.minify('{"a":"中"}', { ensureAscii: true }).value === '{"a":"\\u4e2d"}', 'ensureAscii: ' + json.minify('{"a":"中"}', { ensureAscii: true }).value);
assert.strictEqual(json.format('{"a":"🚀"}', 2, { ensureAscii: true }).value.indexOf('\\ud83d\\ude80') > 0, true, 'surrogate pair escaped');
const treeAll = json.flatten(JSON.parse('{"a":{"b":{"c":1}},"x":2}'));
assert.strictEqual(json.visibleRows(treeAll.rows, {}).length, 5, 'all expanded');
const folded = json.collapseByDepth(treeAll.rows, 1);
assert.ok(Object.keys(folded).length >= 1, 'depth 1 folds nested containers');
assert.strictEqual(json.visibleRows(treeAll.rows, folded).length < treeAll.rows.length, true, 'folded view is shorter');
const oneFold = {};
oneFold[treeAll.rows[0].id] = true; // collapse root
assert.strictEqual(json.visibleRows(treeAll.rows, oneFold).length, 1, 'collapsing root keeps only root row');

// ---------- numsys ----------
assert.strictEqual(numsys.convert('ff', 16).decimal, '255');
assert.strictEqual(numsys.toStringBase(-255n, 16), '-ff');
assert.strictEqual(numsys.parseIntBase('z', 36).value, 35n);
assert.ok(numsys.parseIntBase('g', 16).message.includes('非法字符'));
assert.strictEqual(numsys.toSignedWidth(0xffffffffn, 32), -1n);
const c16 = numsys.convert('ff', 16);
assert.strictEqual(c16.w32.signed, '255');
assert.strictEqual(c16.twos32Hex, '000000ff');
const cn = numsys.convert('-1', 10);
assert.strictEqual(cn.w32.hex, 'ffffffff');
assert.strictEqual(cn.w64.hex, 'ffffffffffffffff');
assert.strictEqual(numsys.bitOp('f0', 16, '0f', 'and', null).signed, '0');
assert.strictEqual(numsys.bitOp('0', 10, '0', 'not', 32).signed, '-1');
assert.strictEqual(numsys.bitOp('1', 10, '31', 'shl', 32).signed, '-2147483648');
assert.strictEqual(numsys.bitOp('-8', 10, '1', 'shrArith', 32).signed, '-4');
assert.strictEqual(numsys.bitOp('-1', 10, '1', 'shrLogic', 32).unsigned, String(0x7fffffff));
for (const base of [2, 3, 8, 10, 16, 36]) {
  const p = numsys.parseIntBase('1z9x8k7j2'.slice(0, 6), 36);
  const s = numsys.toStringBase(p.value, base);
  assert.strictEqual(numsys.parseIntBase(s, base).value, p.value, 'roundtrip base ' + base);
}

// ---------- random ----------
const { ids } = rnd.uuidV4Batch(1000);
assert.strictEqual(ids.length, 1000);
assert.strictEqual(new Set(ids).size, 1000, 'duplicates');
const ure = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
for (const id of ids) assert.ok(ure.test(id), id);
const sf = rnd.snowflakeBatch(5, 7, 3);
assert.strictEqual(sf.ids.length, 5);
assert.strictEqual(new Set(sf.ids).size, 5);
assert.ok(sf.ids.every((x) => /^\d+$/.test(x) && Number(x) > 0));
assert.ok(rnd.snowflakeBatch(5, 32, 0).error.includes('workerId'));
const shuf = rnd.shuffleArray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.strictEqual(shuf.result.slice().sort((x, y) => x - y).join(','), '1,2,3,4,5,6,7,8,9,10', 'shuffle keeps multiset');
assert.ok(shuf.result.length === 10 && shuf.secure === false, 'fallback entropy flagged in node env');
const sfOne = rnd.snowflakeBatch(3, 7, 3);
for (const id of sfOne.ids) {
  const p = rnd.snowflakeParse(id);
  assert.strictEqual(p.workerId, 7);
  assert.strictEqual(p.datacenterId, 3);
  assert.ok(p.timestamp >= rnd.SNOWFLAKE_EPOCH && p.timestamp <= Date.now() + 1000, 'snowflake ms window');
}
assert.strictEqual(new Set(rnd.snowflakeBatch(200, 1, 1).ids).size, 200, '200 snowflake ids unique');

// ---------- regex safety ----------
const m1 = rs.safeMatchAll('(\\d+)-(\\d+)', 'g', 'abc 12-34 x 567-89', {});
assert.ok(m1.ok && m1.matches.length === 2 && m1.matches[0].groups[0].value === '12');
const m2 = rs.safeMatchAll('(?<year>\\d{4})', 'g', '2024 and 2025', {});
assert.strictEqual(m2.matches[0].named.year, '2024');
const t0 = Date.now();
const bad3 = rs.safeMatchAll('(a+)+b', 'g', 'a'.repeat(60) + 'c', {});
const took = Date.now() - t0;
assert.ok(bad3.interrupted && bad3.reason === 'catastrophic-detected', '(a+)+b must interrupt: ' + JSON.stringify(bad3));
assert.ok(took < 4000, 'interrupt fast, took ' + took + 'ms');
const t1 = Date.now();
const bad4 = rs.safeMatchAll('(a|aa)+$', 'g', 'a'.repeat(40), {});
assert.ok(bad4.interrupted && bad4.reason === 'catastrophic-detected', '(a|aa)+$ must interrupt');
assert.ok(Date.now() - t1 < 100, '(a|aa)+$ interrupted in ' + (Date.now() - t1) + 'ms');
const sintax = rs.safeMatchAll('(unclosed', 'g', 'x', {});
assert.ok(sintax.syntaxError, 'syntax error reported');
const midText = rs.safeMatchAll('\\w+', 'g', ('hello world foo '.repeat(400)).trim(), {});
assert.ok(midText.ok && midText.matches.length > 1000, 'linear pattern 1200 matches ok=' + midText.ok);
assert.ok(midText.elapsedMs < 1000, 'fast, took ' + midText.elapsedMs + 'ms');
const bigText = rs.safeMatchAll('\\w+', 'g', ('hello world foo '.repeat(2000)).trim(), {});
assert.ok(!bigText.ok && bigText.reason === 'too-many' && bigText.partial.length === rs.MAX_MATCHES, 'match cap reported instead of runaway');
// safe patterns must NOT be flagged (no false positives on real templates)
const TPL = ['^1[3-9]\\d{9}$', '^[\\w.+-]+@[\\w-]+\\.[\\w.-]+$', '^https?://[^\\s/]+(?:/[^\\s]*)?$', '^((25[0-5]|2[0-4]\\d|1\\d{2}|[1-9]?\\d)\\.){4}$', '^(\\d{1,3})(?:,\\d{3})*\\.\\d{2}$', '^[\\u4e00-\\u9fa5]{2,6}$', '(?<key>[a-z]+)=(?<val>[0-9]+)'];
for (const p of TPL) assert.ok(!rs.detectUnsafePattern(p).unsafe, 'template must be safe: ' + p);
for (const p of ['(a+)+b', '(\\d{1,3})+x', '(a|aa)+', '(\\w|\\d)+y', '.*.*x', '(x+x+)+y']) {
  const r = rs.detectUnsafePattern(p);
  assert.ok(r.unsafe, 'must flag: ' + p);
}
const rep = rs.safeMatchAll('(\\w+)@(\\w+)', 'g', 'a@x and bb@yy', {});
const out = rs.buildReplacement('a@x and bb@yy', rep.matches, '[$2#$1]');
assert.strictEqual(out, '[x#a] and [yy#bb]');
assert.deepStrictEqual(rs.groupLabels('(?<k>[a-z]+)(\\d)(?:x)(?<g>y)'), ['k', '', 'g']);
assert.deepStrictEqual(rs.groupLabels('[(](a)[)](?=b)'), [''], 'class parentheses / lookaround are not capture groups');

// ---------- hash vs node crypto ----------
const nodeCrypto = require('crypto');
const hstrs = ['', 'abc', '中文测试🚀', 'a'.repeat(1000), 'x'.repeat(128), 'x'.repeat(129), 'The quick brown fox jumps over the lazy dog'];
for (const s of hstrs) for (const a of ['md5', 'sha1', 'sha256', 'sha512']) {
  assert.strictEqual(hash[a](s), nodeCrypto.createHash(a).update(s).digest('hex'), 'hash ' + a + ' ' + s.length);
  assert.strictEqual(hash.hmac(a, 'key', s), nodeCrypto.createHmac(a, 'key').update(s).digest('hex'));
}
assert.strictEqual(hash.md5(''), 'd41d8cd98f00b204e9800998ecf8427e');

console.log('ALL LIB SELF-TESTS PASSED');
console.log('- hash: 28 assertions vs node crypto (md5/sha1/sha256/sha512/hmac)');
console.log('- codec: base64 中文往返 + 非法位置 + url/hex/unicode/html');
console.log('- json: 格式化/压缩/错误行列定位/树指针');
console.log('- diff: ' + cases.length + ' 组与 LCS-DP 参照等代价 + 双向重建');
console.log('- textops: 命名风格幂等往返 / 字数统计人工核对 / 操作链 / 繁简常用字');
console.log('- numsys: 进制往返 / 补码 / 位运算 32 位回绕');
console.log('- random: 1000 UUID 唯一 + v4 正则 / 雪花 / shuffle');
console.log('- regex: (a+)+b 中断耗时 ' + took + 'ms（<1s 保护，不卡死）');
