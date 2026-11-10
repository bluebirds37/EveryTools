/**
 * packageDev/utils/cron.js —— Cron 表达式解析（FR-DEV-04）
 * 段数：5（Unix：分 时 日 月 周）、6（秒+5，或 5+年）、7（秒+5+年）。
 * 支持别名 @daily、名称缩写 JAN/MON、区间 a-b、步进 /n、列表 ,、
 * Quartz 特殊语法 ? L LW nW d#n 7L。
 * 星期编号按风格区分：Unix 0=周日..6=周六；Quartz 1=周日..7=周六，内部统一为 Quartz。
 * 解析失败给出「第几段 + 原文 + 原因」，纯逻辑可 node require。
 */

const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 }
const CN_DOW = ['日', '一', '二', '三', '四', '五', '六']
const ALIASES = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 0 * * 1',
  '@daily': '0 0 0 * * *',
  '@midnight': '0 0 0 * * *',
  '@hourly': '0 0 * * * *',
  '@minutely': '0 * * * * *',
  '@reboot': ''
}

function fail(index, token, reason) {
  const e = new Error(index === 0 ? 'Cron 表达式错误：' + reason : 'Cron 第 ' + index + ' 段「' + token + '」错误：' + reason)
  e.code = 'PARAM_INVALID'
  e.fieldIndex = index
  e.token = token
  e.reason = reason
  return e
}

