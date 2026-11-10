/**
 * 日期计算核心（FR-CAL-02）—— 纯函数模块，无 wx 依赖
 * 间隔 / 加减（月末回退策略）/ 倒数日 / 工作日（内置 2025–2026 节假日表）/ ISO 周次与季度 / 农历最小实现
 */

const MS_DAY = 86400000

function pad2(n) {
  return n < 10 ? '0' + n : '' + n
}

function fmt(y, m, d) {
  return y + '-' + pad2(m) + '-' + pad2(d)
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
}

const DM = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function daysInMonth(y, m) {
  if (m === 2 && isLeap(y)) return 29
  return DM[m - 1]
}

function validDate(s) {
  const mt = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(s || '').trim())
  if (!mt) return null
  const y = Number(mt[1]), mo = Number(mt[2]), d = Number(mt[3])
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null
  return { y: y, m: mo, d: d }
}

// UTC 日序（自 1970-01-01），负取模统一处理，避免本地时区干扰
function dayIndex(y, m, d) {
  return Math.round(Date.UTC(y, m - 1, d) / MS_DAY)
}

function mod7(x) {
  return ((x % 7) + 7) % 7
}

function fromDayIndex(idx) {
  const dt = new Date(idx * MS_DAY)
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

function todayStr() {
  const dt = new Date()
  return fmt(dt.getFullYear(), dt.getMonth() + 1, dt.getDate())
}

// 某年某月某日（2/29 在平年在需要时钳制到 2/28 —— 与月末回退策略一致）
function safeDayIndex(y, m, d) {
  return dayIndex(y, m, Math.min(d, daysInMonth(y, m)))
}

/** 间隔：X年X月X天 + 总天数（B−A 日序差）+ 总周数 */
function diffDates(aStr, bStr) {
  const a = validDate(aStr), b = validDate(bStr)
  if (!a || !b) return null
  let sign = 1, s = a, e = b
  if (dayIndex(a.y, a.m, a.d) > dayIndex(b.y, b.m, b.d)) { sign = -1; s = b; e = a }
  let yy = e.y - s.y, mm = e.m - s.m, dd = e.d - s.d
  if (dd < 0) {
    mm -= 1
    const pm = e.m === 1 ? 12 : e.m - 1
    const py = e.m === 1 ? e.y - 1 : e.y
    dd += daysInMonth(py, pm)
  }
  if (mm < 0) { mm += 12; yy -= 1 }
  const totalDays = dayIndex(e.y, e.m, e.d) - dayIndex(s.y, s.m, s.d)
  const parts = []
  if (yy) parts.push(yy + ' 年')
  if (mm) parts.push(mm + ' 个月')
  parts.push(dd + ' 天')
  return {
    years: yy * sign, months: mm * sign, days: dd * sign,
    totalDays: totalDays * sign,
    totalWeeks: Math.floor(totalDays / 7),
    weeksRemain: totalDays % 7,
    ymdText: parts.join(' ')
  }
}

/** 日期加减：月末回退策略显式提示（31日+1月落月末；2/29+1年→2/28） */
function addDate(dateStr, delta, unit) {
  const s = validDate(dateStr)
  if (!s) return null
  const n = Math.trunc(Number(delta))
  if (!isFinite(n)) return null
  let y = s.y, m = s.m, d = s.d, adjusted = false
  if (unit === 'day') {
    const r = fromDayIndex(dayIndex(y, m, d) + n); y = r.y; m = r.m; d = r.d
  } else if (unit === 'week') {
    const r = fromDayIndex(dayIndex(y, m, d) + n * 7); y = r.y; m = r.m; d = r.d
  } else if (unit === 'month') {
    m += n
    y += Math.floor((m - 1) / 12)
    m = ((m - 1) % 12 + 12) % 12 + 1
    const maxD = daysInMonth(y, m)
    if (d > maxD) { d = maxD; adjusted = true }
  } else if (unit === 'year') {
    y += n
    const maxD = daysInMonth(y, m)
    if (d > maxD) { d = maxD; adjusted = true }
  } else {
    return null
  }
  const note = adjusted
    ? '目标月份无该日号，按「月末回退」策略取当月最后一天（例：2024-02-29 + 1 年 → 2025-02-28）'
    : '未触发月末回退，结果日号与输入一致'
  return { date: fmt(y, m, d), adjusted: adjusted, note: note }
}

/** 倒数日：还有 / 已过去；repeat=true 每年重复（2/29 平年钳制 2/28） */
function countdown(targetStr, todayStr_, repeat) {
  const t = validDate(targetStr)
  const now = validDate(todayStr_ || todayStr())
  if (!t || !now) return null
  const ti = dayIndex(t.y, t.m, t.d)
  const ni = dayIndex(now.y, now.m, now.d)
  if (!repeat) {
    const diff = ti - ni
    return {
      status: diff >= 0 ? 'remaining' : 'passed',
      days: Math.abs(diff),
      text: (diff >= 0 ? '距 ' + targetStr + ' 还有 ' : targetStr + ' 已过去 ') + Math.abs(diff) + ' 天'
    }
  }
  let candIdx = safeDayIndex(now.y, t.m, t.d)
  if (candIdx < ni) candIdx = safeDayIndex(now.y + 1, t.m, t.d)
  const prevIdx = candIdx === safeDayIndex(now.y, t.m, t.d)
    ? safeDayIndex(now.y - 1, t.m, t.d)
    : safeDayIndex(now.y, t.m, t.d)
  const days = candIdx - ni
  const cd = fromDayIndex(candIdx)
  return {
    status: days === 0 ? 'today' : 'remaining',
    days: days,
    nextDate: fmt(cd.y, cd.m, cd.d),
    passedDays: ni - prevIdx,
    text: days === 0
      ? '就是今天（上次发生也在今天）'
      : '每年重复：距下次 ' + fmt(cd.y, cd.m, cd.d) + ' 还有 ' + days + ' 天，上次发生日已过 ' + (ni - prevIdx) + ' 天'
  }
}

/* ---------------- 中国法定节假日（内置 2025–2026，后端可下发覆盖） ---------------- */

const CN_HOLIDAYS = {
  dataYears: '2025–2026',
  note: '依据国务院放假安排通知整理（含调休补班日），离线参考；以后端下发数据为准。',
  holidays: [
    '2025-01-01',
    '2025-01-28', '2025-01-29', '2025-01-30', '2025-01-31', '2025-02-01', '2025-02-02', '2025-02-03', '2025-02-04',
    '2025-04-04', '2025-04-05', '2025-04-06',
    '2025-05-01', '2025-05-02', '2025-05-03', '2025-05-04', '2025-05-05',
    '2025-05-31', '2025-06-01', '2025-06-02',
    '2025-10-01', '2025-10-02', '2025-10-03', '2025-10-04', '2025-10-05', '2025-10-06', '2025-10-07', '2025-10-08',
    '2026-01-01', '2026-01-02', '2026-01-03',
    '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
    '2026-04-04', '2026-04-05', '2026-04-06',
    '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
    '2026-06-19', '2026-06-20', '2026-06-21',
    '2026-09-25', '2026-09-26', '2026-09-27',
    '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'
  ],
  workdays: [
    '2025-01-26', '2025-02-08', '2025-04-27', '2025-09-28', '2025-10-11',
    '2026-02-14', '2026-02-28', '2026-04-26', '2026-09-20', '2026-10-10'
  ]
}

function holidaySet(override) {
  const h = {}, w = {}
  CN_HOLIDAYS.holidays.forEach(function (d) { h[d] = true })
  CN_HOLIDAYS.workdays.forEach(function (d) { w[d] = true })
  if (override) {
    ;(override.holidays || []).forEach(function (d) { h[d] = true })
    ;(override.workdays || []).forEach(function (d) { w[d] = true; h[d] = false })
  }
  return { holidays: h, workdays: w }
}

// 星期索引：0=周日 … 6=周六
function weekdayOf(dateStr) {
  const s = validDate(dateStr)
  if (!s) return null
  return mod7(dayIndex(s.y, s.m, s.d) + 4)
}

/** 工作日统计：默认排除周六/周日；useHolidays 时排除节假日并计入调休补班 */
function workdaysBetween(startStr, endStr, useHolidays, override) {
  const a = validDate(startStr), b = validDate(endStr)
  if (!a || !b) return null
  let s = a, e = b
  const reversed = dayIndex(a.y, a.m, a.d) > dayIndex(b.y, b.m, b.d)
  if (reversed) { s = b; e = a }
  const set = holidaySet(override)
  let work = 0, rest = 0, holidayHit = 0, makeUpHit = 0
  for (let idx = dayIndex(s.y, s.m, s.d); idx <= dayIndex(e.y, e.m, e.d); idx++) {
    const r = fromDayIndex(idx)
    const ds = fmt(r.y, r.m, r.d)
    const wdSun = mod7(idx + 4) // 0=周日 6=周六
    const weekend = wdSun === 0 || wdSun === 6
    if (useHolidays && set.holidays[ds] === true) { rest += 1; holidayHit += 1; continue }
    if (useHolidays && weekend && set.workdays[ds]) { work += 1; makeUpHit += 1; continue }
    if (weekend) rest += 1
    else work += 1
  }
  return {
    totalDays: dayIndex(e.y, e.m, e.d) - dayIndex(s.y, s.m, s.d) + 1,
    workdays: work,
    restdays: rest,
    holidayExcluded: holidayHit,
    makeUpWorked: makeUpHit,
    reversed: reversed,
    dataNote: useHolidays
      ? '节假日表年份：' + CN_HOLIDAYS.dataYears + '，' + CN_HOLIDAYS.note
      : '未启用节假日表，仅排除周六/周日'
  }
}

/** ISO 8601 周次 + 年中第几周（周日起始） + 季度 + 周起止 + 干支/农历附表 */
function weekInfo(dateStr) {
  const s = validDate(dateStr)
  if (!s) return null
  const idx = dayIndex(s.y, s.m, s.d)
  const wdISO = mod7(idx + 3) + 1 // 1=周一 … 7=周日
  const thuIdx = idx + (4 - wdISO)
  const thu = fromDayIndex(thuIdx)
  const isoYear = thu.y
  const jan4Idx = dayIndex(isoYear, 1, 4)
  const wdJan4 = mod7(jan4Idx + 3) + 1
  const thuDoy = thuIdx - dayIndex(isoYear, 1, 1) + 1
  const isoWeek = Math.floor((thuDoy + wdJan4 - 8) / 7) + 1
  const doy = idx - dayIndex(s.y, 1, 1) + 1
  const jan1WdSun = mod7(dayIndex(s.y, 1, 1) + 4)
  const weekOfYear = Math.floor((doy - 1 + jan1WdSun) / 7) + 1
  const q = Math.floor((s.m - 1) / 3) + 1
  const ws = fromDayIndex(idx - wdISO + 1)
  const we = fromDayIndex(idx - wdISO + 7)
  return {
    isoYear: isoYear,
    isoWeek: isoWeek,
    isoLabel: isoYear + '-W' + pad2(isoWeek) + '-' + wdISO,
    weekOfYear: weekOfYear,
    weekday: '星期' + ['日', '一', '二', '三', '四', '五', '六'][mod7(idx + 4)],
    dayOfYear: doy,
    daysInYear: isLeap(s.y) ? 366 : 365,
    quarter: 'Q' + q,
    quarterRange: fmt(s.y, (q - 1) * 3 + 1, 1) + ' ~ ' + fmt(s.y, q * 3, daysInMonth(s.y, q * 3)),
    weekStart: fmt(ws.y, ws.m, ws.d),
    weekEnd: fmt(we.y, we.m, we.d)
  }
}

/* ---------------- 农历实现（1901–2100，本地数据表，无网络；表源自经典 jjcalendar 数据） ---------------- */

const LUNAR_INFO = [
  0x04bd8, 0x04ae0, 0x0a570, 0x054d5, 0x0d260, 0x0d950, 0x16554, 0x056a0, 0x09ad0, 0x055d2, // 1900-1909
  0x04ae0, 0x0a5b6, 0x0a4d0, 0x0d250, 0x1d255, 0x0b540, 0x0d6a0, 0x0ada2, 0x095b0, 0x14977, // 1910-1919
  0x04970, 0x0a4b0, 0x0b4b5, 0x06a50, 0x06d40, 0x1ab54, 0x02b60, 0x09570, 0x052f2, 0x04970, // 1920-1929
  0x06566, 0x0d4a0, 0x0ea50, 0x06e95, 0x05ad0, 0x02b60, 0x186e3, 0x092e0, 0x1c8d7, 0x0c950, // 1930-1939
  0x0d4a0, 0x1d8a6, 0x0b550, 0x056a0, 0x1a5b4, 0x025d0, 0x092d0, 0x0d2b2, 0x0a950, 0x0b557, // 1940-1949
  0x06ca0, 0x0b550, 0x15355, 0x04da0, 0x0a5b0, 0x14573, 0x052b0, 0x0a9a8, 0x0e950, 0x06aa0, // 1950-1959
  0x0aea6, 0x0ab50, 0x04b60, 0x0aae4, 0x0a570, 0x05260, 0x0f263, 0x0d950, 0x05b57, 0x056a0, // 1960-1969
  0x096d0, 0x04dd5, 0x04ad0, 0x0a4d0, 0x0d4d4, 0x0d250, 0x0d558, 0x0b540, 0x0b6a0, 0x195a6, // 1970-1979
  0x095b0, 0x049b0, 0x0a974, 0x0a4b0, 0x0b27a, 0x06a50, 0x06d40, 0x0af46, 0x0ab60, 0x09570, // 1980-1989
  0x04af5, 0x04970, 0x064b0, 0x074a3, 0x0ea50, 0x06b58, 0x055c0, 0x0ab60, 0x096d5, 0x092e0, // 1990-1999
  0x0c960, 0x0d954, 0x0d4a0, 0x0da50, 0x07552, 0x056a0, 0x0abb7, 0x025d0, 0x092d0, 0x0cab5, // 2000-2009
  0x0a950, 0x0b4a0, 0x0baa4, 0x0ad50, 0x055d9, 0x04ba0, 0x0a5b0, 0x15176, 0x052b0, 0x0a930, // 2010-2019
  0x07954, 0x06aa0, 0x0ad50, 0x05b52, 0x04b60, 0x0a6e6, 0x0a4e0, 0x0d260, 0x0ea65, 0x0d530, // 2020-2029
  0x05aa0, 0x076a3, 0x096d0, 0x04afb, 0x04ad0, 0x0a4d0, 0x1d0b6, 0x0d250, 0x0d520, 0x0dd45, // 2030-2039
  0x0b5a0, 0x056d0, 0x055b2, 0x049b0, 0x0a577, 0x0a4b0, 0x0aa50, 0x1b255, 0x06d20, 0x0ada0, // 2040-2049
  0x14b63, 0x09370, 0x049f8, 0x04970, 0x064b0, 0x168a6, 0x0ea50, 0x06b20, 0x1a6c4, 0x0aae0, // 2050-2059
  0x0a2e0, 0x0d2e3, 0x0c960, 0x0d557, 0x0d4a0, 0x0da50, 0x05d55, 0x056a0, 0x0a6d0, 0x055d4, // 2060-2069
  0x052d0, 0x0a9b8, 0x0a950, 0x0b4a0, 0x0b6a6, 0x0ad50, 0x055a0, 0x0aba4, 0x0a5b0, 0x052b0, // 2070-2079
  0x0b273, 0x06930, 0x07337, 0x06aa0, 0x0ad50, 0x14b55, 0x04b60, 0x0a570, 0x054e4, 0x0d160, // 2080-2089
  0x0e968, 0x0d520, 0x0daa0, 0x16aa6, 0x056d0, 0x04ae0, 0x0a9d4, 0x0a2d0, 0x0d150, 0x0f252, // 2090-2099
  0x0d520 // 2100
]

const LUNAR_MONTH_NAMES = ['正', '二', '三', '四', '五', '六', '七', '八', '九', '十', '冬', '腊']
const LUNAR_DAY_NAMES = ['初一', '初二', '初三', '初四', '初五', '初六', '初七', '初八', '初九', '初十',
  '十一', '十二', '十三', '十四', '十五', '十六', '十七', '十八', '十九', '二十',
  '廿一', '廿二', '廿三', '廿四', '廿五', '廿六', '廿七', '廿八', '廿九', '三十']
const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸']
const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥']
const ZOO = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪']

function leapMonth(y) { return LUNAR_INFO[y - 1900] & 0xf }
function leapDays(y) { return leapMonth(y) ? ((LUNAR_INFO[y - 1900] & 0x10000) ? 30 : 29) : 0 }
function lunarMonthDays(y, m) { return (LUNAR_INFO[y - 1900] & (0x10000 >> m)) ? 30 : 29 }
function lunarYearDays(y) {
  let sum = 348
  for (let bit = 0x8000; bit > 0x8; bit >>= 1) sum += (LUNAR_INFO[y - 1900] & bit) ? 1 : 0
  return sum + leapDays(y)
}

/** 公历 → 农历（1901–2100，本地数据表；基准：1900-01-31 = 农历庚子年正月初一） */
function solarToLunar(dateStr) {
  const s = validDate(dateStr)
  if (!s || s.y < 1901 || s.y > 2100) return null
  let offset = dayIndex(s.y, s.m, s.d) - dayIndex(1900, 1, 31)
  let year = 1900, temp = 0
  for (; year < 2101 && offset > 0; year++) {
    temp = lunarYearDays(year)
    offset -= temp
  }
  if (offset < 0) { offset += temp; year-- }
  const leap = leapMonth(year)
  let isLeap = false
  let lm = 1
  for (; lm < 13 && offset > 0; lm++) {
    if (leap > 0 && lm === leap + 1 && !isLeap) {
      lm--
      isLeap = true
      temp = leapDays(year)
    } else {
      temp = lunarMonthDays(year, lm)
    }
    if (isLeap && lm === leap + 1) isLeap = false
    offset -= temp
  }
  if (offset === 0 && leap > 0 && lm === leap + 1) {
    if (isLeap) isLeap = false
    else { isLeap = true; lm-- }
  }
  if (offset < 0) { lm--; offset += temp }
  const ld = offset + 1
  const gzIdx = (year - 1900 + 36) % 60
  const ganzhi = GAN[gzIdx % 10] + ZHI[gzIdx % 12]
  const zodiac = ZOO[(year - 4) % 12]
  return {
    year: year, month: lm, day: ld, isLeap: isLeap,
    ganzhi: ganzhi, zodiac: zodiac,
    monthName: (isLeap ? '闰' : '') + LUNAR_MONTH_NAMES[lm - 1] + '月',
    dayName: LUNAR_DAY_NAMES[Math.min(ld, 30) - 1],
    text: ganzhi + '[' + zodiac + ']年 ' + (isLeap ? '闰' : '') + LUNAR_MONTH_NAMES[lm - 1] + '月' + LUNAR_DAY_NAMES[ld - 1]
  }
}

module.exports = {
  pad2: pad2,
  fmt: fmt,
  isLeap: isLeap,
  daysInMonth: daysInMonth,
  validDate: validDate,
  dayIndex: dayIndex,
  fromDayIndex: fromDayIndex,
  todayStr: todayStr,
  diffDates: diffDates,
  addDate: addDate,
  countdown: countdown,
  weekdayOf: weekdayOf,
  workdaysBetween: workdaysBetween,
  weekInfo: weekInfo,
  solarToLunar: solarToLunar,
  CN_HOLIDAYS: CN_HOLIDAYS,
  LUNAR_RANGE: { from: 1901, to: 2100 }
}
