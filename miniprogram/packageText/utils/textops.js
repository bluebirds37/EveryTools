'use strict';
/**
 * packageText/utils/textops.js
 * Case conversion, naming-style conversion, multiline operation chain and
 * text statistics. All pure functions, offline safe.
 */
const codec = require('./codec');
const random = require('./random');

/* ---------------- tokenizing (shared by naming + title case) ---------------- */

/**
 * Split any identifier/sentence into normalized tokens.
 * Handles: _ - . / : ; space separators, camelCase boundaries, digit
 * boundaries, consecutive separators (collapsed), leading/trailing (dropped).
 * Empty/whitespace-only input -> [].
 */
function tokenize(input) {
  if (!input) return [];
  const s = String(input);
  if (!s.trim()) return [];
  const spaced = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/[_\-./\\:;]+/g, ' ')
    .replace(/\s+/g, ' ');
  const out = [];
  for (const w of spaced.split(' ')) if (w.length) out.push(w);
  return out;
}

const lowerFirst = (w) => w.charAt(0).toLowerCase() + w.slice(1);
const upperFirst = (w) => w.charAt(0).toUpperCase() + w.slice(1);

/* ---------------- naming styles ---------------- */

/* Style composition preserves intra-token case (like the change-case family),
   which keeps S(S(x)) === S(x) for single-letter and acronym tokens. */
const STYLES = {
  camel: (t) => t.map((w, i) => (i === 0 ? lowerFirst(w) : upperFirst(w))).join(''),
  pascal: (t) => t.map((w) => upperFirst(w)).join(''),
  snake: (t) => t.map((w) => w.toLowerCase()).join('_'),
  kebab: (t) => t.map((w) => w.toLowerCase()).join('-'),
  constant: (t) => t.map((w) => w.toUpperCase()).join('_'),
  title: (t) => t.map((w) => upperFirst(w)).join(' '),
};
const STYLE_LABELS = [
  ['camel', 'camelCase'],
  ['pascal', 'PascalCase'],
  ['snake', 'snake_case'],
  ['kebab', 'kebab-case'],
  ['constant', 'CONSTANT_CASE'],
  ['title', 'Title Case'],
];

/** @returns { ok, styles: [{key,label,value}], tokens } | { ok:false, message } */
function namingAll(input) {
  const tokens = tokenize(input);
  if (!tokens.length) return { ok: false, message: '请输入内容' };
  const styles = STYLE_LABELS.map(([key, label]) => ({ key, label, value: STYLES[key](tokens) }));
  return { ok: true, styles, tokens };
}

/* ---------------- case conversion ---------------- */

function toUpper(s) { return String(s).toUpperCase(); }
function toLower(s) { return String(s).toLowerCase(); }

/** Capitalize the first letter of the whole text only. */
function capitalize(s) {
  const str = String(s);
  return str.charAt(0).toUpperCase() + str.slice(1);
}

/** Title Case: first letter of every word capitalized. */
function titleCase(s) {
  return String(s).replace(/[A-Za-zÀ-ÿ']+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** Sentence case: capitalize after start / . ! ? / newline. */
function sentenceCase(s) {
  const out = String(s).toLowerCase();
  return out.replace(/(^|[.!?]\s|\n)([a-z])/g, (m, p1, p2) => p1 + p2.toUpperCase());
}

function alternatingCase(s) {
  let j = 0;
  return String(s).replace(/\S/g, (c) => {
    const r = j % 2 === 0 ? c.toLowerCase() : c.toUpperCase();
    j++;
    return r;
  });
}

function invertCase(s) {
  return String(s).replace(/[A-Za-z]/g, (c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase()));
}

/* ---------------- full width <-> half width ---------------- */

function toHalfWidth(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code === 0x3000) out += ' ';
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else out += ch;
  }
  return out;
}

function toFullWidth(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    if (code === 0x20) out += '\u3000';
    else if (code >= 0x21 && code <= 0x7e) out += String.fromCodePoint(code + 0xfee0);
    else out += ch;
  }
  return out;
}

/* ---------------- traditional / simplified ---------------- */
/* Curated common-character table (FR-TXT-15 is out of this batch's page list;
   these modes are exposed by the case page clearly labelled "常用字表").
   Each entry is a 2-char string: [traditional, simplified]. */
