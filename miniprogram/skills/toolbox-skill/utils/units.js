/**
 * utils/units.js —— 单位换算纯函数（convertUnit 原子接口专用）
 *
 * ⚠️ 与主包 packageText/packageCalc 同源逻辑：skill 为 independent 分包不可跨包 require，
 *    本文件是 packageCalc/pages/unit 换算表的独立副本，**修改任一侧必须同步另一侧**。
 * 需求来源：docs/tools-spec.md FR-CAL-01（长度/重量/面积/体积/温度/速度/时间/数据存储/功率/压力；
 *    温度非线性单独公式；数据存储区分 1000 与 1024 进制并标注；默认 6 位有效数字）。
 */

// 线性单位表：{ unitKey: 相对基准单位的系数 }（大小写不敏感）
const LINEAR_GROUPS = {
  length: {
    base: 'm', label: '长度',
    units: { mm: 0.001, cm: 0.01, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144, mi: 1609.344, nmi: 1852 }
  },
  weight: {
    base: 'kg', label: '重量',
    units: { mg: 0.000001, g: 0.001, kg: 1, t: 1000, oz: 0.028349523125, lb: 0.45359237 }
  },
  area: {
    base: 'm2', label: '面积',
    units: { mm2: 0.000001, cm2: 0.0001, m2: 1, ha: 10000, are: 100, km2: 1000000, acre: 4046.8564224, ft2: 0.09290304, yd2: 0.83612736, in2: 0.00064516 }
  },
  volume: {
    base: 'l', label: '体积',
    units: { ml: 0.001, cl: 0.01, dl: 0.1, l: 1, hl: 100, m3: 1000, cm3: 0.001, dm3: 1, gal: 3.785411784, qt: 0.946352946, pt: 0.473176473, cup: 0.2365882365, floz: 0.0295735295625, ft3: 28.316846592, in3: 0.016387064 }
  },
  speed: {
    base: 'ms', label: '速度',
    units: { ms: 1, kmh: 1 / 3.6, mph: 0.44704, kn: 0.5144444444444445, mach: 340.29 }
  },
  time: {
    base: 's', label: '时间',
    units: { ms: 0.001, s: 1, min: 60, h: 3600, d: 86400, w: 604800, month: 2629800, year: 31557600 }
  },
  // 数据存储：1000 进制（kb…）与 1024 进制（kib…）并列，结果中显式标注
  data: {
    base: 'b', label: '数据存储',
    units: {
      b: 1, bit: 0.125,
      kb: 1000, mb: 1000000, gb: 1000000000, tb: 1e12, pb: 1e15,
      kib: 1024, mib: 1048576, gib: 1073741824, tib: 1099511627776, pib: 1125899906842624
    }
  },
  power: {
    base: 'w', label: '功率',
    units: { w: 1, kw: 1000, mw: 1000000, gw: 1000000000, hp: 745.699872, kcalh: 1162.2222222 }
  },
  pressure: {
    base: 'pa', label: '压力',
    units: { pa: 1, kpa: 1000, mpa: 1000000, gpa: 1000000000, bar: 100000, mbar: 100, atm: 101325, psi: 6894.757293168, mmhg: 133.322387415, inhg: 3386.389 }
  }
}

// 温度非线性：先转摄氏再转目标（c 基准）
const TEMP_UNITS = { c: 'celsius', f: 'fahrenheit', k: 'kelvin', r: 'rankine' }

function toCelsius(value, unit) {
  if (unit === 'c') return value
  if (unit === 'f') return (value - 32) / 1.8
  if (unit === 'k') return value - 273.15
  return (value - 491.67) / 1.8 // r
}

function fromCelsius(c, unit) {
  if (unit === 'c') return c
  if (unit === 'f') return c * 1.8 + 32
  if (unit === 'k') return c + 273.15
  return (c + 273.15) * 1.8 + 491.67 // r
}

/** 有效数字保留（precision 0-10，默认 6） */
function roundSig(n, precision) {
  const p = Math.max(0, Math.min(10, precision === undefined ? 6 : Number(precision) || 6))
  if (n === 0 || !isFinite(n)) return n
  if (p === 0) return Math.round(n)
  const mag = Math.floor(Math.log10(Math.abs(n)))
  const factor = Math.pow(10, p - 1 - mag)
  return Math.round(n * factor) / factor
}

function normalizeUnitKey(u) {
  return String(u || '').trim().toLowerCase()
}