function fieldDefs(withSec, withYear, quartzDow) {
  const defs = []
  if (withSec) defs.push({ key: 'second', label: '秒', min: 0, max: 59 })
  defs.push({ key: 'minute', label: '分', min: 0, max: 59 })
  defs.push({ key: 'hour', label: '时', min: 0, max: 23 })
  defs.push({ key: 'dom', label: '日', min: 1, max: 31, allowQuestion: true, allowL: true, allowW: true })
  defs.push({ key: 'month', label: '月', min: 1, max: 12, names: MONTH_NAMES })
  defs.push({
    key: 'dow',
    label: '星期',
    min: quartzDow ? 1 : 0,
    max: 7,
    quartz: quartzDow,
    names: quartzDow
      ? { sun: 1, mon: 2, tue: 3, wed: 4, thu: 5, fri: 6, sat: 7 }
      : { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
    allowQuestion: true,
    allowHash: true,
    allowL: true
  })
  if (withYear) defs.push({ key: 'year', label: '年', min: 1970, max: 2099 })
  return defs
}

/** 别名与段数归一 */
function normalize(expr) {
  const raw = String(expr === undefined ? '' : expr).trim()
  if (!raw) throw fail(0, raw, '表达式为空')
  const aliasKey = raw.toLowerCase()
  if (Object.prototype.hasOwnProperty.call(ALIASES, aliasKey)) {
    const expanded = ALIASES[aliasKey]
    if (!expanded) throw fail(0, raw, '@reboot 表示系统重启时执行，无法推算触发时间')
    return { fields: expanded.split(/\s+/), defs: fieldDefs(true, false, true), style: aliasKey + '（别名）' }
  }
  const parts = raw.split(/\s+/)
  let defs
  let style
  if (parts.length === 5) {
    defs = fieldDefs(false, false, false)
    style = 'unix-5（分 时 日 月 周，0=周日）'
  } else if (parts.length === 6) {
    defs = fieldDefs(true, false, true)
    style = 'quartz-6（秒 分 时 日 月 周，1=周日）'
  } else if (parts.length === 7) {
    defs = fieldDefs(true, true, true)
    style = 'quartz-7（秒 分 时 日 月 周 年）'
  } else {
    throw fail(0, raw, '段数只能是 5 / 6 / 7 段，当前 ' + parts.length + ' 段')
  }
  if (defs.length !== parts.length) throw fail(0, raw, '段数与字段数不匹配')
  return { fields: parts, defs, style }
}

function wrap(v, def) {
  if (def.key !== 'dow') return v
  if (def.quartz) return v === 0 ? 7 : v
  // Unix 0=周日 → 内部 Quartz 7；1..6 → 2..7
  return v === 0 ? 7 : v + 1
}

function toNum(s, def, item) {
  const t = String(s).trim().toLowerCase()
  if (/[a-z]/.test(t)) {
    if (!def.names) throw fail(0, item || t, def.label + '不支持名称「' + s + '」')
    const hit = def.names[t.slice(0, 3)]
    if (!hit && hit !== 0) throw fail(0, item || t, def.label + '无法识别的名称「' + s + '」')
    return hit
  }
  if (!/^\d{1,4}$/.test(t)) throw fail(0, item || t, def.label + '「' + s + '」不是合法数字或缩写')
  return Number(t)
}

function checkRange(n, def, item) {
  const isDow = def.key === 'dow'
  const lo = isDow ? 0 : def.min
  const hi = def.max
  if (n < lo || n > hi) throw fail(0, item, def.label + '取值应为 ' + def.min + '~' + def.max + '（收到 ' + n + '）')
  return n
}

/** 解析一段 */
function parseField(token, def, index) {
  const res = { all: false, values: new Set(), specials: [], question: false, def }
  const err = (reason) => fail(index, token, reason)
  if (token === '?') {
    if (!def.allowQuestion) throw err('只有「日」「星期」可以用 ? 占位')
    res.question = true
    res.all = true
    return res
  }
  if (token === '*') {
    res.all = true
    return res
  }
  token.split(',').forEach((raw) => {
    const item = raw.trim()
    if (!item) throw err('逗号分隔中存在空值')
    let body = item
    let step = 1
    const slash = item.indexOf('/')
    if (slash >= 0) {
      body = item.slice(0, slash)
      const s = item.slice(slash + 1)
      if (!/^\d+$/.test(s) || Number(s) < 1) throw err('步进 /' + item.slice(slash + 1) + ' 必须是正整数')
      step = Number(s)
      if (!body) body = '*'
    }
    // —— 特殊后缀 ——
    if (def.allowHash && /^\w+#\d$/.test(item)) {
      const dow = checkRange(toNum(item.split('#')[0], def, item), def, item)
      const nth = Number(item.split('#')[1])
      if (nth < 1 || nth > 5) throw err('第几个只能是 1~5，收到 ' + nth)
      res.specials.push({ type: 'nth', dow: wrap(dow, def), nth })
      return
    }
    if (def.key === 'dom' && item.toUpperCase() === 'LW') {
      res.specials.push({ type: 'lastWeekday' })
      return
    }
    if (def.allowL && /L$/i.test(item)) {
      if (item.toUpperCase() === 'L') {
        if (def.key === 'dom') res.specials.push({ type: 'lastDayOfMonth' })
        else res.specials.push({ type: 'lastDow', dow: 7 }) // 周六（Quartz 裸 L = 7L）
        return
      }
      if (/^\wL$/i.test(item)) {
        if (def.key !== 'dow') throw err('数字+L 只能用于星期段')
        res.specials.push({ type: 'lastDow', dow: wrap(checkRange(toNum(item.slice(0, -1), def, item), def, item), def) })
        return
      }
      throw err('无法识别的 L 写法「' + item + '」')
    }
    if (def.allowW && /^\d+W$/i.test(item)) {
      const d = Number(item.slice(0, -1))
      if (d < def.min || d > def.max) throw err('W 前的日期应 1~31，收到 ' + d)
      res.specials.push({ type: 'weekdayNearest', day: d })
      return
    }
    // —— 常规区间/单值 ——
    let lo
    let hi
    if (body === '*') {
      lo = def.min
      hi = def.max
    } else {
      const dash = body.indexOf('-')
      if (dash > 0) {
        lo = checkRange(toNum(body.slice(0, dash), def, item), def, item)
        hi = checkRange(toNum(body.slice(dash + 1), def, item), def, item)
      } else {
        lo = checkRange(toNum(body, def, item), def, item)
        hi = slash >= 0 ? def.max : lo
      }
      if (hi < lo && (def.key !== 'dow' || step === 1)) throw err('区间起点 ' + lo + ' 大于终点 ' + hi)
    }
    let v = lo
    while (v <= hi) {
      res.values.add(wrap(v, def))
      v += step
    }
    if (!res.values.size) throw err('区间内没有可用值')
  })
  return res
}

/** 解析整个表达式 */
function parse(expr) {
  const n = normalize(expr)
  const fields = {}
  n.defs.forEach((def, i) => {
    const token = n.fields[i]
    try {
      fields[def.key] = parseField(token, def, i + 1)
    } catch (e) {
      throw fail(i + 1, token, e.reason || e.message)
    }
  })
  const domFixed = fields.dom.question || fields.dom.all || fields.dom.specials.length || fields.dom.values.size
  const dowFixed = fields.dow.question || fields.dow.all || fields.dow.specials.length || fields.dow.values.size
  return {
    expr: String(expr).trim(),
    style: n.style,
    isAlias: /别名/.test(n.style),
    fields,
    // 两段都未用 ? 时按 Quartz 语义 AND；用了 ? 按该段忽略
    dayMode: fields.dom.question ? 'dow' : fields.dow.question ? 'dom' : domFixed && dowFixed && (!fields.dom.all || !fields.dow.all) ? 'and' : 'all'
  }
}

function isAll(f) {
  return !!(f && (f.question || (f.all && !f.specials.length)))
}

function includes(f, v) {
  if (!f || isAll(f)) return true
  if (f.specials.length && !f.values.size) return false
  return f.values.has(v)
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate()
}
function quartzDow(date) {
  // Quartz：1=周日 .. 7=周六
  return date.getDay() + 1
}

function matchDom(t, f) {
  const y = t.getFullYear()
  const m = t.getMonth() + 1
  const d = t.getDate()
  const total = daysInMonth(y, m)
  if (f.question) return true
  if (f.specials.length) {
    return f.specials.some((s) => {
      if (s.type === 'lastDayOfMonth') return d === total
      if (s.type === 'lastWeekday') {
        const wd = new Date(y, m - 1, total).getDay()
        let target = total
        if (wd === 6) target = total - 1
        if (wd === 0) target = total - 2
        return d === target
      }
      if (s.type === 'weekdayNearest') {
        const want = Math.min(s.day, total)
        const wd = new Date(y, m - 1, want).getDay()
        let target = want
        if (wd === 6) target = want - 1 < 1 ? want + 2 : want - 1 // 周六 → 周五
        if (wd === 0) target = want + 1 > total ? want - 2 : want + 1 // 周日 → 周一
        return d === target
      }
      return false
    })
  }
  return includes(f, d)
}

function matchDow(t, f) {
  if (f.question) return true
  const d = t.getDate()
  const total = daysInMonth(t.getFullYear(), t.getMonth() + 1)
  const dw = quartzDow(t)
  if (f.specials.length) {
    const hit = f.specials.some((s) => {
      if (s.type === 'nth') return s.dow === dw && Math.ceil(d / 7) === s.nth
      if (s.type === 'lastDow') return s.dow === dw && d > total - 7
      return false
    })
    if (hit) return true
  }
  if (f.values.size) return f.values.has(dw)
  return isAll(f)
}

function matchDay(t, f) {
  if (t.getMonth() + 1 !== undefined && !includes(f.month, t.getMonth() + 1)) return false
  const mode = f.__dayMode
  const okD = matchDom(t, f.dom)
  const okW = matchDow(t, f.dow)
  if (mode === 'dow') return okW
  if (mode === 'dom') return okD
  return okD && okW
}

function collect(f, lo, hi) {
  const out = []
  for (let v = lo; v <= hi; v++) if (includes(f, v)) out.push(v)
  return out
}

/**
 * 未来 count 次触发时间（默认 5 次，上限 20）
 * @param {string|object} src 表达式或 parse() 结果
 * @param {Date} from 起始时间
 * @param {number} count
 */
function next(src, from, count) {
  const t = typeof src === 'object' && src.fields ? src : parse(src)
  const f = t.fields
  f.__dayMode = t.dayMode
  const n = Math.min(Math.max(1, count || 5), 20)
  const start = new Date(from ? from.getTime() : Date.now())
  start.setMilliseconds(0)
  if (!f.second) start.setSeconds(0)
  const out = []
  let day = new Date(start.getFullYear(), start.getMonth(), start.getDate())
  const stopYear = f.year ? 2099 : start.getFullYear() + 6
  let guard = 0
  while (out.length < n && day.getFullYear() <= stopYear && guard++ < 4000) {
    if (!includes(f.month, day.getMonth() + 1)) {
      day = new Date(day.getFullYear() + (day.getMonth() === 11 ? 1 : 0), day.getMonth() === 11 ? 0 : day.getMonth() + 1, 1)
      continue
    }
    if (f.year && !includes(f.year, day.getFullYear())) {
      day = new Date(day.getFullYear() + 1, 0, 1)
      continue
    }
    if (matchDay(day, f)) {
      const hours = collect(f.hour, 0, 23)
      const minutes = collect(f.minute, 0, 59)
      const seconds = f.second ? collect(f.second, 0, 59) : [0]
      for (let i = 0; i < hours.length && out.length < n; i++) {
        for (let j = 0; j < minutes.length && out.length < n; j++) {
          for (let k = 0; k < seconds.length && out.length < n; k++) {
            const cand = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours[i], minutes[j], seconds[k], 0)
            if (cand.getTime() >= start.getTime()) out.push(cand)
          }
        }
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return out
}

const CN_MONTH = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
function pad(n) {
  return (n < 10 ? '0' : '') + n
}
function listOf(f) {
  return Array.from(f.values).sort((a, b) => a - b)
}
function joinVals(arr, unit, mapper) {
  const txt = arr.map((v) => (mapper ? mapper(v) : v) + unit)
  return txt.length > 6 ? txt.slice(0, 6).join('、') + '…（共 ' + txt.length + ' 个）' : txt.join('、')
}
function dowText(f) {
  const arr = Array.from(f.values).sort((a, b) => (a === 7 ? -1 : a) - (b === 7 ? -1 : b))
  const names = arr.map((v) => CN_DOW[(v + 6) % 7])
  const isWorkday = arr.length === 5 && [2, 3, 4, 5, 6].every((v) => arr.indexOf(v) >= 0)
  if (isWorkday) return '一至五（工作日）'
  return names.join('、')
}

/**
 * 时区抽象。页面（FR-DEV-Cron）要按「本机 / UTC / UTC±N」推算触发时间：
 * localZone 直接用本机本地字段；fixedZone 按固定分钟偏移（页面提示已声明不含夏令时）。
 */
function localZone() {
  const off = -new Date().getTimezoneOffset()
  return {
    kind: 'local',
    offsetMin: off,
    label: '本机时区（UTC' + (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60) + '）',
    parts: function (ms) {
      const d = new Date(ms)
      return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), week: d.getDay() }
    },
    wallDate: function (ms) {
      return new Date(ms)
    },
    toEpoch: function (d) {
      return d.getTime()
    }
  }
}

function fixedZone(offsetMinutes, label) {
  const off = Number(offsetMinutes) || 0
  return {
    kind: 'fixed',
    offsetMin: off,
    label: label || 'UTC' + (off >= 0 ? '+' : '-') + pad(Math.floor(Math.abs(off) / 60)) + ':' + pad(Math.abs(off) % 60),
    parts: function (ms) {
      const d = new Date(ms + off * 60000)
      return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), week: d.getUTCDay() }
    },
    // 「墙上时钟帧」：一个 Date，其本地字段恰好等于该时区的墙上时间，
    // 这样 next() 的本地日期算法可以原样复用，最后再用 toEpoch 还原真实时刻。
    wallDate: function (ms) {
      const p = this.parts(ms)
      return new Date(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, 0)
    },
    toEpoch: function (d) {
      return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()) - off * 60000
    }
  }
}