const T2S_PAIRS = (
  '愛爱|廠厂|廣广|東东|車车|馬马|鳥鸟|魚鱼|龍龙|風风|雲云|電电|開开|關关|門门|問问|間间|見见|觀观|規规|視视|覺觉|語语|說说|談谈|請请|謝谢|議议|護护|讀读|寫写|聽听|機机|橋桥|樓楼|樣样|樹树|歐欧|歎叹|畫画|異异|當当|復复|裡里|後后|從从|衆众|會会|倉仓|個个|們们|俠侠|儉俭|優优|傘伞|備备|醫医|鄉乡|審审|貨货|資资|賊贼|賞赏|贈赠|贊赞|體体|獨独|獅狮|獵猎|騰腾|驅驱|驗验|點点|黨党|齊齐|報报|場场|塊块|壽寿|將将|專专|導导|層层|屬属|帶带|帳帐|幀帧|戰战|敵敌|數数|時时|書书|雜杂|權权|歡欢|殘残|畢毕|漢汉|漲涨|漁渔|煉炼|燦灿|營营|獸兽|瑪玛|環环|發发|氣气|匯汇|歷历|歸归|殺杀|幣币|師师|幹干|慶庆|憲宪|應应|戲戏|擁拥|擇择|斃毙|條条|來来|楊杨|業业|極极|構构|殼壳|鐘钟|鐵铁|銀银|銅铜|鋼钢|錄录|徹彻|徑径|憶忆|懷怀|態态|總总|懸悬|驚惊|穩稳|簽签|簡简|補补|裝装|許许|論论|設设|訪访|證证|評评|識识|詞词|訴诉|課课|調调|譜谱|變变|讓让|訓训|講讲|貝贝|財财|責责|賢贤|敗败|賬账|質质|貴贵|費费|贏赢|選选|遺遗|鄰邻|遲迟|遷迁|損损|檢检|輸输|鏈链|銷销|鎖锁|鑑鉴|長长|陽阳|陰阴|階阶|隨随|隱隐|難难|靜静|頭头|頻频|題题|顏颜|額额|類类|飛飞|飯饭|館馆|駐驻|騎骑|驕骄|燈灯|靈灵|鳳凤|雞鸡|錨锚|錫锡|錘锤|錦锦|鎮镇|鏡镜|錢钱|閣阁|閥阀|閹阉|閻阎|闊阔|雞鸡|隊队|際际|陸陆|陳陈|險险|蘭兰|蘇苏|藥药|處处|無无|頁页|頂顶|項项|順顺|須须|頎颀|頏颃|預预|領领|頭头|頡颉|頤颐|頫俯|腳脚|腼腼|腸肠|膚肤|腺腺|腦脑|聲声|殼壳|顯显|証证|評评|誌志|選选|遺遗'
).split('|');

// extra pairs written with codepoints to avoid glyph confusion
const T2S_EXTRA = [
  '\u6E2C\u6D4B', // 測 -> 测
  '\u8A66\u8BD5', // 試 -> 试
  '\u8A8D\u8BA4', // 認 -> 认
  '\u8A0A\u8BAF', // 訊 -> 讯
  '\u8A33\u8BD1', // 譯 -> 译
  '\u6F22\u6C49', // 漢 -> 汉
  '\u8A9E\u8BED', // 語 -> 语
  '\u8AAA\u8BF4', // 說 -> 说
];
T2S_PAIRS.push.apply(T2S_PAIRS, T2S_EXTRA);

const DICT_T2S = {};
const DICT_S2T = {};
(function buildDict() {
  for (const p of T2S_PAIRS) {
    if (!p || p.length !== 2) continue; // strict 2-char entries only
    const t = p.charAt(0);
    const s = p.charAt(1);
    if (t === s) continue;
    if (!DICT_T2S[t]) DICT_T2S[t] = s;
    if (!DICT_S2T[s]) DICT_S2T[s] = t;
  }
})();

function convertDict(s, dict) {
  let out = '';
  for (const ch of String(s)) {
    out += dict[ch] !== undefined ? dict[ch] : ch;
  }
  return out;
}

const CASE_MODES = {
  upper: { label: '全部大写', fn: toUpper },
  lower: { label: '全部小写', fn: toLower },
  capitalize: { label: '首字母大写', fn: capitalize },
  title: { label: 'Title Case（每词大写）', fn: titleCase },
  sentence: { label: 'Sentence case（句首大写）', fn: sentenceCase },
  alternating: { label: 'aLtErNaTiNg', fn: alternatingCase },
  invert: { label: 'iNVERT cASE', fn: invertCase },
  half: { label: '全角 → 半角', fn: toHalfWidth },
  full: { label: '半角 → 全角', fn: toFullWidth },
  t2s: { label: '繁 → 简（常用字表）', fn: (s) => convertDict(s, DICT_T2S) },
  s2t: { label: '简 → 繁（常用字表）', fn: (s) => convertDict(s, DICT_S2T) },
};