/** 单位 key → 展示名 */
const UNIT_LABELS = {
  mm: '毫米', cm: '厘米', m: '米', km: '千米', in: '英寸', ft: '英尺', yd: '码', mi: '英里', nmi: '海里',
  mg: '毫克', g: '克', kg: '千克', t: '吨', oz: '盎司', lb: '磅',
  mm2: '平方毫米', cm2: '平方厘米', m2: '平方米', are: '公亩', ha: '公顷', km2: '平方千米', acre: '英亩', ft2: '平方英尺', yd2: '平方码', in2: '平方英寸',
  ml: '毫升', cl: '厘升', dl: '分升', l: '升', hl: '百升', m3: '立方米', cm3: '立方厘米', dm3: '立方分米', gal: '加仑', qt: '夸脱', pt: '品脱', cup: '杯', floz: '液量盎司', ft3: '立方英尺', in3: '立方英寸',
  ms: '米/秒', kmh: '千米/时', mph: '英里/时', kn: '节', mach: '马赫',
  min: '分钟', h: '小时', d: '天', w: '周', month: '月(30.44天)', year: '年(365.25天)',
  b: '字节', bit: '比特', kb: 'kB(1000)', mb: 'MB(1000)', gb: 'GB(1000)', tb: 'TB(1000)', pb: 'PB(1000)',
  kib: 'KiB(1024)', mib: 'MiB(1024)', gib: 'GiB(1024)', tib: 'TiB(1024)', pib: 'PiB(1024)',
  w: '瓦', kw: '千瓦', mw: '兆瓦', gw: '吉瓦', hp: '马力', kcalh: '千卡/时',
  pa: '帕', kpa: '千帕', mpa: '兆帕', gpa: '吉帕', bar: '巴', mbar: '毫巴', atm: '标准大气压', psi: '磅/平方英寸', mmhg: '毫米汞柱', inhg: '英寸汞柱',
  c: '摄氏度', f: '华氏度', k: '开尔文', r: '兰氏度'
}

/**
 * 单位换算。
 * @param {number|string} value 数值
 * @param {string} from 源单位（英文 key，大小写不敏感）
 * @param {string} to 目标单位
 * @param {number} [precision=6] 有效数字 0-10
 * @returns {{ok:boolean, code?:string, message?:string, result?:number, group?:string, formula?:string}}
 */
function convertUnit(value, from, to, precision) {
  const v = typeof value === 'number' ? value : Number(String(value == null ? '' : value).replace(/,/g, ''))
  if (!isFinite(v)) {
    return { ok: false, code: 'PARAM_INVALID', message: 'value 必须是数字，收到：' + String(value) }
  }
  const f = normalizeUnitKey(from)
  const t = normalizeUnitKey(to)
  if (TEMP_UNITS[f] && TEMP_UNITS[t]) {
    const c = toCelsius(v, f)
    const result = roundSig(fromCelsius(c, t), precision)
    return {
      ok: true, result, group: 'temperature',
      fromUnit: f, toUnit: t,
      formula: '温度非线性换算：经摄氏中转（°F=(°C×1.8)+32 / K=°C+273.15）'
    }
  }
  if (TEMP_UNITS[f] !== TEMP_UNITS[t]) {
    return {
      ok: false, code: 'PARAM_INVALID',
      message: '温度单位(c/f/k/r)与非温度单位不能互转：from=' + from + ', to=' + to +
        '。温度单位仅允许 ' + Object.keys(TEMP_UNITS).join('/') + '；其余单位见各分组换算表'
    }
  }
  const groupKeys = Object.keys(LINEAR_GROUPS)
  for (let i = 0; i < groupKeys.length; i++) {
    const key = groupKeys[i]
    const g = LINEAR_GROUPS[key]
    if (g.units[f] !== undefined && g.units[t] !== undefined) {
      const result = roundSig(v * g.units[f] / g.units[t], precision)
      const one = roundSig(g.units[f] / g.units[t], precision)
      return {
        ok: true, result, group: key, fromUnit: f, toUnit: t,
        formula: '1 ' + (UNIT_LABELS[f] || f) + ' = ' + one + ' ' + (UNIT_LABELS[t] || t)
      }
    }
  }
  // 未知单位：给出全部支持枚举，作为唯一正确出口
  const supported = ['temperature(c/f/k/r)']
  for (let j = 0; j < groupKeys.length; j++) {
    const g = LINEAR_GROUPS[groupKeys[j]]
    supported.push(g.label + '(' + Object.keys(g.units).join('/') + ')')
  }
  return {
    ok: false, code: 'PARAM_INVALID',
    message: '无法识别单位：from=' + from + ', to=' + to + '。仅支持同一分组内互转；全部分组与单位枚举：' + supported.join('；')
  }
}

/** convertUnit inputSchema 的 from/to 枚举全集（英文 key） */
function allUnitKeys() {
  const set = {}
  const gk = Object.keys(LINEAR_GROUPS)
  for (let i = 0; i < gk.length; i++) {
    const uk = Object.keys(LINEAR_GROUPS[gk[i]].units)
    for (let j = 0; j < uk.length; j++) set[uk[j]] = true
  }
  const tk = Object.keys(TEMP_UNITS)
  for (let k = 0; k < tk.length; k++) set[tk[k]] = true
  return Object.keys(set).sort()
}

module.exports = { convertUnit, roundSig, allUnitKeys, LINEAR_GROUPS, UNIT_LABELS }
