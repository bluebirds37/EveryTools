/* 开发者工具用例：与 Node 内置实现/规范定义交叉核对的精确向量。 */
const crypto = require('crypto')

function hay(d) {
  return [d.result, d.kv, d.rows, d.out, d.text, d.segments, d.parsed, d.info].map((x) => (x == null ? '' : JSON.stringify(x))).join('|')
}
const has = (d, s) => hay(d).indexOf(s) >= 0

/* 一个用 Node crypto 真实签好的 HS256 token（密钥 secret），签名串是固定已知值 */
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
const HDR = b64u({ alg: 'HS256', typ: 'JWT' })
const PAY = b64u({ sub: '1', 日常: '工具箱', exp: 1893456000 })
const SIG = crypto.createHmac('sha256', 'secret').update(HDR + '.' + PAY).digest('base64url')
const JWT = HDR + '.' + PAY + '.' + SIG

module.exports = {
  'dev-jwt': [
    {
      name: '解出头部/载荷/签名（签名与 Node HMAC 一致）',
      values: { token: JWT, prettify: true, showAllClaims: true },
      expect: (d, h) => {
        const errs = []
        const j = h.lib('packageDev/utils/jwt.js')
        const r = j.parseJwt(JWT)
        if (!r || !r.ok) return ['parseJwt 失败：' + JSON.stringify(r)]
        if (r.header.alg !== 'HS256') errs.push('alg 解析错误：' + r.header.alg)
        if (r.payload['日常'] !== '工具箱') errs.push('中文载荷丢失：' + JSON.stringify(r.payload))
        if (r.signature !== SIG) errs.push('签名段应与 HMAC-SHA256(secret) 一致')
        if (!has(d, 'HS256')) errs.push('页面没渲染出 alg：' + hay(d).slice(0, 160))
        if (!has(d, '工具箱')) errs.push('页面没渲染中文载荷')
        if (!has(d, '2030')) errs.push('exp=1893456000 应可读成 2030 年时间：' + hay(d).slice(0, 200))
        return errs
      }
    },
    {
      name: '段数不足必须报错',
      values: { token: 'abc.def', prettify: true, showAllClaims: false },
      expect: (d) => (d.error ? [] : ['两段式字符串不是 JWT，页面必须报错'])
    },
    {
      name: '多余空白与引号包裹的 token 能清洗',
      values: { token: '  ' + JWT + '  ', prettify: true, showAllClaims: true },
      expect: (d, h) => {
        const errs = []
        const j = h.lib('packageDev/utils/jwt.js')
        const cleaned = j.cleanToken('  ' + JWT + '  ')
        if (String(cleaned).trim() !== JWT) errs.push('cleanToken 没去掉首尾空白：' + JSON.stringify(cleaned))
        const quoted = j.cleanToken('"' + JWT + '"')
        if (String(quoted).replace(/"/g, '') !== JWT) errs.push('cleanToken 未处理引号包裹：' + JSON.stringify(quoted))
        if (d.error) errs.push('带空白的合法 token 却报错：' + JSON.stringify(d.error))
        return errs
      }
    }
  ],

  'dev-cron': [
    {
      name: '5 段 MON-FRI 跳过周末（unix 语义 0=周日）',
      values: { expr: '30 9 * * MON-FRI', zone: 'local', count: 3 },
      expect: (d, h) => {
        const errs = []
        const c = h.lib('packageDev/utils/cron.js')
        const runs = c.next('30 9 * * MON-FRI', new Date(2026, 9, 15, 0, 0, 0), 3)
        if (runs.length !== 3) return ['应返回 3 次，实际 ' + runs.length]
        const wd = runs.map((x) => x.getDay())
        if (wd.some((w) => w === 0 || w === 6)) errs.push('MON-FRI 却排到了周末：' + runs.map((x) => (x.getMonth() + 1) + '/' + x.getDate() + ' 周' + x.getDay()).join(','))
        // 10/15 周四、10/16 周五、下一个应为 10/19 周一
        const days = runs.map((x) => x.getDate())
        if (days.join(',') !== '15,16,19') errs.push('触发日期应为 15,16,19（跳过 17/18 周末），实际 ' + days.join(','))
        if (runs.some((x) => x.getHours() !== 9 || x.getMinutes() !== 30)) errs.push('时分不匹配：' + runs.map((x) => x.getHours() + ':' + x.getMinutes()).join(','))
        const res = c.nextRuns('30 9 * * MON-FRI', { zone: c.fixedZone(480, 'UTC+08:00'), fromMs: new Date(2026, 9, 15).getTime(), count: 2 })
        if (!res || !res.runs || res.runs.length !== 2) return ['nextRuns 返回形状不对：' + JSON.stringify(res).slice(0, 120)]
        if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(res.runs[0].text)) errs.push('nextRuns 的 text 应为墙上时间格式：' + res.runs[0].text)
        if (!/星期/.test(res.runs[0].weekday)) errs.push('weekday 字段缺失：' + JSON.stringify(res.runs[0]))
        const rows = c.fieldRows('30 9 * * MON-FRI')
        if (rows.length !== 5) errs.push('5 段表达式应展开 5 行字段说明，实际 ' + rows.length)
        if (!rows.every((r) => r.label && r.meaning)) errs.push('字段说明有空列：' + JSON.stringify(rows).slice(0, 160))
        if (!/星期/.test(String(c.summarize('30 9 * * MON-FRI')))) errs.push('summarize 未描述星期：' + c.summarize('30 9 * * MON-FRI'))
        return errs
      }
    },
    {
      name: '永不命中的表达式给提示而不是空转',
      values: { expr: '0 0 30 2 *', zone: 'local', count: 3 },
      expect: (d, h) => {
        const c = h.lib('packageDev/utils/cron.js')
        const res = c.nextRuns('0 0 30 2 *', { fromMs: Date.now(), count: 3 })
        if (res.runs.length) return ['2 月 30 日不可能命中，却返回了 ' + res.runs.length + ' 次']
        if (!/没有命中/.test(String(res.note))) return ['必须说明「6 年内没有命中」，实际 note=' + JSON.stringify(res.note)]
        return []
      }
    },
    {
      name: '非法表达式给可读错误而不是崩溃',
      values: { expr: '99 99 * * *', zone: 'local', count: 3 },
      expect: (d, h) => {
        const errs = []
        const c = h.lib('packageDev/utils/cron.js')
        let threw = null
        try {
          c.parse('99 99 * * *')
        } catch (e) {
          threw = e
        }
        if (!threw) errs.push('cron.parse 对 99 位段应抛错')
        if (!d.error) errs.push('页面没有把非法表达式提示出来（cron.parse 会 throw，页面必须接住）')
        return errs
      }
    },
    {
      name: '描述文案与预设',
      values: { expr: '*/15 * * * *', zone: 'local', count: 2 },
      expect: (d, h) => {
        const c = h.lib('packageDev/utils/cron.js')
        const txt = c.describe('*/15 * * * *')
        if (!/15/.test(String(txt))) return ['describe 未体现 15 分钟间隔：' + txt]
        if (!c.PRESETS || !Object.keys(c.PRESETS).length) return ['缺少常用预设']
        return []
      }
    }
  ],

  'dev-sql': [
    {
      name: '格式化大小写与换行',
      values: { sql: 'select a,b from t where x=1 and y=2 order by a', mode: 'format', keywordCase: 'upper', indent: 2 },
      expect: (d, h) => {
        const errs = []
        const s = h.lib('packageDev/utils/sql.js')
        const out = s.format('select a,b from t where x=1 and y=2 order by a')
        const want = 'SELECT a,\n  b\nFROM t\nWHERE x = 1\n  AND y = 2\nORDER BY a'
        if (out.text !== want) errs.push('格式化结果与预期不一致：\n' + JSON.stringify(out.text))
        const st = s.stats('select a,b from t where x=1')
        if (st.tables.join(',') !== 't' || !st.hasWhere) errs.push('stats 解析不对：' + JSON.stringify(st))
        if (!has(d, 'SELECT')) errs.push('页面没有渲染格式化后的 SQL：' + hay(d).slice(0, 160))
        return errs
      }
    },
    {
      name: '危险语句必须标出',
      values: { sql: 'DROP TABLE users', mode: 'format', keywordCase: 'upper', indent: 2 },
      expect: (d, h) => {
        const s = h.lib('packageDev/utils/sql.js')
        const st = s.stats('DROP TABLE users')
        if (!st.dangerous) return ['DROP TABLE 未被标记为危险语句：' + JSON.stringify(st)]
        return []
      }
    },
    {
      name: '空 SQL 报错',
      values: { sql: '', mode: 'format', keywordCase: 'upper', indent: 2 },
      expect: (d) => (d.error ? [] : ['空 SQL 应给 INPUT_EMPTY 类提示'])
    }
  ],

  'dev-color': [
    {
      name: 'HEX→RGB/HSL 与 WCAG 对比度',
      values: { mode: 'convert', color: '#3B5BFE', base2: '#FFFFFF', steps: 4, hexAlpha: false },
      expect: (d, h) => {
        const errs = []
        const c = h.lib('packageDev/utils/color.js')
        const rgb = c.parseColor('#3B5BFE')
        if (rgb.r !== 59 || rgb.g !== 91 || rgb.b !== 254) errs.push('HEX→RGB 错误：' + JSON.stringify(rgb))
        const hsl = c.rgbToHsl(rgb)
        // 手算：max=b,min=r → h=((r-g)/d+4)*60≈230.2°，s≈0.990，l≈0.614
        if (Math.abs(hsl.h - 230.2) > 0.6) errs.push(`H 应约 230.2°，实际 ${hsl.h}`)
        if (Math.abs(hsl.s - 99) > 2) errs.push('S 应约 99（百分制），实际 ' + hsl.s)
        if (Math.abs(hsl.l - 61.4) > 2) errs.push('L 应约 61.4（百分制），实际 ' + hsl.l)
        const ratio = c.contrast('#3B5BFE', '#FFFFFF')
        if (Math.abs(ratio - 5.09) > 0.15) errs.push('对比度应约 5.09（WCAG 公式手算），实际 ' + ratio)
        const w = c.wcag(ratio)
        if (!w.aaNormal || w.aaaNormal) errs.push('5.09:1 应判 AA 通过、AAA 不通过：' + JSON.stringify(w))
        if (!has(d, '59') || !has(d, '91')) errs.push('页面没渲染 RGB：' + hay(d).slice(0, 160))
        return errs
      }
    },
    {
      name: '非法色值与 rgba 解析',
      values: { mode: 'convert', color: 'not-a-color', base2: '#FFFFFF', steps: 4, hexAlpha: false },
      expect: (d, h) => {
        const errs = []
        const c = h.lib('packageDev/utils/color.js')
        if (c.parseColor('not-a-color')) errs.push('非法色值不应返回对象')
        const rgba = c.parseColor('rgba(10, 20, 30, 0.5)')
        if (!rgba || rgba.a !== 0.5 || rgba.r !== 10) errs.push('rgba 解析不对：' + JSON.stringify(rgba))
        if (!d.error) errs.push('页面没有对非法色值给出提示')
        return errs
      }
    }
  ],

  'dev-ua': [
    {
      name: 'iOS 微信内置浏览器解析',
      values: {
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44(0x18002c31)',
        showRaw: true
      },
      expect: (d, h) => {
        const errs = []
        const u = h.lib('packageDev/utils/ua.js')
        const r = u.parseUA('Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.44(0x18002c31)')
        if (!r.ok) return ['parseUA 失败']
        if (r.browser.name !== '微信内置浏览器' || r.browser.version !== '8.0.44') errs.push('浏览器识别错：' + JSON.stringify(r.browser))
        if (r.os.name !== 'iOS' || r.os.version !== '17.2') errs.push('系统识别错：' + JSON.stringify(r.os))
        if (r.device.type !== 'mobile') errs.push('设备类型错：' + JSON.stringify(r.device))
        if (!has(d, '8.0.44')) errs.push('页面没渲染版本号：' + hay(d).slice(0, 160))
        return errs
      }
    },
    {
      name: '桌面 Chrome 与爬虫',
      values: { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36', showRaw: false },
      expect: (d, h) => {
        const u = h.lib('packageDev/utils/ua.js')
        const desk = u.parseUA('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36')
        const errs = []
        if (desk.browser.name.toLowerCase().indexOf('chrome') < 0) errs.push('Chrome 未识别：' + JSON.stringify(desk.browser))
        if (desk.device.type === 'mobile') errs.push('桌面被误判为移动端')
        const bot = u.parseUA('Googlebot/2.1 (+http://www.google.com/bot.html)')
        if (bot.device.type !== 'robot') errs.push('Googlebot 的 device.type 应为 robot，实际 ' + bot.device.type + '（label=' + bot.device.label + '）')
        if (!/Googlebot/.test(String(bot.device.label))) errs.push('爬虫标签里没有名字：' + bot.device.label)
        return errs
      }
    },
    {
      name: '空 UA 报错',
      values: { ua: '', showRaw: false },
      expect: (d) => (d.error ? [] : ['空 UA 应给提示'])
    }
  ],

  'dev-http': [
    {
      name: '请求真的发出去并渲染响应',
      values: { method: 'GET', url: 'https://example.com/api/user', query: 'id=1', headers: 'X-Demo: 1', body: '', timeout: 10, proxy: false },
      expect: (d, h) => {
        const errs = []
        const sent = h.requests.join(' ')
        if (!/GET/.test(sent)) errs.push('没有发出 GET 请求（requests 记录为空）：' + sent)
        if (!/example\.com/.test(sent)) errs.push('请求 URL 未包含目标域名：' + sent)
        if (!d.result && !d.error) errs.push('既无结果也无错误')
        if (d.error) errs.push('请求失败：' + JSON.stringify(d.error))
        return errs
      }
    },
    {
      name: '非法 URL 必须在前端就被拦住',
      values: { method: 'GET', url: 'not a url', query: '', headers: '', body: '', timeout: 10, proxy: false },
      expect: (d) => (d.error ? [] : ['非法 URL 却没有报错'])
    },
    {
      name: '超时与空 URL 的错误分支',
      values: { method: 'POST', url: '', query: '', headers: '', body: '{}', timeout: 0, proxy: false },
      expect: (d) => (d.error ? [] : ['空 URL 应报错'])
    }
  ]
}