/** 在指定时区里格式化墙上时间 */
function fmtIn(zone, ms) {
  const p = (zone || localZone()).parts(ms)
  return p.y + '-' + pad(p.mo) + '-' + pad(p.d) + ' ' + pad(p.h) + ':' + pad(p.mi) + ':' + pad(p.s)
}

/**
 * 未来 count 次触发（页面用的主入口）。
 * @param {string|object} src 表达式或 parse() 结果
 * @param {{zone?:object, fromMs?:number, count?:number}} [opt]
 * @returns {{runs:Array<{ms,text,weekday,offsetText}>, note:string, zoneLabel:string}}
 */
function nextRuns(src, opt) {
  const o = opt || {}
  const zone = o.zone || localZone()
  const fromMs = Number(o.fromMs) || Date.now()
  const n = Math.min(20, Math.max(1, Number(o.count) || 5))
  const frame = next(src, zone.wallDate(fromMs), n)
  const runs = frame.map(function (d) {
    const ms = zone.toEpoch(d)
    return { ms: ms, text: fmtIn(zone, ms), weekday: '星期' + CN_DOW[zone.parts(ms).week], offsetText: untilNextMs(ms, fromMs) }
  })
  const note = runs.length ? '' : '在 6 年内没有命中（例如 2 月 30 日），已停止推算'
  return { runs: runs, note: note, zoneLabel: zone.label }
}

