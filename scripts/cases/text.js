/* 文本类（packageText）13 个工具的功能用例 —— runner 见 scripts/verify-tools.js
 *
 * 断言全部是「手算 / 与 openssl·node crypto·Buffer·encodeURIComponent 对照过的已知向量」，
 * 不接受「有返回就算过」。向量来源：
 *   - MD5/SHA-1/SHA-256/SHA-512、HMAC 与 node crypto、RFC 4231 Test Case 1 全等
 *   - UTF-8 字节手算（汉字 3 字节、emoji 4 字节、ZWJ 家族簇、区域指示符旗）
 *   - 1700000000 = 2023-11-14T22:13:20Z → +08 为 2023-11-15（周三）
 *   - 进制/补码/位运算/雪花位段用 BigInt 独立算式核对
 * 每个工具至少一条异常输入场景；expect 里用 inst 再跑几次（rerun 助手）覆盖
 * 「空输入 / 非法格式 / 超长」分支，避免为每个错误码开一个场景。
 */

/* ---------- 断言小工具 ---------- */
function eq(errs, label, got, want) {
  if (got !== want) errs.push(`${label}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`)
}
function has(errs, label, s, sub) {
  if (typeof s !== 'string' || s.indexOf(sub) < 0) errs.push(`${label}：应包含 ${JSON.stringify(sub)}，实际 ${JSON.stringify(s)}`)
}
/** 结果行：stats/case/multiline 放 data.kv，其余页面放 data.result.kv */
function kv(d, key) {
  const list = (d.kv && d.kv.length ? d.kv : (d.result && d.result.kv)) || []
  const r = list.filter((x) => x && x.key === key)[0]
  return r ? r.value : undefined
}
function kvp(d, prefix) {
  const list = (d.kv && d.kv.length ? d.kv : (d.result && d.result.kv)) || []
  const r = list.filter((x) => x && String(x.key).indexOf(prefix) === 0)[0]
  return r ? r.value : undefined
}
function hasKv(d, key) {
  const list = (d.kv && d.kv.length ? d.kv : (d.result && d.result.kv)) || []
  return list.some((x) => x && x.key === key)
}
/** diff 页的统计是 data.statRows[{k,v,c}] */
function stat(d, k) {
  const r = (d.statRows || []).filter((x) => x && x.k === k)[0]
  return r ? r.value !== undefined ? r.value : r.v : undefined
}
function conv(d, key) {
  const r = (d.convRows || []).filter((x) => x && x.key === key)[0]
  return r ? r.value : undefined
}
function bit(d, key) {
  const r = (d.bitRows || []).filter((x) => x && x.key === key)[0]
  return r ? r.value : undefined
}
/** 场景内再跑一次入口（各页输入字段名不同，故传完整 patch） */
function rerun(inst, patch, values) {
  if (values) inst.setData({ values: Object.assign({}, inst.data.values, values) })
  if (patch) inst.setData(patch)
  inst.setData({ busy: false })
  inst.onRun()
  return inst.data
}
function expectError(errs, d, code, sub, label) {
  if (!d.error) return errs.push(`${label}：应给出错误，实际 result=${JSON.stringify(d.result).slice(0, 90)}`)
  eq(errs, `${label} 错误码`, d.error.code, code)
  if (sub) has(errs, `${label} 错误文案`, d.error.message, sub)
}

/* ---------- 写死的已知向量 ---------- */
const V = {
  b64: {
    cn: '5pel5bi45bel5YW3566x', // '日常工具箱'（UTF-8 15 字节 → 24 字符）
    smile: '8J+Zgg==', // '🙂' U+1F642 → F0 9F 99 82
    plusSlash: { std: 'w7vDv8K/', url: 'w7vDv8K_' }, // 字节 FB FF BF
    urlCn: 'YT9iJmM95Lit5paH', // 'a?b&c=中文'
    latin1: 'Y2Fm6Q==', // 字节 63 61 66 E9
    helloFull: '5L2g5aW977yMQmFzZTY077yB' // '你好，Base64！'
  },
  hash: {
    abcMd5: '900150983cd24fb0d6963f7d28e17f72',
    abcSha1: 'a9993e364706816aba3e25717850c26c9cd0d89d',
    abcSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    abcSha512:
      'ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f',
    emptyMd5: 'd41d8cd98f00b204e9800998ecf8427e',
    cnMd5Upper: '78D347EB803C5A32A9D6BFFB0EFEC5E5', // md5('日常工具箱') 大写
    hmac256Rfc4231: 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7',
    hmac1Rfc4231: 'b617318655057264e28bc0b6fb378c8ef146be00',
    sha256HiThere: 'cc6d5896d770101ef0280c943a2d3c3f24cd5b11464a5186daf7a238477162ac',
    sha1HiThere: '4b3aed5f9fe40159b499536fb8a10cdf3bc62b4c'
  },
  ts: {
    utc: '2023-11-14 22:13:20',
    plus8: '2023-11-15 06:13:20',
    minus5: '2023-11-14 17:13:20',
    isoPlus8: '2023-11-15T06:13:20.000+08:00',
    msUtcIso: '2025-08-13T02:40:00.123Z'
  },
  url: {
    compCn: 'a%3D%E4%B8%AD%E6%96%87%26b%3D1%202',
    uriCn: 'a=%E4%B8%AD%E6%96%87&b=1%202',
    emoji: '%F0%9F%99%82',
    full: 'https://example.com/search?q=%E4%B8%AD%E6%96%87&page=2&tag=a&tag=b#top'
  },
  json5: '{ // 行注释\n  "id": 7,\n  "list": [1,2,3,], /* 块注释 */ }',
  json5Pretty: '{\n  "id": 7,\n  "list": [\n    1,\n    2,\n    3\n  ]\n}',
  statsMixed: 'Hello World! 你好，世界。\nThis is a ToolBox. 这是一个工具箱。',
  statsEmoji: '🎉🎉 Party 派对 👨‍👩‍👧 一家\n共 2 条消息',
  statsNum: '价格 1,234.56 元（含税 13%）；数量 20 个。',
  snowflakeFixed: '512389598414008320,512389598414008321,512389598414008322'
}