/* ---------------- text statistics ---------------- */

function countStats(text) {
  const t = String(text);
  const codepoints = Array.from(t).length;
  let noWs = 0;
  for (const ch of t) if (!/\s/.test(ch)) noWs++;
  const chinese = (t.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const englishWords = (t.match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || []).length;
  const digitRuns = (t.match(/\d+(?:[.,]\d+)*/g) || []).length;
  const utf8Bytes = codec.utf8ToBytes(t).length;
  let lines = 0;
  if (t.length) lines = t.split(/\r\n|\r|\n/).length;
  let paragraphs = 0;
  if (t.trim().length) paragraphs = t.split(/\n\s*\n/).filter((p) => p.trim().length).length;
  let punctuation = 0;
  let emoji = 0;
  try {
    punctuation = (t.match(/\p{P}/gu) || []).length;
    // cluster-aware：旗帜必须成对消费（🇨🇳🇫🇷 是 2 面旗，不能贪婪并成 1 个簇），
    // ZWJ 家族/键帽走第二分支
    const clusters = t.match(
      /(?:\p{Regional_Indicator}\p{Regional_Indicator})|(?:\p{Extended_Pictographic}\uFE0F?\u20E3?(?:\u200D\p{Extended_Pictographic}\uFE0F?\u20E3?)*)/gu
    ) || [];
    emoji = clusters.length;
  } catch (e) {
    punctuation = (t.match(/[.,;:!?'"""''()\[\]{}<>—–\-_\/|@#$%^&*+=~`。，、；：？！”'‘’（）《》〈〉【】〔〕…．·｜]/g) || []).length;
    emoji = 0; // engine without unicode property escapes support
  }
  return {
    codepoints,
    noWs,
    whitespace: codepoints - noWs,
    chinese,
    englishWords,
    digitRuns,
    punctuation,
    utf8Bytes,
    lines,
    paragraphs,
    emoji,
  };
}

/* ---------------- multiline operation chain ---------------- */

/** Split a string into digit / non-digit chunks for natural ("file2 < file10") order. */
function naturalCompare(a, b) {
  const ra = String(a).match(/\d+|\D+/g) || [];
  const rb = String(b).match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = ra[i];
    const y = rb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
      if (x.length !== y.length) return x.length - y.length;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function parsePair(arg, name) {
  const parts = String(arg === undefined || arg === null ? '' : arg).split(/[,，]/);
  const a = parts[0] === undefined || parts[0].trim() === '' ? NaN : parseInt(parts[0], 10);
  const b = parts[1] === undefined || parts[1].trim() === '' ? NaN : parseInt(parts[1], 10);
  return { a: a, b: b, empty: parts.length === 0 || String(arg || '').trim() === '' };
}

/** Ops run on an array of lines; a thrown Error aborts just that step and the
 *  message is surfaced as a note instead of failing the whole chain. */
const MULTILINE_OPS = [
  { id: 'trim', label: '去首尾空白', hasArg: false, apply: (ls) => ls.map((l) => l.trim()) },
  { id: 'nonempty', label: '去空行', hasArg: false, apply: (ls) => ls.filter((l) => l.trim() !== '') },
  { id: 'dedup', label: '去重（保留首次）', hasArg: false, apply: (ls) => { const seen = {}; return ls.filter((l) => { if (seen[l]) return false; seen[l] = 1; return true; }); } },
  { id: 'sortAsc', label: '升序排序', hasArg: false, apply: (ls) => ls.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) },
  { id: 'sortDesc', label: '降序排序', hasArg: false, apply: (ls) => ls.slice().sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)) },
  { id: 'sortLen', label: '按行长升序', hasArg: false, apply: (ls) => ls.slice().sort((a, b) => a.length - b.length) },
  { id: 'sortNat', label: '自然数字排序', hasArg: false, apply: (ls) => ls.slice().sort(naturalCompare) },
  { id: 'reverse', label: '行序反转', hasArg: false, apply: (ls) => ls.slice().reverse() },
  { id: 'shuffle', label: '随机打乱', hasArg: false, apply: (ls) => { const r = random.shuffleArray(ls); return { lines: r.result, secure: r.secure }; } },
  { id: 'prefix', label: '加前缀', hasArg: true, argLabel: '前缀内容', argPlaceholder: '如 - 或 “> ”', apply: (ls, arg) => ls.map((l) => (arg || '') + l) },
  { id: 'suffix', label: '加后缀', hasArg: true, argLabel: '后缀内容', argPlaceholder: '如 ,', apply: (ls, arg) => ls.map((l) => l + (arg || '')) },
  { id: 'number', label: '添加行号', hasArg: true, argLabel: '起始,步长（默认 1,1）', argPlaceholder: '如 10,2', apply: (ls, arg) => {
      const p = parsePair(arg);
      const start = isNaN(p.a) ? 1 : p.a;
      const step = p.empty || isNaN(p.b) ? 1 : p.b;
      return ls.map((l, i) => (start + i * step) + '. ' + l);
    } },
  { id: 'slice', label: '截取行', hasArg: true, argLabel: '起始行,结束行（1 起，含端点）', argPlaceholder: '如 2,5', apply: (ls, arg) => {
      const p = parsePair(arg);
      const from = isNaN(p.a) ? 1 : Math.max(1, p.a);
      const to = isNaN(p.b) ? ls.length : Math.min(ls.length, p.b);
      if (to < from) throw new Error('结束行小于起始行');
      return ls.slice(from - 1, to);
    } },
  { id: 'join', label: '合并为一行', hasArg: true, argLabel: '分隔符（默认逗号）', argPlaceholder: '如 , 或空格', apply: (ls, arg) => {
      const sep = arg === undefined || arg === null || arg === '' ? ',' : String(arg);
      return [ls.join(sep)];
    } },
  { id: 'split', label: '按长度断行', hasArg: true, argLabel: '每段字符数', argPlaceholder: '如 20', apply: (ls, arg) => {
      const n = parseInt(arg, 10);
      if (!(n >= 1)) throw new Error('每段字符数需在 1 以上');
      if (n > 100000) throw new Error('每段字符数过大');
      const out = [];
      for (const l of ls) {
        if (l === '') { out.push(''); continue; }
        for (let i = 0; i < l.length; i += n) out.push(l.slice(i, i + n));
      }
      return out;
    } },
  { id: 'mergeWs', label: '合并连续空格', hasArg: false, apply: (ls) => ls.map((l) => l.replace(/[ \t]+/g, ' ')) },
  { id: 'replace', label: '查找替换（字面量）', hasArg: true, argLabel: '查找=>替换', argPlaceholder: '如 foo=>bar', apply: (ls, arg) => {
      const s = String(arg || '');
      const idx = s.indexOf('=>');
      const from = idx >= 0 ? s.slice(0, idx) : s;
      const to = idx >= 0 ? s.slice(idx + 2) : '';
      if (!from) throw new Error('查找内容不能为空');
      return ls.map((l) => l.split(from).join(to));
    } },
  { id: 'replaceRe', label: '查找替换（正则）', hasArg: true, argLabel: '正则=>替换（支持 $1）', argPlaceholder: '如 \\s+=>_', apply: (ls, arg) => {
      const s = String(arg || '');
      const idx = s.indexOf('=>');
      const from = idx >= 0 ? s.slice(0, idx) : s;
      const to = idx >= 0 ? s.slice(idx + 2) : '';
      if (!from) throw new Error('正则不能为空');
      let re;
      try {
        re = new RegExp(from, 'g');
      } catch (e) {
        throw new Error('正则语法不合法');
      }
      return ls.map((l) => l.replace(re, to));
    } },
];