function untilNextMs(ms, fromMs) {
  const diff = ms - fromMs
  if (diff < 0) return '已过期'
  const s = Math.floor(diff / 1000)
  const day = Math.floor(s / 86400)
  const hour = Math.floor((s % 86400) / 3600)
  const min = Math.floor((s % 3600) / 60)
  if (day) return day + ' 天 ' + hour + ' 小时后'
  if (hour) return hour + ' 小时 ' + min + ' 分后'
  if (min) return min + ' 分钟后'
  return Math.max(1, s) + ' 秒后'
}

/** 单段的中文含义（页面「字段说明」表用） */
const UNIT_WORD = { second: '秒', minute: '分钟', hour: '小时', dom: '天', month: '月', dow: '星期', year: '年' }
const SPECIAL_TEXT = {
  lastDayOfMonth: '当月最后一天',
  lastWeekday: '当月最后一个工作日'
}

function fieldMeaning(field) {
  if (field.question) return '不限制（?）'
  const parts = []
  ;(field.specials || []).forEach(function (sp) {
    if (sp.type === 'lastDow') parts.push('当月最后一个' + CN_DOW[(sp.dow + 6) % 7])
    else if (sp.type === 'nth') parts.push('第 ' + sp.nth + ' 个' + CN_DOW[(sp.dow + 6) % 7])
    else parts.push(SPECIAL_TEXT[sp.type] || sp.type)
  })
  if (field.values && field.values.size) {
    parts.push(
      joinVals(listOf(field), '', function (v) {
        if (field.def.key === 'month') return CN_MONTH[v - 1]
        if (field.def.key === 'dow') return CN_DOW[(v + 6) % 7]
        return String(v)
      })
    )
  }
  if (!parts.length) return '每' + (UNIT_WORD[field.def.key] || field.def.label)
  return parts.join(' + ')
}