module.exports = {
  /* ============ FR-TXT-01 JSON 格式化 ============ */
  'text-json': [
    {
      name: '美化 indent=2 精确输出 + 往返无损',
      text: '{"b":1,"a":{"d":[3,2,1],"c":"中文"},"z":true}',
      values: { mode: 'pretty', indent: 2, sortKeys: false, ensureAscii: false, lenient: false },
      expect: (d, h, inst) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '美化结果', d.result && d.result.text,
          '{\n  "b": 1,\n  "a": {\n    "d": [\n      3,\n      2,\n      1\n    ],\n    "c": "中文"\n  },\n  "z": true\n}')
        eq(errs, '往返 deep-equal', JSON.stringify(JSON.parse(d.result.text)), JSON.stringify(JSON.parse(d.input)))
        has(errs, 'meta 标注端计算', d.result && d.result.meta, '· 端')
        const J = h.lib('packageText/utils/json.js')
        eq(errs, 'indent=4', J.format('[1]', 4).value, '[\n    1\n]')
        eq(errs, 'indent=tab', J.format('{"a":1}', '\t').value, '{\n\t"a": 1\n}')
        eq(errs, '顶层标量', J.format('42', 2).value, '42')
        eq(errs, '空数组', J.format('[]', 2).value, '[]')
        eq(errs, 'minify 去空白', J.minify('{ "a" : [ 1, 2 ] }').value, '{"a":[1,2]}')
        eq(errs, '非 ASCII 转义', J.toAsciiEscaped('中文'), '\\u4e2d\\u6587')
        eq(errs, '行:列换算', JSON.stringify(J.offsetToLineCol('abc\ndefg', 5)), JSON.stringify({ line: 2, col: 2 }))
        const empty = rerun(inst, { input: '' })
        if (!empty.error || empty.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY，实际 ' + JSON.stringify(empty.error))
        return errs
      }
    },
    {
      name: '压缩 + 键排序 + 中文转 \\u',
      text: '{"name":"日常工具箱","version":"1.0","tools":92,"tags":["b","a"]}',
      values: { mode: 'minify', indent: 2, sortKeys: true, ensureAscii: true, lenient: false },
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '压缩+排序+转义结果', d.result && d.result.text,
          '{"name":"\\u65e5\\u5e38\\u5de5\\u5177\\u7bb1","tags":["b","a"],"tools":92,"version":"1.0"}')
        const P = h.lib('packageText/pages/json/index.js')
        eq(errs, '代理对拆两个 \\u', P.ensureAsciiEscape(JSON.stringify({ e: '🙂' })), '{"e":"\\ud83d\\ude42"}')
        eq(errs, '转义后可还原', JSON.parse(P.ensureAsciiEscape(JSON.stringify({ e: '🙂' }))).e, '🙂')
        const J = h.lib('packageText/utils/json.js')
        eq(errs, '数组顺序不排序', J.minify('{"z":1,"a":{"y":1,"b":2}}', { sortKeys: true }).value, '{"a":{"b":2,"y":1},"z":1}')
        eq(errs, '页面 sortDeep 与库一致', JSON.stringify(P.sortDeep(JSON.parse('{"z":1,"a":{"y":1,"b":2}}'))), J.minify('{"z":1,"a":{"y":1,"b":2}}', { sortKeys: true }).value)
        return errs
      }
    },
    {
      name: '树视图：JSON Pointer 与折叠',
      text: '{"a":{"b":[1,2]},"c":3}',
      values: { mode: 'tree', indent: 2, sortKeys: false, ensureAscii: false, lenient: false },
      allowTimeout: true, // data.tree 不在 runner 的 settle 关键字段内
      expect: (d, h) => {
        const errs = []
        if (!d.tree) return ['树视图没有产出 data.tree（error=' + JSON.stringify(d.error) + '）']
        eq(errs, '指针序列', d.tree.all.map((r) => r.pointer + ':' + r.type).join(' | '),
          '/:object | /a:object | /a/b:array | /a/b/0:number | /a/b/1:number | /c:number')
        eq(errs, 'root preview', d.tree.all[0].preview, '{ 2 项 }')
        eq(errs, 'array preview', d.tree.all[2].preview, '[ 2 项 ]')
        eq(errs, '叶子不可展开', d.tree.all.filter((r) => r.pointer === '/c')[0].expandable, false)
        const J = h.lib('packageText/utils/json.js')
        eq(errs, '折叠 id=1 隐藏后代', J.visibleRows(d.tree.all, { 1: true }).map((r) => r.pointer).join(','), '/,/a,/c')
        eq(errs, '指针转义 /', J.flatten({ 'a/b': 1 }).rows[1].pointer, '/a~1b')
        eq(errs, '指针转义 ~', J.flatten({ 'a~b': 1 }).rows[1].pointer, '/a~0b')
        eq(errs, '节点上限', J.MAX_PTR_NODES, 20000)
        return errs
      }
    },
    {
      name: '宽松模式（注释+尾逗号）/ 严格模式与非法定位',
      knownDefect: 'pages/json/index.js:89-93 宽松模式先去尾逗号再去注释，注释挡在 }/] 前会漏删（页面自带样例即失败）',
      text: V.json5,
      values: { mode: 'pretty', indent: 2, sortKeys: false, ensureAscii: false, lenient: true },
      expect: (d, h, inst) => {
        const errs = []
        const P = h.lib('packageText/pages/json/index.js')
        // FR-TXT-01 明确「宽松模式支持 // 与 /* */ 注释、尾逗号」，且页面自带样例第 3 条
        // 就是这个组合。stripJson5 判尾逗号时只 lookahead 到下一个「非空白」字符，
        // 注释挡住 } / ] 导致尾逗号漏删 —— 保留本断言作为缺陷复现脚本。
        if (d.error) errs.push('宽松模式（注释 + 尾逗号）解析失败：' + JSON.stringify(d.error))
        eq(errs, '宽松模式结果', d.result && d.result.text, V.json5Pretty)
        eq(errs, '字符串内 // 保留', P.stripJson5('{"u":"http://x"}'), '{"u":"http://x"}')
        eq(errs, '字符串内 /* */ 保留', P.stripJson5('{"u":"/*x*/"}'), '{"u":"/*x*/"}')
        eq(errs, '无注释时尾逗号可删', P.stripJson5('{"id": 7, "list": [1,2,3,]}'), '{"id": 7, "list": [1,2,3]}')
        const strict = rerun(inst, undefined, { lenient: false })
        expectError(errs, strict, 'PARAM_INVALID', '第 1 行', '同一输入关闭宽松模式')
        const bad = rerun(inst, { input: '{"a": 1,, "b": }' })
        if (!bad.error) errs.push('非法 JSON 应报错')
        else {
          eq(errs, '非法 JSON 错误码', bad.error.code, 'PARAM_INVALID')
          has(errs, '非法 JSON 行列', bad.error.message, '第 1 行:9 列')
          has(errs, '非法 JSON 期望符号', bad.error.message, '对象键名必须是字符串')
          has(errs, '非法 JSON 上下文片段', bad.error.message, '上下文：')
        }
        const multi = rerun(inst, { input: '{\n  "a": 1,\n  "b": x\n}' })
        if (multi.error) has(errs, '多行非法定位', multi.error.message, '第 3 行:8 列')
        else errs.push('多行非法 JSON 应报错')
        const unclosed = rerun(inst, { input: '{"a": [1, 2' })
        if (!unclosed.error) errs.push('未闭合数组应报错')
        else has(errs, '未闭合定位', unclosed.error.message, '第 1 行:12 列')
        const deep = rerun(inst, { input: '[1, 2,]' })
        if (!deep.error) errs.push('数组尾逗号（严格模式）应报错')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-02 时间戳 ⇄ 日期 ============ */
  'text-timestamp': [
    {
      name: '秒级 1700000000 · 指定偏移 +8',
      text: '1700000000',
      values: { tz: 'offset', offset: 8, format: 'datetime', rangeCalc: false, rangeDays: 1 },
      expect: (d, h, inst) => {
        const errs = []
        const P = h.lib('packageText/pages/timestamp/index.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '秒级时间戳', kv(d, '秒级时间戳'), '1700000000')
        eq(errs, '毫秒时间戳', kv(d, '毫秒时间戳'), '1700000000000')
        eq(errs, '+08 日期时间', kv(d, '偏移 UTC+8 时间'), V.ts.plus8)
        eq(errs, '另一时区（UTC）', kv(d, '另一时区'), V.ts.utc)
        eq(errs, '星期', kv(d, '星期'), '周三') // 2023-11-15
        eq(errs, '结果文本', d.result && d.result.text, '秒：1700000000\n毫秒：1700000000000\n' + V.ts.plus8)
        eq(errs, '偏移 -5', P.formatDate(1700000000000, 'datetime', 'offset', -5), V.ts.minus5)
        eq(errs, '仅日期', P.formatDate(1700000000000, 'date', 'offset', 8), '2023-11-15')
        eq(errs, '仅时间', P.formatDate(1700000000000, 'time', 'offset', 8), '06:13:20')
        eq(errs, 'ISO 带偏移', P.formatDate(1700000000000, 'iso', 'offset', 8), V.ts.isoPlus8)
        eq(errs, '负毫秒', P.formatDate(-1000, 'datetime', 'utc', 0), '1969-12-31 23:59:59')
        eq(errs, '0 点', P.formatDate(0, 'datetime', 'utc', 0), '1970-01-01 00:00:00')
        eq(errs, '相对时间 3 天前', P.relativeTime(Date.now() - 3 * 86400000 - 1000, Date.now()), '3 天前')
        eq(errs, '相对时间 90 分钟后', P.relativeTime(Date.now() + 5400000, Date.now()), '1 小时后')
        const utc = rerun(inst, undefined, { tz: 'utc' })
        eq(errs, '切 UTC 后主行', utc.result && utc.result.text.split('\n')[2], V.ts.utc)
        return errs
      }
    },
    {
      name: '毫秒 13 位 · UTC ISO 与输入识别',
      text: '1755052800123',
      values: { tz: 'utc', offset: 8, format: 'iso', rangeCalc: false, rangeDays: 1 },
      expect: (d, h) => {
        const errs = []
        const P = h.lib('packageText/pages/timestamp/index.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        has(errs, 'UTC ISO 主行', d.result && d.result.text, V.ts.msUtcIso)
        eq(errs, '秒级时间戳', kv(d, '秒级时间戳'), '1755052800')
        eq(errs, '毫秒时间戳', kv(d, '毫秒时间戳'), '1755052800123')
        eq(errs, '星期', kv(d, '星期'), '周三') // 2025-08-13
        has(errs, 'meta 判定 13 位', d.result && d.result.meta, '毫秒 → 日期')
        eq(errs, '识别 10 位', P.detectKind('1700000000'), 'sec')
        eq(errs, '识别 13 位', P.detectKind('1755052800123'), 'ms')
        eq(errs, '11 位纯数字非法', P.detectKind('17000000000'), 'invalid')
        eq(errs, '识别日期', P.detectKind('2026-10-13 18:00:00'), 'date')
        eq(errs, '识别斜杠日期', P.detectKind('2026/10/13'), 'date')
        eq(errs, '识别 ISO T', P.detectKind('2026-10-13T18:00:00'), 'date')
        eq(errs, '空白判 empty', P.detectKind('   '), 'empty')
        return errs
      }
    },
    {
      name: '日期反解 + 区间 ±30 天（不依赖机器时区）',
      text: '2026-10-13 18:00:00',
      values: { tz: 'local', offset: 8, format: 'datetime', rangeCalc: true, rangeDays: 30 },
      expect: (d, h, inst) => {
        const errs = []
        const P = h.lib('packageText/pages/timestamp/index.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '毫秒时间戳与系统一致', kv(d, '毫秒时间戳'), String(new Date(2026, 9, 13, 18, 0, 0).getTime()))
        eq(errs, '本地显示回读输入', kvp(d, '本地时间'), '2026-10-13 18:00:00')
        eq(errs, '+30 天', kv(d, '+30 天后'), '2026-11-12 18:00:00')
        has(errs, 'meta 判定日期输入', d.result && d.result.meta, '日期 → 时间戳')
        eq(errs, '无时分秒补 0', P.parseDateText('2026-10-13').ms, new Date(2026, 9, 13, 0, 0, 0, 0).getTime())
        eq(errs, '.5 补足 500ms', P.parseDateText('2026-10-13 00:00:00.5').ms, new Date(2026, 9, 13, 0, 0, 0, 500).getTime())
        const neg = rerun(inst, undefined, { rangeDays: -1 })
        eq(errs, '-1 天', kv(neg, '-1 天后'), '2026-10-12 18:00:00')
        return errs
      }
    },
    {
      name: '非法日期 / 乱码 / 空输入 / 超长',
      text: '2026-02-30',
      values: { tz: 'utc', offset: 8, format: 'datetime', rangeCalc: false, rangeDays: 1 },
      expect: (d, h, inst) => {
        const errs = []
        const P = h.lib('packageText/pages/timestamp/index.js')
        expectError(errs, d, 'PARAM_INVALID', '非法日期：2026-02-30 不存在', '2 月 30 日')
        eq(errs, '2024-02-29 闰年合法', P.parseDateText('2024-02-29').ms, new Date(2024, 1, 29).getTime())
        has(errs, '2100 非闰年仍拦截', String(P.parseDateText('2100-02-29').error || ''), '不存在')
        has(errs, '13 月拦截', String(P.parseDateText('2026-13-01').error || ''), '月份需在 1–12 之间')
        has(errs, '无法识别的日期文案', String(P.parseDateText('2026 10 13').error || ''), '无法识别的日期')
        const abc = rerun(inst, { input: 'abc' })
        expectError(errs, abc, 'PARAM_INVALID', '无法识别的输入', '乱码输入')
        const short = rerun(inst, { input: '999' })
        expectError(errs, short, 'PARAM_INVALID', '无法识别的输入', '3 位纯数字')
        const digits20 = rerun(inst, { input: '99999999999999999999' })
        expectError(errs, digits20, 'PARAM_INVALID', '无法识别的输入', '20 位数字（不得静默算出错值）')
        const empty = rerun(inst, { input: '' })
        if (!empty.error || empty.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY，实际 ' + JSON.stringify(empty.error))
        // 超长输入必须说明「过长」，不能被当成空输入
        const over = rerun(inst, { input: '1'.repeat(1000001) })
        if (!over.error || !/过长/.test(String(over.error.message))) errs.push('超长输入应给出「过长」文案（当前码为 INPUT_EMPTY），实际 ' + JSON.stringify(over.error))
        else has(errs, '超长文案说明过长', over.error.message, '过长')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-03 Base64 编解码 ============ */
  'text-base64': [
    {
      name: 'UTF-8 中文编码 + 膨胀率',
      text: '日常工具箱',
      values: { dir: 'encode', variant: 'std', charset: 'utf8', lineWrap: false },
      expect: (d, h, inst) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '编码结果', d.result && d.result.text, V.b64.cn)
        eq(errs, '结果长度（15 字节 → 20 字符）', V.b64.cn.length, 20)
        eq(errs, '输入字符数', kv(d, '输入字符数'), '5')
        eq(errs, '输出长度', kv(d, '输出长度'), '20')
        eq(errs, '膨胀率', kv(d, '膨胀率'), '+33%') // 20 / 15 - 1
        const C = h.lib('packageText/utils/codec.js')
        eq(errs, 'emoji 4 字节', C.encodeBase64('🙂'), V.b64.smile)
        eq(errs, 'FB FF BF → std 含 +/', C.encodeBase64('ûÿ¿'), V.b64.plusSlash.std)
        eq(errs, 'FB FF BF → url 用 -_', C.encodeBase64('ûÿ¿', 'url'), V.b64.plusSlash.url)
        eq(errs, '中文全角标点', C.encodeBase64('你好，Base64！'), V.b64.helloFull)
        eq(errs, '空串', C.encodeBase64(''), '')
        eq(errs, '与 Buffer 对照', C.encodeBase64('The quick brown fox jumps 019'), Buffer.from('The quick brown fox jumps 019', 'utf8').toString('base64'))
        const empty = rerun(inst, { input: '' })
        if (!empty.error || empty.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY：' + JSON.stringify(empty.error))
        return errs
      }
    },
    {
      name: '解码还原 + Latin-1 与折行',
      text: V.b64.cn,
      values: { dir: 'decode', variant: 'std', charset: 'utf8', lineWrap: false },
      expect: (d, h) => {
        const errs = []
        const P = h.lib('packageText/pages/base64/index.js')
        const C = h.lib('packageText/utils/codec.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '解码结果', d.result && d.result.text, '日常工具箱')
        eq(errs, '还原字符数', kv(d, '还原字符数'), '5')
        eq(errs, '全角标点还原', C.decodeBase64ToStr(V.b64.helloFull, 'std'), '你好，Base64！')
        eq(errs, 'url 变体解码', C.decodeBase64ToStr(V.b64.plusSlash.url, 'url'), 'ûÿ¿')
        eq(errs, 'latin1 解码', P.latin1Decode(V.b64.latin1, 'std'), 'caf\xe9')
        eq(errs, '容忍 MIME 折行', C.decodeBase64ToStr('5pel5bi4\n5bel5YW3\n566x', 'std'), '日常工具箱')
        eq(errs, '无 padding 可解', C.decodeBase64ToStr('5pel5bi45bel5YW3566x', 'std'), '日常工具箱')
        eq(errs, '76 折行切片', P.wrapLines('x'.repeat(160), 76).split('\n').map((s) => s.length).join(','), '76,76,8')
        eq(errs, '往返一致', C.encodeBase64(C.decodeBase64ToStr(V.b64.smile, 'std'), 'std'), V.b64.smile)
        eq(errs, '与 Buffer 对照解码', C.decodeBase64ToStr(V.b64.cn, 'std'), Buffer.from(V.b64.cn, 'base64').toString('utf8'))
        return errs
      }
    },
    {
      name: 'URL-Safe 变体 + 每 76 字符折行',
      text: 'a?b&c=中文',
      values: { dir: 'encode', variant: 'url', charset: 'utf8', lineWrap: true },
      expect: (d, h) => {
        const errs = []
        const C = h.lib('packageText/utils/codec.js')
        const P = h.lib('packageText/pages/base64/index.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, 'url 变体结果', d.result && d.result.text, V.b64.urlCn)
        eq(errs, '折行后仍是单行', d.result.text.split('\n').map((s) => s.length).join(','), '16')
        eq(errs, '输出长度按未折行计', kv(d, '输出长度'), '16')
        eq(errs, 'std/url 同串（本样无 +/）', C.encodeBase64('a?b&c=中文', 'std'), V.b64.urlCn)
        eq(errs, 'FB FF BF url 去 padding', C.encodeBase64('ûÿ¿', 'url'), V.b64.plusSlash.url)
        const long = '日常工具箱'.repeat(12) // 180 字节 → 240 字符
        eq(errs, '长串 std 长度', C.encodeBase64(long).length, 240)
        eq(errs, '长串折行', P.wrapLines(C.encodeBase64(long), 76).split('\n').map((s) => s.length).join(','), '76,76,76,12')
        return errs
      }
    },
    {
      name: '非法字符 / 长度不合法 / 截断 UTF-8 / 超长',
      text: '!!!!@@@####@@@',
      values: { dir: 'decode', variant: 'std', charset: 'utf8', lineWrap: false },
      expect: (d, h, inst) => {
        const errs = []
        const C = h.lib('packageText/utils/codec.js')
        expectError(errs, d, 'PARAM_INVALID', '含非法字符 "!"（第 1 个字符）', '非法字符')
        const len1 = rerun(inst, { input: 'QQQQQ' })
        expectError(errs, len1, 'PARAM_INVALID', 'Base64 长度不合法', '结尾多 1 个字符')
        const trunc = rerun(inst, { input: '5pel5bi45bel5YW3566' })
        expectError(errs, trunc, 'PARAM_INVALID', 'UTF-8 序列不完整', '截断多字节')
        const enc = rerun(inst, { input: '日常工具箱' }, { dir: 'encode', variant: 'url' })
        if (enc.error) errs.push('url 编码不该失败：' + JSON.stringify(enc.error))
        eq(errs, 'url 编码输出', enc.result.text, V.b64.cn)
        // 超长必须是「过长」提示，不能退化成「请先选择内容」
        const over = rerun(inst, { input: 'x'.repeat(1000001) })
        if (!over.error || !/过长/.test(String(over.error.message))) errs.push('超长输入应给出「过长」文案（当前码为 INPUT_EMPTY），实际 ' + JSON.stringify(over.error))
        else has(errs, '超长文案说明过长', over.error.message, '1,000,000')
        let caught = null
        try {
          inst.setData({ values: { dir: 'encode', variant: 'std', charset: 'latin1', lineWrap: false }, input: 'café日' })
          inst.doCodec()
        } catch (e) { caught = e }
        if (!caught || String(caught.message).indexOf('第 5 个字符') < 0) errs.push('Latin1 越界应提示第 5 个字符，实际 ' + (caught && caught.message))
        eq(errs, 'std 字母表拒绝 url 变体字符', (() => { try { C.base64ToBytes('w7vDv8K_', 'std'); return 'no-throw' } catch (e) { return /非法字符/.test(e.message) ? 'throw' : 'other' } })(), 'throw')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-04 URL 编解码 ============ */
  'text-url': [
    {
      name: '组件编码（encodeURIComponent 语义）',
      text: 'a=中文&b=1 2',
      values: { dir: 'encode', scope: 'component', keepSafe: false },
      expect: (d, h, inst) => {
        const errs = []
        const C = h.lib('packageText/utils/codec.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '组件编码', d.result && d.result.text, V.url.compCn)
        eq(errs, '与 encodeURIComponent 一致', d.result.text, encodeURIComponent('a=中文&b=1 2'))
        eq(errs, '输出长度', kv(d, '输出长度'), String(V.url.compCn.length))
        eq(errs, '输入长度', kv(d, '输入长度'), '10')
        eq(errs, 'emoji 4 段', C.urlEncodeComponent('🙂'), V.url.emoji)
        eq(errs, 'unreserved 不编码', C.urlEncodeComponent('A-.~_'), 'A-.~_')
        // 组件模式声明「按 encodeURIComponent 语义」：! ' ( ) * 属于其保留集，不应转义
        eq(errs, "保留字符 !'()* 与 encodeURIComponent 一致", C.urlEncodeComponent("!~*'()"), encodeURIComponent("!~*'()"))
        const keep = rerun(inst, undefined, { keepSafe: true })
        eq(errs, '保留安全字符（encodeURI 语义）', keep.result && keep.result.text, V.url.uriCn)
        eq(errs, '与 encodeURI 一致', keep.result.text, encodeURI('a=中文&b=1 2'))
        return errs
      }
    },
    {
      name: '组件解码：+ / %20 / 双重编码',
      text: '%E4%BD%A0%E5%A5%BD%20world',
      values: { dir: 'decode', scope: 'component', keepSafe: false },
      expect: (d, h, inst) => {
        const errs = []
        const C = h.lib('packageText/utils/codec.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '解码结果', d.result && d.result.text, '你好 world')
        const plus = rerun(inst, { input: 'a+b%2Bc%20d' })
        eq(errs, '+ 解为空格、%2B 解为 +', plus.result && plus.result.text, 'a b+c d')
        const dbl = rerun(inst, { input: '%25E4%25B8%25AD%25E6%2596%2587' })
        eq(errs, '双重编码只解一层', dbl.result && dbl.result.text, '%E4%B8%AD%E6%96%87')
        eq(errs, '再解一层得中文', C.urlDecode('%E4%B8%AD%E6%96%87', true), '中文')
        eq(errs, '小写十六进制可解', C.urlDecode('%e4%bd%a0', true), '你')
        eq(errs, '往返一致', C.urlDecode(C.urlEncodeComponent('日常工具箱 a&b=c?d#e/f%g'), true), '日常工具箱 a&b=c?d#e/f%g')
        eq(errs, 'plusAsSpace=false 时 + 保留', C.urlDecode('a+b', false), 'a+b')
        const raw = rerun(inst, { input: '中文未编码' })
        eq(errs, '未编码中文宽松通过', raw.result && raw.result.text, '中文未编码')
        return errs
      }
    },
    {
      name: '整链解析 + 参数增删重建',
      text: V.url.full,
      values: { dir: 'decode', scope: 'full', keepSafe: false },
      expect: (d, h, inst) => {
        const errs = []
        const P = h.lib('packageText/pages/url/index.js')
        if (d.error) errs.push('整链解析失败：' + JSON.stringify(d.error))
        if (!d.parsed) return ['整链模式没有产出 parsed']
        eq(errs, 'scheme', d.parsed.scheme, 'https')
        eq(errs, 'host', d.parsed.host, 'example.com')
        eq(errs, 'path', d.parsed.path, '/search')
        eq(errs, 'hash 解码', d.parsed.hash, 'top')
        eq(errs, '参数（重复键保留）', d.parsed.params.map((p) => p[0] + '=' + p[1]).join('&'), 'q=中文&page=2&tag=a&tag=b')
        eq(errs, '重建 URL 语义等价', d.result && d.result.text, V.url.full)
        eq(errs, 'query 参数计数', kv(d, 'query 参数'), '4 项')
        eq(errs, '无 query 时 path 补 /', P.parseUrl('https://example.com').path, '/')
        eq(errs, '其它 scheme', P.parseUrl('ftp://host/a/b').scheme, 'ftp')
        eq(errs, '非链接拒绝', P.parseUrl('not a url'), null)
        eq(errs, 'keepSafe 重建只编中文', P.buildUrl(P.parseUrl(V.url.full), true), 'https://example.com/search?q=%E4%B8%AD%E6%96%87&page=2&tag=a&tag=b#top')
        inst.onDelParam({ currentTarget: { dataset: { i: 0 } } })
        eq(errs, '删参数后重建', inst.data.result.text, 'https://example.com/search?page=2&tag=a&tag=b#top')
        inst.onAddParam()
        eq(errs, '加参数后重建', inst.data.result.text, 'https://example.com/search?page=2&tag=a&tag=b&key4=#top')
        inst.editParam(0, 1, '新值 与 空格')
        eq(errs, '改值后重新编码', inst.data.result.text, 'https://example.com/search?%E6%96%B0%E5%80%BC%20%E4%B8%8E%20%E7%A9%BA%E6%A0%BC=2&tag=a&tag=b&key4=#top'.replace('%E6%96%B0%E5%80%BC%20%E4%B8%8E%20%E7%A9%BA%E6%A0%BC=2', 'page=%E6%96%B0%E5%80%BC%20%E4%B8%8E%20%E7%A9%BA%E6%A0%BC'))
        return errs
      }
    },
    {
      name: '非法转义 / 非链接 / 空输入 / 超长',
      text: '%E4%A0',
      values: { dir: 'decode', scope: 'component', keepSafe: false },
      expect: (d, h, inst) => {
        const errs = []
        expectError(errs, d, 'PARAM_INVALID', 'UTF-8', '半截 UTF-8 序列')
        const badPct = rerun(inst, { input: '100%25%zz' })
        expectError(errs, badPct, 'PARAM_INVALID', '第 7 个字符', '非法 % 转义带位置')
        const fullBad = rerun(inst, { input: '没有协议的文本' }, { scope: 'full' })
        expectError(errs, fullBad, 'PARAM_INVALID', '整链模式需形如', '整链模式非链接')
        const empty = rerun(inst, { input: '' }, { scope: 'component' })
        if (!empty.error || empty.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY：' + JSON.stringify(empty.error))
        const over = rerun(inst, { input: 'x'.repeat(1000001) })
        if (!over.error || !/过长/.test(String(over.error.message))) errs.push('超长输入应给出「过长」文案（当前码为 INPUT_EMPTY），实际 ' + JSON.stringify(over.error))
        else has(errs, '超长文案说明过长', over.error.message, '1,000,000')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-05 哈希计算 ============ */
  'text-hash': [
    {
      name: "'abc' 全家族摘要与 openssl 对照",
      text: 'abc',
      values: { algo: 'sha256', upper: false, key: '' },
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, 'SHA-256("abc")', d.result && d.result.text, V.hash.abcSha256)
        eq(errs, '摘要长度', kv(d, '摘要长度'), '256 bit')
        eq(errs, '输入字节数(UTF-8)', kv(d, '输入字节数(UTF-8)'), '3')
        const H = h.lib('packageText/utils/hash.js')
        const cr = require('crypto')
        eq(errs, 'MD5("abc")', H.md5('abc'), V.hash.abcMd5)
        eq(errs, 'SHA-1("abc")', H.sha1('abc'), V.hash.abcSha1)
        eq(errs, 'SHA-512("abc")', H.sha512('abc'), V.hash.abcSha512)
        eq(errs, '空串 MD5', H.md5(''), V.hash.emptyMd5)
        eq(errs, 'SHA-512 输出 128 hex', H.sha512('abc').length, 128)
        // 分块/长度字段边界：与 node crypto 逐长度对照
        for (const len of [55, 56, 63, 64, 65, 111, 119, 120, 128, 129]) {
          const s = 'a'.repeat(len)
          eq(errs, `SHA-256 分块边界 ${len}`, H.sha256(s), cr.createHash('sha256').update(s).digest('hex'))
          eq(errs, `SHA-512 分块边界 ${len}`, H.sha512(s), cr.createHash('sha512').update(s).digest('hex'))
        }
        const C = h.lib('packageText/utils/codec.js')
        eq(errs, '按 UTF-8 字节而非码点', H.sha256('日常工具箱'), cr.createHash('sha256').update(C.utf8ToBytes('日常工具箱')).digest('hex'))
        return errs
      }
    },
    {
      name: '中文 MD5 + 大写输出',
      text: '日常工具箱',
      values: { algo: 'md5', upper: true, key: '' },
      expect: (d, h, inst) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '大写 MD5', d.result && d.result.text, V.hash.cnMd5Upper)
        eq(errs, '输入字节数(UTF-8)', kv(d, '输入字节数(UTF-8)'), '15')
        eq(errs, '摘要长度', kv(d, '摘要长度'), '128 bit')
        eq(errs, '首行是摘要行', kv(d, 'MD5 摘要'), V.hash.cnMd5Upper)
        has(errs, 'meta 记录算法', d.result && d.result.meta, 'md5')
        const lower = rerun(inst, undefined, { upper: false })
        eq(errs, '小写 MD5', lower.result.text, '78d347eb803c5a32a9d6bffb0efec5e5')
        const sha512 = rerun(inst, { input: '' }, { algo: 'sha512', upper: false })
        if (!sha512.error || sha512.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY：' + JSON.stringify(sha512.error))
        const h5 = h.lib('packageText/utils/hash.js')
        eq(errs, 'SHA-512 空串', h5.sha512(''), require('crypto').createHash('sha512').update('').digest('hex'))
        return errs
      }
    },
    {
      name: 'HMAC（RFC 4231 Test Case 1）',
      text: 'Hi There',
      values: { algo: 'sha256', upper: false, key: '\u000b'.repeat(20) },
      expect: (d, h) => {
        const errs = []
        const H = h.lib('packageText/utils/hash.js')
        const cr = require('crypto')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, 'HMAC 行存在', hasKv(d, 'HMAC-SHA256'), true)
        const lines = (d.result.text || '').split('\n')
        eq(errs, 'SHA-256("Hi There")', lines[0], V.hash.sha256HiThere)
        eq(errs, 'HMAC-SHA256 = RFC 4231', lines[1], V.hash.hmac256Rfc4231)
        eq(errs, '字节数', kv(d, '输入字节数(UTF-8)'), '8')
        has(errs, 'meta 标注 + HMAC', d.result.meta, '+ HMAC')
        eq(errs, 'HMAC-SHA1 = RFC 4231', H.hmac('sha1', '\u000b'.repeat(20), 'Hi There'), V.hash.hmac1Rfc4231)
        eq(errs, 'SHA-1("Hi There")', H.sha1('Hi There'), V.hash.sha1HiThere)
        const longKey = 'key'.repeat(50) // > 分块长度：先摘要密钥
        eq(errs, 'HMAC 长密钥 SHA-256', H.hmac('sha256', longKey, 'abc'), cr.createHmac('sha256', Buffer.from(longKey, 'utf8')).update('abc').digest('hex'))
        eq(errs, 'HMAC 长密钥 SHA-512', H.hmac('sha512', longKey, 'abc'), cr.createHmac('sha512', Buffer.from(longKey, 'utf8')).update('abc').digest('hex'))
        eq(errs, 'HMAC-MD5 中文密钥', H.hmac('md5', '密钥', '日常工具箱'), cr.createHmac('md5', Buffer.from('密钥', 'utf8')).update('日常工具箱').digest('hex'))
        return errs
      }
    },
    {
      name: '空输入 / 超 2MB / 代理对非法',
      text: '',
      values: { algo: 'sha1', upper: false, key: '' },
      expect: (d, h, inst) => {
        const errs = []
        if (!d.error || d.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY，实际 ' + JSON.stringify(d.error))
        const big = rerun(inst, { input: 'a'.repeat(2 * 1024 * 1024 + 1) })
        expectError(errs, big, 'FILE_TOO_LARGE', '拆分', '超过 2MB 主线程上限')
        const ok2m = rerun(inst, { input: 'a'.repeat(2 * 1024 * 1024) })
        if (ok2m.error) errs.push('刚好 2MB 应可计算：' + JSON.stringify(ok2m.error))
        const lone = rerun(inst, { input: '\ud800' })
        expectError(errs, lone, 'PARAM_INVALID', '孤立高位代理', '孤立代理项')
        const abc = rerun(inst, { input: 'abc' }, { algo: 'sha1' })
        eq(errs, 'SHA-1("abc")', abc.result && abc.result.text, V.hash.abcSha1)
        return errs
      }
    }
  ],

  /* ============ FR-TXT-06 UUID / 随机串 ============ */
  'text-uuid': [
    {
      name: '批量 UUID v4：版本/变体位与去重',
      values: { type: 'uuidv4', count: 8, hyphens: true, length: 21, charset: '', excludeAmbiguous: false },
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        const ids = ((d.result && d.result.text) || '').split('\n')
        eq(errs, '数量', ids.length, 8)
        eq(errs, '数量行', kv(d, '数量'), '8')
        eq(errs, '去重校验', kv(d, '去重校验'), '无重复')
        const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
        ids.forEach((id, i) => { if (!re.test(id)) errs.push(`第 ${i + 1} 个不符合 RFC 4122 v4：${id}`) })
        eq(errs, '互不相同', new Set(ids).size, 8)
        has(errs, '随机源标注', String(kv(d, '随机源') || ''), '种子')
        const R = h.lib('packageText/utils/random.js')
        const batch = R.uuidV4Batch(1000)
        eq(errs, '1000 个批次长度', batch.ids.length, 1000)
        eq(errs, '1000 个无重复', new Set(batch.ids).size, 1000)
        eq(errs, '1000 个全合法', batch.ids.filter((x) => re.test(x)).length, 1000)
        eq(errs, '版本位全为 4', batch.ids.filter((x) => x[14] === '4').length, 1000)
        eq(errs, '变体位全为 8/9/a/b', batch.ids.filter((x) => '89ab'.indexOf(x[19]) >= 0).length, 1000)
        // 分布抽查：第 3 段 hex 的首位应大致均匀（16 个值都出现）
        eq(errs, '1000 个覆盖全部 hex 首位', new Set(batch.ids.map((x) => x[0])).size, 16)
        return errs
      }
    },
    {
      name: 'NanoID 字符集与口令强度',
      values: { type: 'nanoid', count: 10, hyphens: false, length: 16, charset: '', excludeAmbiguous: false },
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        const ids = (d.result.text || '').split('\n')
        eq(errs, 'NanoID 数量', ids.length, 10)
        ids.forEach((id, i) => {
          if (id.length !== 16) errs.push(`第 ${i + 1} 个长度不是 16：${id}`)
          if (!/^[A-Za-z0-9_~\-]+$/.test(id)) errs.push(`第 ${i + 1} 个含表外字符：${id}`)
        })
        const P = h.lib('packageText/pages/uuid/index.js')
        eq(errs, 'A-Za-z0-9 区间展开', P.expandCharset('A-Za-z0-9').length, 62)
        eq(errs, '空字符集回落 alnum', P.expandCharset(''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')
        eq(errs, '转义字面 \\-', P.expandCharset('a\\-b'), 'a-b')
        eq(errs, '强度 62^24', JSON.stringify(P.strengthOf(24, 62)), JSON.stringify({ label: '极强', entropy: 143 }))
        eq(errs, '强度 10^8 → 弱', JSON.stringify(P.strengthOf(8, 10)), JSON.stringify({ label: '弱', entropy: 27 }))
        eq(errs, '强度 60 bit 边界为「中」', P.strengthOf(10, 62).label, '中')
        eq(errs, '强度 89 bit 仍为「强」', P.strengthOf(15, 62).label, '强')
        eq(errs, '强度 ≥90 bit 为「极强」', P.strengthOf(16, 62).label, '极强')
        return errs
      }
    },
    {
      name: '雪花 ID：位段拼装与无精度坍缩',
      values: { type: 'snowflake', count: 5, hyphens: true, length: 21, charset: '', excludeAmbiguous: false },
      expect: (d, h) => {
        const errs = []
        const R = h.lib('packageText/utils/random.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        const ids = (d.result.text || '').split('\n')
        eq(errs, '数量', ids.length, 5)
        eq(errs, '全为数字串', ids.every((x) => /^[1-9]\d{10,20}$/.test(x)), true)
        eq(errs, '互不相同', new Set(ids).size, 5)
        const parsed = ids.map((x) => R.snowflakeParse(x))
        eq(errs, 'datacenterId 位段', parsed.map((p) => p.datacenterId).join(','), '0,0,0,0,0')
        eq(errs, 'workerId 位段', parsed.map((p) => p.workerId).join(','), '1,1,1,1,1')
        eq(errs, 'sequence 递增', parsed.map((p) => p.sequence).join(','), '0,1,2,3,4')
        const now = Date.now()
        parsed.forEach((p, i) => { if (p.timestamp > now + 5000 || p.timestamp < now - 600000) errs.push(`第 ${i + 1} 个时间戳越界：${p.timestamp}`) })
        // 独立 BigInt 位段算式核对：41 位时刻(自定义纪元) + 5 位机房 + 5 位机器 + 12 位序列
        const ts = 1700000000000
        const expectIds = [0, 1, 2].map((i) => ((((BigInt(ts) - BigInt(R.SNOWFLAKE_EPOCH)) << 22n) | (9n << 17n) | (7n << 12n) | BigInt(i))).toString()).join(',')
        eq(errs, '定时刻拼装精确值', R.snowflakeBatch(3, 7, 9, ts).ids.join(','), expectIds)
        eq(errs, '写死的期望串', expectIds, V.snowflakeFixed)
        const back = R.snowflakeParse(expectIds.split(',')[0])
        eq(errs, '反解时刻', back.timestamp, ts)
        eq(errs, '反解 worker/dc', back.workerId + '/' + back.datacenterId, '7/9')
        eq(errs, '纪元 2020-01-01', String(R.SNOWFLAKE_EPOCH), '1577836800000')
        eq(errs, 'workerId 越界拒绝', String(R.snowflakeBatch(1, 99).error || ''), '参数错误：workerId 需在 0–31 之间')
        eq(errs, '机房越界拒绝', String(R.snowflakeBatch(1, 0, 99).error || ''), '参数错误：datacenterId 需在 0–31 之间')
        return errs
      }
    },
    {
      name: '自定义字符集 / 排除易混 / 异常参数',
      values: { type: 'custom', count: 4, hyphens: true, length: 12, charset: 'ab', excludeAmbiguous: false },
      expect: (d, h, inst) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        const ids = (d.result.text || '').split('\n')
        eq(errs, '数量', ids.length, 4)
        ids.forEach((id, i) => { if (!/^[ab]{12}$/.test(id)) errs.push(`第 ${i + 1} 个只应含 a/b 且长 12：${id}`) })
        eq(errs, '口令强度行', kv(d, '口令强度'), '弱（约 12 bit 熵）')
        const amb = rerun(inst, undefined, { charset: '0O1lIabc', excludeAmbiguous: true, length: 20 })
        ;(amb.result.text || '').split('\n').forEach((id, i) => { if (!/^[abc]{20}$/.test(id)) errs.push(`排除易混后第 ${i + 1} 个：${id}`) })
        const one = rerun(inst, undefined, { charset: 'a', excludeAmbiguous: false })
        expectError(errs, one, 'PARAM_INVALID', '字符集至少需要 2 个字符', '单字符字符集')
        const clamp = rerun(inst, undefined, { charset: '', count: 99999, type: 'uuidv4' })
        eq(errs, 'count 上限 1000 截断', (clamp.result.text || '').split('\n').length, 1000)
        const noHy = rerun(inst, undefined, { type: 'uuidv4', count: 2, hyphens: false })
        ;(noHy.result.text || '').split('\n').forEach((id, i) => { if (!/^[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/.test(id)) errs.push(`去连字符第 ${i + 1} 个（版本位应在第 13 位、变体位第 17 位）：${id}`) })
        const emptyCh = rerun(inst, undefined, { type: 'custom', charset: '   ' })
        eq(errs, '空白字符集回落 alnum', /^[A-Za-z0-9]+$/.test((emptyCh.result.text || '').split('\n')[0]), true)
        return errs
      }
    }
  ],

  /* ============ FR-TXT-07 正则测试 ============ */
  'text-regex': [
    {
      name: '匹配：区间、分组与计数',
      text: '会议在 2026-10-13，回顾 2025-09-01 的记录',
      values: { pattern: '(\\d{4})-(\\d{2})-(\\d{2})', flags: 'g', mode: 'match', replacement: '$1/$2/$3' },
      expect: (d, h, inst) => {
        const errs = []
        const S = h.lib('packageText/utils/regex-safety.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '匹配文本拼接', d.result && d.result.text, '2026-10-13\n2025-09-01')
        eq(errs, '匹配数量', kv(d, '匹配数量'), '2')
        eq(errs, '分组数', kv(d, '分组数'), '3')
        eq(errs, '首匹配位置', d.matchRows[0].index, 4)
        eq(errs, '首匹配分组', d.matchRows[0].groupsText, '2026 / 10 / 13')
        eq(errs, '次匹配位置', d.matchRows[1].index, 18)
        eq(errs, '不命中返回空数组', S.safeMatchAll('\\d{9}', 'g', 'abc').matches.length, 0)
        eq(errs, '不命中 ok=true', S.safeMatchAll('\\d{9}', 'g', 'abc').ok, true)
        eq(errs, '非全局只返回首个', S.safeMatchAll('\\d+', '', 'a11b22').matches.map((m) => m.text).join(','), '11')
        eq(errs, '命名分组', S.safeMatchAll('(?<y>\\d{4})年', 'g', '2020年').matches[0].named.y, '2020')
        eq(errs, '空匹配不死循环（命中位置与 V8 一致）', S.safeMatchAll('x*', 'g', 'ab').matches.map((m) => m.index).join(','), '0,1,2')
        const nom = rerun(inst, { text: '没有数字' })
        if (nom.error) errs.push('不命中不该报错：' + JSON.stringify(nom.error))
        eq(errs, '不命中输出空串', nom.result.text, '')
        eq(errs, '不命中匹配数量', kv(nom, '匹配数量'), '0')
        eq(errs, '不命中 matchRows', nom.matchRows.length, 0)
        return errs
      }
    },
    {
      name: '替换：$1 / $<name> / $& / $$',
      knownDefect: 'regex-safety.js::buildReplacement 只认 $<name>，页面样例写法是 $name（pages/regex/index.js:41）',
      text: 'zhang@tools li@box',
      values: { pattern: '(\\w+)@(\\w+)', flags: 'g', mode: 'replace', replacement: '$2 的主号 $1' },
      expect: (d, h, inst) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '位置分组替换', d.result && d.result.text, 'tools 的主号 zhang box 的主号 li')
        const named = rerun(inst, { text: '2020年与2026年' }, { pattern: '(?<year>\\d{4})年', replacement: '[$<year>]' })
        eq(errs, '$<name> 命名分组替换', named.result && named.result.text, '[2020]与[2026]')
        // 页面 TIPS 只承诺 $<name>，但自带样例（SAMPLES[3]「命名分组」）写的是 [$year]。
        // renderTemplate 不认 $name → 样例点出来得到字面 [$year] —— 保留作复现。
        const sample = rerun(inst, { text: '2020年与2026年' }, { pattern: '(?<year>\\d{4})年', replacement: '[$year]' })
        eq(errs, '$name 短写法应与 $<name> 等价（页面样例写法）', sample.result && sample.result.text, '[2020]与[2026]')
        const whole = rerun(inst, { text: 'a1b2' }, { pattern: '\\d', replacement: '<$&>' })
        eq(errs, '$& 整体引用', whole.result && whole.result.text, 'a<1>b<2>')
        const dollar = rerun(inst, { text: 'x' }, { pattern: 'x', replacement: '$$100' })
        eq(errs, '$$ 转义', dollar.result && dollar.result.text, '$100')
        const missing = rerun(inst, { text: 'ac' }, { pattern: '(a)(b?)c', replacement: '$1|$2|[$3]' })
        eq(errs, '不存在分组留空', missing.result && missing.result.text, 'a||[]')
        const nog = rerun(inst, { text: 'a1a2' }, { pattern: 'a', replacement: 'b' })
        eq(errs, '无 g 也全局替换（页面补 g）', nog.result && nog.result.text, 'b1b2')
        return errs
      }
    },
    {
      name: '灾难性回溯：必须限时/拦截，不得卡死',
      text: 'aaaaaaaaaaaaaaaaaaaaaaaa!',
      values: { pattern: '(a+)+$', flags: '', mode: 'match', replacement: '' },
      noRun: true,
      allowTimeout: true,
      prepare: async (inst, h) => {
        const t0 = Date.now()
        inst.onRun()
        inst.setData({ __ms: Date.now() - t0 })
      },
      expect: (d, h, inst) => {
        const errs = []
        const S = h.lib('packageText/utils/regex-safety.js')
        if (!d.error) errs.push('(a+)+$ 配 24 个 a + ! 必须被拦住，实际 result=' + JSON.stringify(d.result))
        if (d.result) errs.push('被拦住时不应有 result')
        eq(errs, '页面 busy 已复位', d.busy, false)
        eq(errs, '拦截错误码', d.error && d.error.code, 'PARAM_INVALID')
        has(errs, '拦截文案说明风险', String(d.error && d.error.message), '灾难性回溯风险')
        if (!(inst.data.__ms < 1200)) errs.push('页面入口耗时 ' + inst.data.__ms + 'ms，超过 1.2s（视为卡死）')
        eq(errs, 'DEFAULT_TIMEOUT_MS', S.DEFAULT_TIMEOUT_MS, 1000)
        for (const p of ['(a+)+$', '(a|aa)+b', '.*.*$', '(\\d+)+$']) {
          const t1 = Date.now()
          const r = S.safeMatchAll(p, '', 'a'.repeat(24) + '!' + '1'.repeat(6))
          const ms = Date.now() - t1
          if (!r.interrupted) errs.push(`${p} 未被拦截（ok=${r.ok}）`)
          if (ms > 1200) errs.push(`${p} 用了 ${ms}ms 才返回，超时保护失效`)
        }
        eq(errs, '静态分析命中 (a+)+b', S.detectUnsafePattern('(a+)+b').unsafe, true)
        eq(errs, '静态分析命中 (a|aa)+', S.detectUnsafePattern('(a|aa)+b').unsafe, true)
        eq(errs, '静态分析命中 .*.*', S.detectUnsafePattern('.*.*$').unsafe, true)
        eq(errs, '正常手机号模板放行', S.detectUnsafePattern('^1[3-9]\\d{9}$').unsafe, false)
        eq(errs, '正常邮箱模板放行', S.detectUnsafePattern('[\\w.+-]+@[\\w-]+\\.[\\w.-]+').unsafe, false)
        const safe = S.safeMatchAll('(?<y>\\d{4})', 'g', 'a'.repeat(2000) + '2026')
        eq(errs, '安全表达式仍能命中', safe.matches.length, 1)
        return errs
      }
    },
    {
      name: '语法错误 / 空表达式 / 空文本 / 超长 / 截断',
      knownDefect: 'pages/regex/index.js:181-190 把命中数超上限映射成 TASK_TIMEOUT，应为成功+截断提示',
      text: 'abc',
      values: { pattern: '[', flags: 'g', mode: 'match', replacement: '' },
      expect: (d, h, inst) => {
        const errs = []
        expectError(errs, d, 'PARAM_INVALID', '正则表达式语法不合法', '未闭合字符类')
        const noPat = rerun(inst, undefined, { pattern: '' })
        if (!noPat.error || noPat.error.code !== 'INPUT_EMPTY') errs.push('空表达式应 INPUT_EMPTY：' + JSON.stringify(noPat.error))
        const noText = rerun(inst, { text: '' }, { pattern: 'a' })
        if (!noText.error || noText.error.code !== 'INPUT_EMPTY') errs.push('空文本应 INPUT_EMPTY：' + JSON.stringify(noText.error))
        const long = rerun(inst, { text: 'x'.repeat(1000001) })
        expectError(errs, long, 'PARAM_INVALID', '超过 1,000,000 字符', '超长样本文本')
        // 页面 TIPS：「单次最多返回 5000 条匹配，超出会标注截断」
        const cap = rerun(inst, { text: 'a'.repeat(6000) }, { pattern: 'a', replacement: '' })
        if (cap.error) errs.push('5000 条以上应返回截断结果而不是报错：' + JSON.stringify(cap.error))
        else eq(errs, '截断标注', kv(cap, '匹配数量'), '5000（截断）')
        eq(errs, 'MAX_MATCHES', h.lib('packageText/utils/regex-safety.js').MAX_MATCHES, 5000)
        const bad = rerun(inst, undefined, { pattern: '(a' })
        expectError(errs, bad, 'PARAM_INVALID', '语法不合法', '未闭合分组')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-08 字数统计 ============ */
  'text-stats': [
    {
      name: '中英混排：各项与人工核对一致',
      text: V.statsMixed,
      values: { topN: '0', longLine: true },
      expect: (d, h) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        // 手算：47 码点 = 33 ASCII + 14 个三字节（11 汉字 + ，。。）
        eq(errs, '字符数（码点）', kv(d, '字符数（含空白，码点）'), '47')
        eq(errs, '字符数（不含空白）', kv(d, '字符数（不含空白）'), '40')
        eq(errs, '空白字符', kv(d, '空白字符'), '7')
        eq(errs, '中文字数', kv(d, '中文字数'), '11')
        eq(errs, '英文单词数', kv(d, '英文单词数'), '6')
        eq(errs, '数字串数', kv(d, '数字串数'), '0')
        eq(errs, '标点符号', kv(d, '标点符号'), '5')
        eq(errs, '行数', kv(d, '行数'), '2')
        eq(errs, '段落数', kv(d, '段落数'), '1')
        eq(errs, 'UTF-8 字节数', kv(d, 'UTF-8 字节数'), '75')
        eq(errs, '最长行', kvp(d, '最长行'), '27 字符')
        eq(errs, 'countStats 全等', JSON.stringify(T.countStats(V.statsMixed)),
          JSON.stringify({ codepoints: 47, noWs: 40, whitespace: 7, chinese: 11, englishWords: 6, digitRuns: 0, punctuation: 5, utf8Bytes: 75, lines: 2, paragraphs: 1, emoji: 0 }))
        eq(errs, '报告首行', String(d.result.text).split('\n')[0], '字数统计报告')
        eq(errs, '不展示 GBK 字节数（无码表时不给近似值）', hasKv(d, 'GBK 字节数'), false)
        return errs
      }
    },
    {
      name: '代理对与 ZWJ 家族簇',
      text: V.statsEmoji,
      values: { topN: '0', longLine: true },
      expect: (d, h) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '字符数（码点）', kv(d, '字符数（含空白，码点）'), '28')
        eq(errs, '字符数（不含空白）', kv(d, '字符数（不含空白）'), '21')
        eq(errs, '中文字数', kv(d, '中文字数'), '8')
        eq(errs, '英文单词数', kv(d, '英文单词数'), '1')
        eq(errs, '数字串数', kv(d, '数字串数'), '1')
        eq(errs, '标点符号', kv(d, '标点符号'), '0')
        eq(errs, 'Emoji 簇', kv(d, 'Emoji（组合簇）'), '3')
        eq(errs, 'UTF-8 字节数', kv(d, 'UTF-8 字节数'), '63')
        eq(errs, '行数', kv(d, '行数'), '2')
        eq(errs, '代理对计 1 字符', T.countStats('🙂').codepoints, 1)
        eq(errs, '代理对 4 字节', T.countStats('🙂').utf8Bytes, 4)
        eq(errs, 'ZWJ 家族计 1 字符 5 码点外', JSON.stringify([T.countStats('👨‍👩‍👧').codepoints, T.countStats('👨‍👩‍👧').emoji]), '[5,1]')
        // TIPS 承诺「emoji 簇」计数簇感知：两面国旗应为 2 簇
        eq(errs, '两面旗计 2 簇', T.countStats('🇨🇳🇫🇷').emoji, 2)
        return errs
      }
    },
    {
      name: '高频词 TopN 与数字标点',
      text: 'hello hello hello world world 箱箱箱箱箱\nabc abc abc 箱',
      values: { topN: '5', longLine: true },
      expect: (d, h, inst) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '高频排序（按次数降序、同次按字典序）', d.top.map((t) => t.word + '(' + t.count + ')').join(','), '箱(6),abc(3),hello(3),world(2)')
        has(errs, '报告含高频行', d.result.text, '高频词/字：箱(6)、abc(3)、hello(3)、world(2)')
        // 手算：行1 35 码点 + 换行 1 + 行2 13 = 49；中文 5+1=6；英文词 3+2+3=8
        eq(errs, '码点数', kv(d, '字符数（含空白，码点）'), '49')
        eq(errs, '不含空白字符数', kv(d, '字符数（不含空白）'), '40')
        eq(errs, '中文字数', kv(d, '中文字数'), '6')
        eq(errs, '英文单词数', kv(d, '英文单词数'), '8')
        eq(errs, 'UTF-8 字节数', kv(d, 'UTF-8 字节数'), '61')
        const num = rerun(inst, { input: V.statsNum }, { topN: '0', longLine: false })
        const T = h.lib('packageText/utils/textops.js')
        eq(errs, '数字串 1,234.56 / 13 / 20 = 3', T.countStats(V.statsNum).digitRuns, 3)
        eq(errs, '标点（含中文标点）7', T.countStats(V.statsNum).punctuation, 7)
        eq(errs, '码点 30', T.countStats(V.statsNum).codepoints, 30)
        eq(errs, 'UTF-8 54', T.countStats(V.statsNum).utf8Bytes, 54)
        eq(errs, '中文字 8', T.countStats(V.statsNum).chinese, 8)
        eq(errs, '页面数字串数', kv(num, '数字串数'), '3')
        eq(errs, '页面标点', kv(num, '标点符号'), '7')
        eq(errs, 'longLine=false 不出最长行', hasKv(num, '最长行（第 1 行）'), false)
        return errs
      }
    },
    {
      name: '空输入 / 纯空白 / 超长',
      text: '',
      values: { topN: '0', longLine: false },
      expect: (d, h, inst) => {
        const errs = []
        if (!d.error || d.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY，实际 ' + JSON.stringify(d.error))
        const ws = rerun(inst, { input: '   ' })
        if (ws.error) errs.push('纯空白也应统计：' + JSON.stringify(ws.error))
        eq(errs, '纯空白字符数', kv(ws, '字符数（含空白，码点）'), '3')
        eq(errs, '纯空白非空白字数', kv(ws, '字符数（不含空白）'), '0')
        eq(errs, '纯空白段落数', kv(ws, '段落数'), '0')
        const over = rerun(inst, { input: 'x'.repeat(1000001) })
        eq(errs, '超长错误码', over.error && over.error.code, 'PARAM_INVALID')
        has(errs, '超长提示输入过长', String(over.error && over.error.message), '输入过长')
        const P = h.lib('packageText/pages/stats/index.js')
        eq(errs, '最长行取码点数', JSON.stringify(P.lineExtremes('ab\n你好呀\nx')), JSON.stringify({ count: 3, maxLen: 3, maxLineNo: 2, maxLine: '你好呀', avgLen: 2 }))
        eq(errs, '高频词忽略大小写', JSON.stringify(P.topWords('The the THE a', 2)), JSON.stringify([{ word: 'the', count: 3 }, { word: 'a', count: 1 }]))
        eq(errs, '超长行截断展示', P.lineExtremes('x'.repeat(50)).maxLine.length, 41)
        return errs
      }
    }
  ],

  /* ============ FR-TXT-09 文本对比 diff ============ */
  'text-diff': [
    {
      name: '改一行：分栏配对 + unified 补丁',
      input: { left: '第一行\n第二行\n第三行', right: '第一行\n第二行改了\n第三行' },
      values: { granularity: 'line', view: 'split', ignoreCase: false, ignoreWhitespace: false, contextLines: 3 },
      expect: (d, h) => {
        const errs = []
        const D = h.lib('packageText/utils/diff.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '新增', stat(d, '新增'), '0')
        eq(errs, '删除', stat(d, '删除'), '0')
        eq(errs, '修改', stat(d, '修改'), '1')
        eq(errs, '相同', stat(d, '相同'), '2')
        eq(errs, '相似度', stat(d, '相似度'), '66.7%') // 2*2/(3+3)
        eq(errs, '左/右项数', stat(d, '左/右项数'), '3 / 3')
        eq(errs, 'unified 补丁', d.result && d.result.text, '@@ -1,3 +1,3 @@\n 第一行\n-第二行\n+第二行改了\n 第三行')
        eq(errs, '行类型序列', d.diffOut.rows.map((r) => r.type).join(','), 'eq,mod,eq')
        eq(errs, 'mod 行号', d.diffOut.rows[1].lineA + '/' + d.diffOut.rows[1].lineB, '2/2')
        eq(errs, '纯新增（对照 diff 语义）', D.diffLines('A\nB\nC', 'A\nB\n新增1\n新增2\nC').unified,
          '@@ -1,3 +1,5 @@\n A\n B\n+新增1\n+新增2\n C')
        eq(errs, '全等无补丁', D.diffLines('same\nlines', 'same\nlines').unified, '')
        eq(errs, 'D_CAP/TOTAL_CAP', JSON.stringify([D.D_CAP, D.TOTAL_CAP]), JSON.stringify([600, 6000]))
        return errs
      }
    },
    {
      name: '含空行的纯删除',
      input: { left: '头部\n\n内容一\n内容二\n尾部', right: '头部\n尾部' },
      values: { granularity: 'line', view: 'unified', ignoreCase: false, ignoreWhitespace: false, contextLines: 3 },
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '删除', stat(d, '删除'), '3')
        eq(errs, '新增', stat(d, '新增'), '0')
        eq(errs, '相同', stat(d, '相同'), '2')
        eq(errs, '相似度', stat(d, '相似度'), '57.1%') // 2*2/(5+2)
        eq(errs, '补丁头', String(d.result.text).split('\n')[0], '@@ -1,5 +1,2 @@')
        eq(errs, '补丁体', d.result.text.split('\n').slice(1).join('\n'), ' 头部\n-\n-内容一\n-内容二\n 尾部')
        const D = h.lib('packageText/utils/diff.js')
        eq(errs, '全替换配对为修改', JSON.stringify(D.diffLines('x\ny', 'a\nb').stats), JSON.stringify({ add: 0, del: 0, mod: 2, eq: 0, similarity: 0 }))
        eq(errs, '超限退化为全删全增（标注 capped）', D.diffLines(Array(4001).fill('a').join('\n'), Array(2001).fill('b').join('\n')).capped, true)
        // 不变式：把编辑脚本应用到左侧必须得到右侧（60 组随机串）
        let bad = 0
        for (let i = 0; i < 60; i++) {
          const a = Array.from({ length: 1 + (i % 7) }, (_, k) => String.fromCharCode(97 + ((i * k) % 4)))
          const b = Array.from({ length: 1 + ((i * 3) % 6) }, (_, k) => String.fromCharCode(97 + ((i + k) % 4)))
          const ops = D.diffArrays(a, b)
          const out = []
          let p = 0
          for (const o of ops) { if (o.type === 'eq') { out.push(a[p]); p++ } else if (o.type === 'ins') out.push(o.text); else p++ }
          if (out.join('|') !== b.join('|')) bad++
        }
        if (bad) errs.push(`diff 编辑脚本应用后与右侧不等（${bad}/60 组失败）`)
        return errs
      }
    },
    {
      name: '词/字符粒度与忽略空白、大小写',
      input: { left: 'the quick brown fox', right: 'the slow red fox' },
      values: { granularity: 'word', view: 'split', ignoreCase: false, ignoreWhitespace: false, contextLines: 3 },
      expect: (d, h, inst) => {
        const errs = []
        const P = h.lib('packageText/pages/diff/index.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '词级 token（保留空白分隔）', P.tokenizeFor('the quick brown fox', 'word', false, false).join('|'), 'the| |quick| |brown| |fox')
        eq(errs, '词级忽略空白', P.tokenizeFor('a  b\tc', 'word', false, true).join('|'), 'a|b|c')
        eq(errs, '字符级码点', P.tokenizeFor('你好ab', 'char', false, false).join('|'), '你|好|a|b')
        eq(errs, '忽略大小写', P.tokenizeFor('AbC', 'char', true, false).join(''), 'abc')
        eq(errs, 'CRLF 归一', P.tokenizeFor('a\r\nb', 'line', false, false).join('|'), 'a|b')
        eq(errs, '词级修改数（词+空白整体配对）', stat(d, '修改'), '2')
        eq(errs, '词级相同项（含分隔空白）', stat(d, '相同'), '5')
        eq(errs, '词级左右项数', stat(d, '左/右项数'), '7 / 7')
        const cn = rerun(inst, { left: '你好，世界', right: '你好，宇宙' }, { granularity: 'char' })
        eq(errs, '字符级修改数', stat(cn, '修改'), '2')
        eq(errs, '字符级删除/新增', stat(cn, '删除') + '/' + stat(cn, '新增'), '0/0')
        eq(errs, '字符级相同', stat(cn, '相同'), '3')
        eq(errs, '字符级相似度', stat(cn, '相似度'), '60%') // 2*3/(5+5)
        const ig = rerun(inst, { left: 'Hello  World', right: 'hello world' }, { granularity: 'word', ignoreCase: true, ignoreWhitespace: true })
        eq(errs, '归一化后完全相同', stat(ig, '相似度'), '100%')
        has(errs, 'meta 提示归一化', ig.result.meta, '已按归一化文本比较与展示')
        const same = rerun(inst, { left: 'a\nb', right: 'a\nb' }, { granularity: 'line' })
        eq(errs, '全等时的出口文案', same.result.text, '（两段内容一致，无补丁输出）')
        return errs
      }
    },
    {
      name: '两侧皆空 / 单侧为空 / 超长',
      input: { left: '', right: '' },
      values: { granularity: 'line', view: 'split', ignoreCase: false, ignoreWhitespace: false, contextLines: 3 },
      expect: (d, h, inst) => {
        const errs = []
        if (!d.error || d.error.code !== 'INPUT_EMPTY') errs.push('两侧皆空应 INPUT_EMPTY，实际 ' + JSON.stringify(d.error))
        // C6 要求错误文案给出「唯一正确出口」：页面已组好左右侧提示，但被话术层丢弃
        has(errs, '文案指明两侧', String(d.error.message), '请输入左右两段要对比的文本')
        const one = rerun(inst, { left: '只有一侧', right: '' })
        if (!one.error || one.error.code !== 'INPUT_EMPTY') errs.push('单侧为空应 INPUT_EMPTY：' + JSON.stringify(one.error))
        has(errs, '文案指明右侧为空', String(one.error.message), '右侧文本为空')
        const other = rerun(inst, { left: '', right: '只有一侧' })
        has(errs, '文案指明左侧为空', String(other.error.message), '左侧文本为空')
        const over = rerun(inst, { left: 'x'.repeat(1000001), right: 'y' })
        expectError(errs, over, 'PARAM_INVALID', '超过 1,000,000 字符上限', '超长')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-10 命名风格转换 ============ */
  'text-naming': [
    {
      name: '混合边界单行：6 种风格同屏',
      text: 'user_nameHTTPCode',
      values: { from: 'auto', to: 'camel', showAll: true },
      expect: (d, h) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '目标风格结果', d.result && d.result.text, 'userNameHTTPCode')
        eq(errs, '拆词', d.tokensText, 'user · name · HTTP · Code')
        eq(errs, '风格猜测', d.detected, 'snake')
        eq(errs, '6 行风格', d.styleRows.map((r) => r.key).join(','), 'camel,pascal,snake,kebab,constant,title')
        eq(errs, '全风格值', d.styleRows.map((r) => r.value).join(' | '),
          'userNameHTTPCode | UserNameHTTPCode | user_name_http_code | user-name-http-code | USER_NAME_HTTP_CODE | User Name HTTP Code')
        eq(errs, '当前风格高亮', d.styleRows.filter((r) => r.active).map((r) => r.key).join(','), 'camel')
        eq(errs, '缩写不被拆坏', T.tokenize('HTTPRequestXMLParser').join(','), 'HTTP,Request,XML,Parser')
        eq(errs, '连续分隔符折叠', T.tokenize('a__--b').join(','), 'a,b')
        eq(errs, '首尾分隔符丢弃', T.tokenize('__a__').join(','), 'a')
        eq(errs, '空白输入 tokens 为空', T.tokenize('  ').length, 0)
        return errs
      }
    },
    {
      name: '多行批量 + 指定来源风格',
      knownDefect: 'textops.js:26-27 tokenize 无条件拆字母/数字，api_key_v2→api_key_v_2，违反 FR-TXT-10 幂等',
      text: 'get_user_id\nmax-size_kb\nHttpRetryCount',
      values: { from: 'auto', to: 'constant', showAll: true },
      expect: (d, h, inst) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '三行输出', d.result && d.result.text, 'GET_USER_ID\nMAX_SIZE_KB\nHTTP_RETRY_COUNT')
        has(errs, 'meta 行数', d.result.meta, '3 行')
        eq(errs, '多行不出风格表', d.styleRows.length, 0)
        const snake = rerun(inst, { input: 'order_detail_page_url' }, { from: 'snake', to: 'camel' })
        eq(errs, 'snake→camel', snake.result.text, 'orderDetailPageUrl')
        const strict = rerun(inst, { input: 'a_b-c' }, { from: 'snake', to: 'kebab' })
        eq(errs, '指定 snake 来源时不拆 -', strict.result.text, 'a-b-c')
        const pascal = rerun(inst, { input: 'HTTPRetryCount' }, { from: 'pascal', to: 'snake' })
        eq(errs, 'pascal 拆词', pascal.result.text, 'http_retry_count')
        const sent = rerun(inst, { input: 'the quick brown fox' }, { from: 'sentence', to: 'pascal' })
        eq(errs, 'sentence→pascal', sent.result.text, 'TheQuickBrownFox')
        const blank = rerun(inst, { input: 'get_user\n\nHttp Code' }, { from: 'auto', to: 'camel' })
        eq(errs, '空行原样保留行序', blank.result.text, 'getUser\n\nhttpCode')
        eq(errs, 'camel→snake 幂等', T.STYLES.snake(T.tokenize(T.STYLES.camel(T.tokenize('user_name_http_code')))), 'user_name_http_code')
        // FR-TXT-10 验收「往返转换幂等」：尾部数字标识（v2）被拆成 v + 2 后不再稳定
        eq(errs, 'snake→camel→snake 幂等（尾部数字）', T.STYLES.snake(T.tokenize(T.STYLES.camel(T.tokenize('api_key_v2')))), 'api_key_v2')
        return errs
      }
    },
    {
      name: 'namingAll 六风格与风格猜测',
      text: 'the quick brown fox',
      values: { from: 'auto', to: 'title', showAll: false },
      expect: (d, h) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        const P = h.lib('packageText/pages/naming/index.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, 'title 结果', d.result && d.result.text, 'The Quick Brown Fox')
        eq(errs, 'showAll=false 不出风格表', d.styleRows.length, 0)
        eq(errs, 'namingAll 六风格', T.namingAll('api_key_v2').styles.map((s) => s.label + '=' + s.value).join(' | '),
          'camelCase=apiKeyV2 | PascalCase=ApiKeyV2 | snake_case=api_key_v_2 | kebab-case=api-key-v-2 | CONSTANT_CASE=API_KEY_V_2 | Title Case=Api Key V 2')
        eq(errs, 'namingAll 空输入拒绝', JSON.stringify(T.namingAll('   ')), JSON.stringify({ ok: false, message: '请输入内容' }))
        eq(errs, 'detectStyle kebab', P.detectStyle('a-b'), 'kebab')
        eq(errs, 'detectStyle camel', P.detectStyle('aB'), 'camel')
        eq(errs, 'detectStyle constant', P.detectStyle('A_B'), 'constant')
        eq(errs, 'detectStyle sentence', P.detectStyle('two words'), 'sentence')
        eq(errs, 'detectStyle pascal', P.detectStyle('Abc'), 'pascal')
        eq(errs, 'splitFrom kebab', P.splitFrom('a-b-c', 'kebab').join(','), 'a,b,c')
        eq(errs, 'splitFrom constant', P.splitFrom('MAX_SIZE_KB', 'constant').join(','), 'MAX,SIZE,KB')
        return errs
      }
    },
    {
      name: '只含分隔符 / 纯空白 / 空输入 / 超长',
      text: '___',
      values: { from: 'auto', to: 'camel', showAll: true },
      expect: (d, h, inst) => {
        const errs = []
        if (d.error) errs.push('分隔符行应原样保留而不是整体失败：' + JSON.stringify(d.error))
        eq(errs, '原样输出', d.result && d.result.text, '___')
        has(errs, 'meta 提示无有效词', d.result.meta, '第 1 行无有效词已原样保留')
        const ws = rerun(inst, { input: '   ' })
        expectError(errs, ws, 'PARAM_INVALID', '未能从输入中提取到任何单词', '纯空白')
        const empty = rerun(inst, { input: '' })
        if (!empty.error || empty.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY：' + JSON.stringify(empty.error))
        const over = rerun(inst, { input: 'a'.repeat(1000001) })
        expectError(errs, over, 'PARAM_INVALID', '输入过长', '超长')
        const mixed = rerun(inst, { input: '___\nuser_name' })
        eq(errs, '部分行无词仍处理其余行', mixed.result.text, '___\nuserName')
        has(errs, 'meta 行号列表', mixed.result.meta, '第 1 行无有效词')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-11 大小写转换 ============ */
  'text-case': [
    {
      name: '全部大写：中文与 emoji 原样 + 各模式向量',
      text: 'hello 世界 🌍 World',
      values: { mode: 'upper', localeSafe: false, locale: 'en' },
      expect: (d, h) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '大写结果', d.result && d.result.text, 'HELLO 世界 🌍 WORLD')
        eq(errs, '输入/输出字符数', kv(d, '输入/输出字符数'), '16 / 16')
        eq(errs, '模式名', kv(d, '模式'), '全部大写')
        eq(errs, 'lower', T.CASE_MODES.lower.fn('ABC 世界'), 'abc 世界')
        eq(errs, 'capitalize 连字符边界', T.CASE_MODES.capitalize.fn('mixed-case-word'), 'Mixed-case-word')
        eq(errs, 'title', T.CASE_MODES.title.fn('the quick-brown fox jumped'), 'The Quick-Brown Fox Jumped')
        eq(errs, 'sentence', T.CASE_MODES.sentence.fn('hello world. THIS Is A Test. ok'), 'Hello world. This is a test. Ok')
        eq(errs, 'alternating', T.CASE_MODES.alternating.fn('hello world'), 'hElLo WoRlD')
        eq(errs, 'invert', T.CASE_MODES.invert.fn('AbC dEf 世界 🌍'), 'aBc DeF 世界 🌍')
        eq(errs, 'upper 不影响 emoji', T.CASE_MODES.upper.fn('🌍'), '🌍')
        eq(errs, 'capitalize 幂等', T.CASE_MODES.capitalize.fn(T.CASE_MODES.capitalize.fn('abc')), 'Abc')
        return errs
      }
    },
    {
      name: '本地安全：土耳其语 i → İ',
      text: 'istanbul INFO',
      values: { mode: 'upper', localeSafe: true, locale: 'tr' },
      expect: (d, h, inst) => {
        const errs = []
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, 'tr 大写', d.result && d.result.text, 'İSTANBUL INFO')
        eq(errs, 'İ 仍是一个码点', Array.from(d.result.text).length, 13)
        eq(errs, '模式标注', kv(d, '模式'), '全部大写（tr-TR）')
        eq(errs, 'i → ? 提示', kv(d, 'i → ?'), 'İ（土耳其语规则）')
        const en = rerun(inst, undefined, { locale: 'en' })
        eq(errs, 'en 大写', en.result.text, 'ISTANBUL INFO')
        eq(errs, 'en 模式标注', kv(en, '模式'), '全部大写（en-US）')
        const low = rerun(inst, { input: 'ISTANBUL' }, { locale: 'tr', mode: 'lower' })
        eq(errs, 'tr 小写 I → ı', low.result.text, 'ıstanbul')
        const off = rerun(inst, { input: 'istanbul' }, { localeSafe: false, mode: 'upper' })
        eq(errs, '关闭本地安全走默认', off.result.text, 'ISTANBUL')
        return errs
      }
    },
    {
      name: '繁简与全半角',
      text: '東門車站，時間觀點',
      values: { mode: 't2s', localeSafe: false, locale: 'en' },
      expect: (d, h, inst) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '繁→简', d.result && d.result.text, '东门车站，时间观点')
        eq(errs, '简→繁', T.CASE_MODES.s2t.fn('东门车站，时间观点'), '東門車站，時間觀點')
        eq(errs, '字典外字符原样', T.CASE_MODES.t2s.fn('台'), '台')
        eq(errs, '繁简往返覆盖常用字', T.CASE_MODES.t2s.fn(T.CASE_MODES.s2t.fn('东门车站时间观点')), '东门车站时间观点')
        eq(errs, '全角→半角', T.CASE_MODES.half.fn('１２３，ＡＢＣ　全角文本'), '123,ABC 全角文本')
        eq(errs, '半角→全角', T.CASE_MODES.full.fn('A1 x'), 'Ａ１　ｘ')
        eq(errs, '全半角往返', T.CASE_MODES.half.fn(T.CASE_MODES.full.fn('abc123')), 'abc123')
        const half = rerun(inst, { input: '１２３，ＡＢＣ　全角文本' }, { mode: 'half' })
        eq(errs, '页面 half 模式', half.result.text, '123,ABC 全角文本')
        eq(errs, '页面 half 模式名', kv(half, '模式'), '全角 → 半角')
        const full = rerun(inst, { input: 'abc123' }, { mode: 'full' })
        eq(errs, '页面 full 模式', full.result.text, 'ａｂｃ１２３')
        return errs
      }
    },
    {
      name: '未知模式 / 空输入 / 纯空白 / 超长',
      text: 'abc',
      values: { mode: 'nope', localeSafe: false, locale: 'en' },
      expect: (d, h, inst) => {
        const errs = []
        expectError(errs, d, 'PARAM_INVALID', '未知的转换模式 "nope"', '未知模式')
        eq(errs, 'applyCase 抛错带 code', (() => {
          try { h.lib('packageText/pages/case/index.js').applyCase('a', 'zzz'); return 'no-throw' } catch (e) { return e.code + ':' + e.message }
        })(), 'PARAM_INVALID:参数错误：未知的转换模式 "zzz"')
        const empty = rerun(inst, { input: '' })
        if (!empty.error || empty.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY：' + JSON.stringify(empty.error))
        const ws = rerun(inst, { input: '   ' }, { mode: 'upper' })
        if (ws.error) errs.push('纯空白也应输出：' + JSON.stringify(ws.error))
        eq(errs, '空白保持', ws.result.text, '   ')
        const zh = rerun(inst, { input: '日常工具箱' }, { mode: 'upper' })
        eq(errs, '中文不受大小写影响', zh.result.text, '日常工具箱')
        const over = rerun(inst, { input: 'x'.repeat(1000001) })
        has(errs, '超长提示输入过长', String(over.error && over.error.message), '输入过长')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-12 多行文本处理 ============ */
  'text-multiline': [
    {
      name: '去空白/去空行/去重/升序/编号',
      text: 'b\na\n  a \nc\n\nb',
      values: { chain: [{ id: 'trim', arg: '' }, { id: 'nonempty', arg: '' }, { id: 'dedup', arg: '' }, { id: 'sortAsc', arg: '' }, { id: 'number', arg: '10,2' }] },
      expect: (d, h) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '输出', d.result && d.result.text, '10. a\n12. b\n14. c')
        eq(errs, '操作链可视', kv(d, '操作链'), '去首尾空白 → 去空行 → 去重（保留首次） → 升序排序 → 添加行号')
        eq(errs, '行数变化', kv(d, '行数变化'), '6 → 3')
        eq(errs, '无备注', (d.kv || []).filter((r) => /^备注/.test(r.key)).length, 0)
        eq(errs, '去重保留首次顺序', T.applyChain('c\nb\nc\nb', [{ id: 'dedup' }]).output, 'c\nb')
        eq(errs, '降序', T.applyChain('a\nc\nb', [{ id: 'sortDesc' }]).output, 'c\nb\na')
        eq(errs, '按行长', T.applyChain('aaa\nb\ncc', [{ id: 'sortLen' }]).output, 'b\ncc\naaa')
        eq(errs, '自然数字排序', T.applyChain('a10\na2\na1', [{ id: 'sortNat' }]).output, 'a1\na2\na10')
        eq(errs, '行序反转', T.applyChain('1\n2\n3', [{ id: 'reverse' }]).output, '3\n2\n1')
        eq(errs, 'naturalCompare', [T.naturalCompare('f2', 'f10'), T.naturalCompare('f1', 'f1'), T.naturalCompare('b', 'a')].join(','), '-1,0,1')
        eq(errs, '行号步长', T.applyChain('p\nq', [{ id: 'number', arg: '100,50' }]).output, '100. p\n150. q')
        return errs
      }
    },
    {
      name: '截取 + 合并 + 查找替换',
      text: '第1行\n第2行\n第3行\n第4行\n第5行',
      values: { chain: [{ id: 'nonempty', arg: '' }, { id: 'slice', arg: '2,4' }, { id: 'join', arg: ', ' }] },
      expect: (d, h, inst) => {
        const errs = []
        const T = h.lib('packageText/utils/textops.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '输出', d.result && d.result.text, '第2行, 第3行, 第4行')
        eq(errs, '行数变化', kv(d, '行数变化'), '5 → 1')
        eq(errs, '操作链', kv(d, '操作链'), '去空行 → 截取行 → 合并为一行')
        eq(errs, '正则替换 + 后缀', T.applyChain('Hello World ToolBox', [{ id: 'replaceRe', arg: '\\s+=>_' }, { id: 'suffix', arg: '!' }]).output, 'Hello_World_ToolBox!')
        eq(errs, '字面替换全部命中 + 前缀', T.applyChain('foo is good\nnot foo', [{ id: 'replace', arg: 'foo=>bar' }, { id: 'prefix', arg: '- ' }]).output, '- bar is good\n- not bar')
        eq(errs, '合并空格 + 按长度断行', T.applyChain('a b  c', [{ id: 'mergeWs' }, { id: 'split', arg: '2' }]).output, 'a \nb \nc')
        eq(errs, '默认分隔符逗号', T.applyChain('x\ny', [{ id: 'nonempty' }, { id: 'join', arg: '' }]).output, 'x,y')
        eq(errs, '行号默认 1,1', T.applyChain('p\nq', [{ id: 'number', arg: '' }]).output, '1. p\n2. q')
        eq(errs, '截取越界收敛', T.applyChain('a\nb', [{ id: 'slice', arg: '1,99' }]).output, 'a\nb')
        eq(errs, 'CRLF 归一', T.applyChain('a\r\nb', [{ id: 'trim' }]).output, 'a\nb')
        const bad = rerun(inst, { input: 'a _ b' }, { chain: [{ id: 'replaceRe', arg: '\\s+_=>_' }] })
        eq(errs, '页面正则替换（正则=>替换 分段取首个 =>）', bad.result && bad.result.text, 'a_ b')
        eq(errs, '正则替换无需备注', (bad.kv || []).filter((r) => /^备注/.test(r.key)).length, 0)
        return errs
      }
    },
    {
      name: '随机打乱保持多重集 + 单步错误不中断链',
      text: 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8',
      values: { chain: [{ id: 'slice', arg: '3,1' }, { id: 'split', arg: '0' }, { id: 'shuffle', arg: '' }, { id: 'sortAsc', arg: '' }] },
      expect: (d, h) => {
        const errs = []
        if (d.error) errs.push('单步参数错误不应整体失败：' + JSON.stringify(d.error))
        eq(errs, '备注 1', kv(d, '备注 1'), '截取行：结束行小于起始行')
        eq(errs, '备注 2', kv(d, '备注 2'), '按长度断行：每段字符数需在 1 以上')
        eq(errs, '坏步骤后仍继续排序', d.result && d.result.text, 'L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8')
        eq(errs, '打乱随机源标注', kv(d, '打乱随机源'), '混合种子')
        eq(errs, '操作链含全部步骤', kv(d, '操作链'), '截取行 → 按长度断行 → 随机打乱 → 升序排序')
        const T = h.lib('packageText/utils/textops.js')
        const shuf = T.applyChain('L1\nL2\nL3\nL4\nL5\nL6\nL7\nL8', [{ id: 'shuffle' }]).output.split('\n').sort().join(',')
        eq(errs, '打乱保持多重集', shuf, 'L1,L2,L3,L4,L5,L6,L7,L8')
        eq(errs, '每段字符数过大拒绝', T.applyChain('abc', [{ id: 'split', arg: '200000' }]).notes.join(';'), '按长度断行：每段字符数过大')
        return errs
      }
    },
    {
      name: '空输入 / 空操作链 / 非法正则 / 未知操作',
      text: '',
      values: { chain: [] },
      expect: (d, h, inst) => {
        const errs = []
        if (!d.error || d.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY，实际 ' + JSON.stringify(d.error))
        const noChain = rerun(inst, { input: 'a\nb' })
        expectError(errs, noChain, 'PARAM_INVALID', '请先从下方操作清单添加至少一个操作', '空操作链')
        const badRe = rerun(inst, undefined, { chain: [{ id: 'replaceRe', arg: '(=>x' }] })
        eq(errs, '非法正则降级为备注', kv(badRe, '备注 1'), '查找替换（正则）：正则语法不合法')
        const emptyFind = rerun(inst, undefined, { chain: [{ id: 'replace', arg: '=>x' }] })
        eq(errs, '空查找降级为备注', kv(emptyFind, '备注 1'), '查找替换（字面量）：查找内容不能为空')
        eq(errs, '备注后原样输出', emptyFind.result.text, 'a\nb')
        const unknown = rerun(inst, undefined, { chain: [{ id: 'noSuchOp' }] })
        eq(errs, '未知操作被忽略', kv(unknown, '操作链'), '（未选择操作）')
        eq(errs, '未知操作不影响行数', kv(unknown, '行数变化'), '2 → 2')
        const over = rerun(inst, { input: 'x'.repeat(1000001) })
        has(errs, '超长提示输入过长', String(over.error && over.error.message), '输入过长')
        return errs
      }
    }
  ],

  /* ============ FR-TXT-13 进制转换 ============ */
  'text-radix': [
    {
      name: '0xff：四进制同屏 + 32 位补码 + 位与',
      text: 'ff',
      values: { base: '16', baseCustom: '36', width: '32', signed: false, bitOp: 'and', bitB: 'f0' },
      expect: (d, h) => {
        const errs = []
        const N = h.lib('packageText/utils/numsys.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '十进制', conv(d, '十进制'), '255')
        eq(errs, '八进制', conv(d, '八进制'), '377')
        eq(errs, '十六进制', conv(d, '十六进制'), 'ff')
        eq(errs, '二进制（分组）', conv(d, '二进制（分组）'), '1111 1111')
        eq(errs, '32 位补码二进制', conv(d, '32 位补码 · 二进制'), '0000 0000 0000 0000 0000 0000 1111 1111')
        eq(errs, '32 位补码十六进制', conv(d, '32 位补码 · 十六进制'), '000000ff')
        eq(errs, '解释方式', conv(d, '解释方式'), '无符号 / 原值')
        eq(errs, 'AND 有符号', bit(d, '结果 · 有符号'), '240')
        eq(errs, 'AND 无符号', bit(d, '结果 · 无符号'), '240')
        eq(errs, 'AND 十六进制', bit(d, '结果 · 十六进制'), 'f0')
        eq(errs, 'AND 二进制', bit(d, '结果 · 二进制（分组）'), '1111 0000')
        eq(errs, '位运算无备注', d.bitNote, '')
        has(errs, '结果文本含十六进制', d.result.text, '十六进制: ff')
        eq(errs, '八进制 777 → 511', N.convert('777', 8).decimal, '511')
        eq(errs, '二进制 1010 → 10', N.convert('1010', 2).decimal, '10')
        eq(errs, '36 进制 zz → 1295', N.convert('zz', 36).decimal, '1295')
        eq(errs, '下划线分组', N.convert('10_000', 10).decimal, '10000')
        eq(errs, '空格分组', N.convert('1 0 0', 10).decimal, '100')
        eq(errs, '零三列', JSON.stringify([N.convert('0', 10).decimal, N.convert('0', 10).hex, N.convert('0', 10).binary]), '["0","0","0"]')
        eq(errs, '自定义 7 进制', N.convert('10', 7).decimal, '7')
        eq(errs, '大写输入', N.convert('FF', 16).decimal, '255')
        return errs
      }
    },
    {
      name: '负数与补码回折 + 位运算家族',
      text: 'ffffffff',
      values: { base: '16', baseCustom: '36', width: '32', signed: true, bitOp: 'not', bitB: '' },
      expect: (d, h, inst) => {
        const errs = []
        const N = h.lib('packageText/utils/numsys.js')
        const P = h.lib('packageText/pages/radix/index.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '有符号折回十进制', conv(d, '十进制'), '-1')
        eq(errs, '32 位补码十六进制', conv(d, '32 位补码 · 十六进制'), 'ffffffff')
        eq(errs, '32 位补码二进制', conv(d, '32 位补码 · 二进制'), '1111 1111 1111 1111 1111 1111 1111 1111')
        eq(errs, '解释方式', conv(d, '解释方式'), '有符号（超 2^31−1 折回负数）')
        eq(errs, 'NOT(0xffffffff) 32 位 = 0', bit(d, '结果 · 有符号'), '0')
        eq(errs, 'NOT 无符号', bit(d, '结果 · 无符号'), '0')
        eq(errs, '-1 的 32 位补码', N.convert('-1', 10).twos32Hex, 'ffffffff')
        eq(errs, '-1 的 64 位补码', N.convert('-1', 10).twos64Hex, 'ffffffffffffffff')
        eq(errs, '-2147483648 边界', N.convert('-2147483648', 10).twos32Hex, '80000000')
        eq(errs, '4294967295 有符号解释', N.convert('4294967295', 10).w32.signed, '-1')
        eq(errs, 'signed 折回助手', String(P.effectiveValue(N.convert('ffffffff', 16), '32', true)), '-1')
        eq(errs, 'signed=false 不折回', String(P.effectiveValue(N.convert('80000000', 16), '32', false)), '2147483648')
        eq(errs, '2^31 折回', String(P.effectiveValue(N.convert('80000000', 16), '32', true)), '-2147483648')
        const shr = rerun(inst, { input: '-8' }, { base: '10', bitOp: 'shrArith', bitB: '1' })
        eq(errs, '算术右移 -8>>1', bit(shr, '结果 · 有符号'), '-4')
        eq(errs, '算术右移无符号视图', bit(shr, '结果 · 无符号'), '4294967292')
        const logic = rerun(inst, undefined, { bitOp: 'shrLogic' })
        eq(errs, '逻辑右移 -8>>>1', bit(logic, '结果 · 有符号'), '2147483644')
        eq(errs, '逻辑右移十六进制', bit(logic, '结果 · 十六进制'), '7ffffffc')
        const or = rerun(inst, { input: '2a' }, { base: '16', bitOp: 'or', bitB: 'f0' })
        eq(errs, 'OR 2a|f0 = fa', bit(or, '结果 · 十六进制'), 'fa')
        const xor = rerun(inst, undefined, { bitOp: 'xor' })
        eq(errs, 'XOR 2a^f0 = da', bit(xor, '结果 · 十六进制'), 'da')
        const shl = rerun(inst, { input: '1' }, { base: '10', bitOp: 'shl', bitB: '3' })
        eq(errs, '左移 1<<3', bit(shl, '结果 · 有符号'), '8')
        eq(errs, '左移十六进制', bit(shl, '结果 · 十六进制'), '8')
        return errs
      }
    },
    {
      name: '2^63-1 / 超 64 位提示 / 64 位 NOT',
      text: '9223372036854775807',
      values: { base: '10', baseCustom: '36', width: '64', signed: false, bitOp: 'not', bitB: '' },
      expect: (d, h, inst) => {
        const errs = []
        const N = h.lib('packageText/utils/numsys.js')
        if (d.error) errs.push('不应报错：' + JSON.stringify(d.error))
        eq(errs, '2^63-1 十六进制', conv(d, '十六进制'), '7fffffffffffffff')
        eq(errs, '2^63-1 八进制', conv(d, '八进制'), '777777777777777777777')
        eq(errs, '64 位补码十六进制', conv(d, '64 位补码 · 十六进制'), '7fffffffffffffff')
        eq(errs, '32 位越界提示', conv(d, '32 位提示'), '数值超出 32 位范围，仅 64 位列有效')
        eq(errs, '64 位 NOT → -2^63', bit(d, '结果 · 有符号'), '-9223372036854775808')
        eq(errs, '64 位 NOT 无符号', bit(d, '结果 · 无符号'), '9223372036854775808')
        eq(errs, '64 位 NOT 十六进制', bit(d, '结果 · 十六进制'), '8000000000000000')
        // TIPS/spec：二进制按 4 位分组便于读数 —— 分组必须从低位（右侧）对齐
        eq(errs, '511 二进制分组（低位对齐）', N.convert('511', 10).binGrouped, '1 1111 1111')
        eq(errs, '2^63-1 二进制分组（低位对齐）', N.convert('9223372036854775807', 10).binGrouped,
          '111 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111 1111')
        const over = rerun(inst, { input: '99999999999999999999999' })
        eq(errs, '超 64 位提示', conv(over, '64 位提示'), '数值超出 64 位范围，补码列不显示（无静默溢出）')
        eq(errs, '超 64 位补码列明确越界', conv(over, '64 位补码 · 十六进制'), '超出该位宽范围')
        has(errs, 'meta 标注超 64 位', over.result.meta, '· 超 64 位')
        eq(errs, 'BigInt 无精度损失', conv(over, '十进制'), '99999999999999999999999')
        eq(errs, '超 64 位十六进制仍精确', conv(over, '十六进制'), '152d02c7e14af67fffff')
        return errs
      }
    },
    {
      name: '非法字符 / 非法进制 / 空输入 / 超长',
      text: 'g',
      values: { base: '16', baseCustom: '36', width: '32', signed: false, bitOp: 'and', bitB: '' },
      expect: (d, h, inst) => {
        const errs = []
        const N = h.lib('packageText/utils/numsys.js')
        // 页面把 numsys 的「参数错误」映射成 UNSUPPORTED_FORMAT
        expectError(errs, d, 'UNSUPPORTED_FORMAT', '含非法字符 "g"（第 1 个字符，16 进制）', '16 进制里的 g')
        eq(errs, '非法字符定位第 2 位', N.convert('1g', 16).message.indexOf('第 2 个字符') > 0, true)
        eq(errs, '只有符号位报错', N.convert('-', 10).message, '参数错误：仅有符号位，缺少数字')
        eq(errs, '进制越界', N.parseIntBase('10', 37).message, '参数错误：进制需在 2–36 之间')
        eq(errs, '进制下界', N.parseIntBase('10', 1).message, '参数错误：进制需在 2–36 之间')
        eq(errs, '空值', N.parseIntBase('', 10).message, '请输入内容')
        eq(errs, '未知位运算', N.bitOp('1', 10, '1', 'nand', 32).message, '参数错误：未知位运算 "nand"')
        eq(errs, '二进制里出现 2', N.convert('2', 2).message.indexOf('含非法字符 "2"') > 0, true)
        const base37 = rerun(inst, undefined, { base: 'custom', baseCustom: '37' })
        expectError(errs, base37, 'PARAM_INVALID', '自定义进制需在 2–36 之间', '自定义进制 37')
        const bitBad = rerun(inst, { input: '10' }, { base: '10', bitOp: 'and', bitB: 'zz' })
        has(errs, '位运算 B 非法只备注不崩', String(bitBad.bitNote), '位运算未执行')
        eq(errs, '位运算失败时转换主结果仍可用', conv(bitBad, '十进制'), '10')
        const empty = rerun(inst, { input: '' })
        if (!empty.error || empty.error.code !== 'INPUT_EMPTY') errs.push('空输入应 INPUT_EMPTY，实际 ' + JSON.stringify(empty.error))
        const over = rerun(inst, { input: '9'.repeat(513) })
        expectError(errs, over, 'PARAM_INVALID', '超过 512 字符', '超长数值')
        return errs
      }
    }
  ]
}