const OP_BY_ID = {};
MULTILINE_OPS.forEach((o) => { OP_BY_ID[o.id] = o; });

/**
 * Apply chain: steps = [{id, arg}] executed in array order.
 * @returns { output, chainText, lineIn, lineOut, shuffleSecure, notes }
 */
function applyChain(text, steps) {
  let lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const lineIn = lines.length;
  const names = [];
  const notes = [];
  let shuffleSecure = null;
  for (const st of steps || []) {
    const op = OP_BY_ID[st.id];
    if (!op) continue;
    names.push(op.label);
    try {
      const res = op.apply(lines, st.arg);
      if (Array.isArray(res)) {
        lines = res;
      } else {
        lines = res.lines;
        if (res.secure !== undefined) shuffleSecure = res.secure;
      }
    } catch (e) {
      notes.push(op.label + '：' + (e && e.message ? e.message : '参数无效，已跳过'));
    }
  }
  return {
    output: lines.join('\n'),
    chainText: names.length ? names.join(' → ') : '（未选择操作）',
    lineIn,
    lineOut: lines.length,
    shuffleSecure,
    notes,
  };
}

module.exports = {
  tokenize,
  STYLES,
  STYLE_LABELS,
  namingAll,
  CASE_MODES,
  toHalfWidth,
  toFullWidth,
  convertDict,
  DICT_T2S,
  DICT_S2T,
  countStats,
  MULTILINE_OPS,
  applyChain,
  naturalCompare,
};