/** 逐字段展开成表格行：{key,label,raw,meaning} */
function fieldRows(src) {
  const t = typeof src === 'object' && src.fields ? src : parse(src)
  const norm = normalize(t.expr)
  return norm.defs.map(function (def, i) {
    const f = t.fields[def.key]
    return { key: def.key, label: def.label, raw: norm.fields[i] || '', meaning: f ? fieldMeaning(f) : '' }
  })
}

/** describe 的别名（页面沿用 summarize） */
function summarize(src) {
  return describe(src)
}

function describe(src) {
  const t = typeof src === 'object' && src.fields ? src : parse(src)
  const f = t.fields
  const date = []
  if (f.year && !isAll(f.year)) date.push('仅在 ' + joinVals(listOf(f.year), '年') + ' 的')
  if (!isAll(f.month)) date.push('每年 ' + joinVals(listOf(f.month).map((v) => CN_MONTH[v - 1]), ''))
  if (f.dom.specials.length) date.push(domSpecialText(f.dom))
  else if (!isAll(f.dom)) date.push('每月 ' + joinVals(listOf(f.dom), ' 日'))
  if (f.dow.specials.length) date.push(dowSpecialText(f.dow))
  else if (!isAll(f.dow)) date.push('星期 ' + dowText(f.dow))
  if (!date.length) date.push('每天')
  // 时间
  let time
  const singleH = !isAll(f.hour) && f.hour.values.size === 1 && !f.hour.specials.length
  const singleM = !isAll(f.minute) && f.minute.values.size === 1
  const singleS = f.second && !isAll(f.second) && f.second.values.size === 1
  if (singleH && singleM) {
    time = '在 ' + pad(listOf(f.hour)[0]) + ':' + pad(listOf(f.minute)[0]) + (singleS ? ':' + pad(listOf(f.second)[0]) : ':00') + ' 触发'
  } else if (isAll(f.hour) && isAll(f.minute) && (!f.second || isAll(f.second))) {
    time = f.second ? '每秒' : '每分钟'
  } else {
    const bits = []
    if (f.second && !isAll(f.second)) bits.push('秒= ' + joinVals(listOf(f.second), ''))
    if (!isAll(f.minute)) bits.push('分= ' + joinVals(listOf(f.minute), ''))
    if (!isAll(f.hour)) bits.push('时= ' + joinVals(listOf(f.hour), ''))
    time = bits.join('，') + '（' + (isAll(f.hour) ? '每小时' : '仅上述小时') + '内按上述分钟命中' + (f.second && !isAll(f.second) ? '、按上述秒命中' : '') + '）'
  }
  const leap = !isAll(f.dom) && f.dom.values.has(29) && !isAll(f.month) && f.month.values.has(2)
  return date.join('，') + ' ' + time + (leap ? '；仅闰年的 2 月 29 日存在' : '')
}

function domSpecialText(dom) {
  return dom.specials.map((s) => {
    if (s.type === 'lastDayOfMonth') return '每月最后一天'
    if (s.type === 'lastWeekday') return '每月最后一个工作日'
    if (s.type === 'weekdayNearest') return '离 ' + s.day + ' 日最近的工作日'
    return s.type
  }).join('、')
}
function dowSpecialText(dow) {
  const txt = dow.specials.map((s) => {
    if (s.type === 'nth') return '每月第 ' + s.nth + ' 个星期' + CN_DOW[(s.dow + 6) % 7]
    if (s.type === 'lastDow') return '每月最后一个星期' + CN_DOW[(s.dow + 6) % 7]
    return s.type
  })
  const rest = dow.values.size ? '或星期 ' + dowText(dow) : ''
  return txt.join('、') + rest
}

function fmt(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
}
function dowName(d) {
  return '星期' + CN_DOW[d.getDay()]
}
/** 人类可读间隔，如「2 天 3 小时后」 */
function untilNext(d, now) {
  const ms = d.getTime() - (now ? now.getTime() : Date.now())
  if (ms < 0) return '已过期'
  const s = Math.floor(ms / 1000)
  const day = Math.floor(s / 86400)
  const hour = Math.floor((s % 86400) / 3600)
  const min = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const bits = []
  if (day) bits.push(day + ' 天')
  if (hour) bits.push(hour + ' 小时')
  if (min) bits.push(min + ' 分')
  if (!day) bits.push(sec + ' 秒')
  return bits.join(' ') + '后'
}

const PRESETS = [
  { label: '每分钟', expr: '* * * * *' },
  { label: '每天 9:30', expr: '30 9 * * *' },
  { label: '工作日 9:30', expr: '30 9 * * 1-5' },
  { label: '每 15 分钟', expr: '*/15 * * * *' },
  { label: '每月 1 日 0 点', expr: '0 0 1 * *' },
  { label: 'Quartz 带秒', expr: '0 30 9 ? * 2-6' },
  { label: '闰日 2/29', expr: '0 0 29 2 *' },
  { label: '每月最后一个周五', expr: '0 0 0 * * 6L' }
]

module.exports = {
  parse,
  normalize,
  next,
  nextRuns,
  describe,
  summarize,
  fmt,
  fmtIn,
  dowName,
  untilNext,
  localZone,
  fixedZone,
  includes,
  matchDay,
  daysInMonth,
  fieldRows,
  PRESETS,
  ALIASES,
  MONTH_NAMES,
  CN_DOW
}
