/**
 * 单位换算核心（FR-CAL-01）—— 纯函数模块，无 wx 依赖
 * 10 组类别；线性单位统一折算到基准单位（因子精确到 double）；
 * 温度非线性单独公式；数据存储区分 1024(KiB) / 1000(kB) 双进制。
 */

// f = 1 该单位等于多少基准单位（相对误差 <1e-15，double 精度内）
const LINEAR = {
  length: {
    name: '长度', base: 'm',
    units: [
      { id: 'mm', name: '毫米', f: 0.001 },
      { id: 'cm', name: '厘米', f: 0.01 },
      { id: 'm', name: '米', f: 1 },
      { id: 'km', name: '千米', f: 1000 },
      { id: 'in', name: '英寸', f: 0.0254 },
      { id: 'ft', name: '英尺', f: 0.3048 },
      { id: 'yd', name: '码', f: 0.9144 },
      { id: 'mi', name: '英里', f: 1609.344 },
      { id: 'nmi', name: '海里', f: 1852 }
    ]
  },
  weight: {
    name: '重量', base: 'kg',
    units: [
      { id: 'mg', name: '毫克', f: 0.000001 },
      { id: 'g', name: '克', f: 0.001 },
      { id: 'kg', name: '千克', f: 1 },
      { id: 't', name: '吨', f: 1000 },
      { id: 'jin', name: '市斤', f: 0.5 },
      { id: 'liang', name: '市两', f: 0.05 },
      { id: 'oz', name: '盎司', f: 0.028349523125 },
      { id: 'lb', name: '磅', f: 0.45359237 }
    ]
  },
  area: {
    name: '面积', base: 'm2',
    units: [
      { id: 'cm2', name: '平方厘米', f: 0.0001 },
      { id: 'm2', name: '平方米', f: 1 },
      { id: 'km2', name: '平方千米', f: 1000000 },
      { id: 'ha', name: '公顷', f: 10000 },
      { id: 'mu', name: '亩', f: 2000 / 3 },
      { id: 'acre', name: '英亩', f: 4046.8564224 },
      { id: 'ft2', name: '平方英尺', f: 0.09290304 },
      { id: 'in2', name: '平方英寸', f: 0.00064516 }
    ]
  },
  volume: {
    name: '体积', base: 'm3',
    units: [
      { id: 'ml', name: '毫升', f: 0.000001 },
      { id: 'l', name: '升', f: 0.001 },
      { id: 'm3', name: '立方米', f: 1 },
      { id: 'gal', name: '加仑(美)', f: 0.003785411784 },
      { id: 'quart', name: '夸脱(美)', f: 0.000946352946 },
      { id: 'pint', name: '品脱(美)', f: 0.000473176473 },
      { id: 'cup', name: '杯(美)', f: 0.0002365882365 },
      { id: 'floz', name: '液盎司(美)', f: 0.0000295735295625 },
      { id: 'ft3', name: '立方英尺', f: 0.028316846592 }
    ]
  },
  speed: {
    name: '速度', base: 'm/s',
    units: [
      { id: 'mps', name: '米/秒', f: 1 },
      { id: 'kmh', name: '千米/时', f: 1 / 3.6 },
      { id: 'mph', name: '英里/时', f: 0.44704 },
      { id: 'kn', name: '节', f: 1852 / 3600 },
      { id: 'fps', name: '英尺/秒', f: 0.3048 },
      { id: 'kmmin', name: '千米/分', f: 1000 / 60 }
    ]
  },
  time: {
    name: '时间', base: 's',
    units: [
      { id: 'ms', name: '毫秒', f: 0.001 },
      { id: 's', name: '秒', f: 1 },
      { id: 'min', name: '分钟', f: 60 },
      { id: 'h', name: '小时', f: 3600 },
      { id: 'd', name: '天', f: 86400 },
      { id: 'wk', name: '周', f: 604800 },
      { id: 'month', name: '月(平均)', f: 2629800 },
      { id: 'year', name: '年(儒略)', f: 31557600 }
    ]
  },
  power: {
    name: '功率', base: 'W',
    units: [
      { id: 'W', name: '瓦', f: 1 },
      { id: 'kW', name: '千瓦', f: 1000 },
      { id: 'MW', name: '兆瓦', f: 1000000 },
      { id: 'hp', name: '马力(英制)', f: 745.6998715822702 },
      { id: 'hpMetric', name: '马力(公制)', f: 735.49875 },
      { id: 'kcalh', name: '千卡/时', f: 1.163 },
      { id: 'btuh', name: '英热单位/时', f: 0.29307107 }
    ]
  },
  pressure: {
    name: '压力', base: 'Pa',
    units: [
      { id: 'Pa', name: '帕斯卡', f: 1 },
      { id: 'kPa', name: '千帕', f: 1000 },
      { id: 'MPa', name: '兆帕', f: 1000000 },
      { id: 'bar', name: '巴', f: 100000 },
      { id: 'atm', name: '标准大气压', f: 101325 },
      { id: 'mmHg', name: '毫米汞柱', f: 133.322387415 },
      { id: 'psi', name: '磅/平方英寸', f: 6894.757293168361 },
      { id: 'kgfcm', name: '公斤力/平方厘米', f: 98066.5 }
    ]
  }
}

// 数据存储：pow = 10^? / 2^? 次幂；std='1000' 用 kB/MB，std='1024' 用 KiB/MiB
const DATA_UNITS = [
  { id: 'b', pow: 0, si: 'B', iec: 'B', siName: '字节', iecName: '字节' },
  { id: 'k', pow: 1, si: 'kB', iec: 'KiB', siName: '千字节(1000)', iecName: '二进制千字节(1024)' },
  { id: 'm', pow: 2, si: 'MB', iec: 'MiB', siName: '兆字节(1000)', iecName: '二进制兆字节(1024)' },
  { id: 'g', pow: 3, si: 'GB', iec: 'GiB', siName: '吉字节(1000)', iecName: '二进制吉字节(1024)' },
  { id: 't', pow: 4, si: 'TB', iec: 'TiB', siName: '太字节(1000)', iecName: '二进制太字节(1024)' },
  { id: 'p', pow: 5, si: 'PB', iec: 'PiB', siName: '拍字节(1000)', iecName: '二进制拍字节(1024)' }
]

const TEMP_UNITS = {
  c: { name: '摄氏度 °C', toBase: function (v) { return v + 273.15 } },
  k: { name: '开尔文 K', toBase: function (v) { return v } },
  f: { name: '华氏度 °F', toBase: function (v) { return (v + 459.67) * 5 / 9 } }
}
const TEMP_FROM_BASE = {
  c: function (k) { return k - 273.15 },
  k: function (k) { return k },
  f: function (k) { return k * 9 / 5 - 459.67 }
}

function dataBase(std) {
  return String(std) === '1024' ? 1024 : 1000
}

function dataLabel(u, std) {
  if (u.pow === 0) return u.si
  return String(std) === '1024' ? u.iec : u.si
}

function dataName(u, std) {
  if (u.pow === 0) return u.siName
  return String(std) === '1024' ? u.iecName : u.siName
}

// 去掉多余尾零的可读数字
function trimNum(x) {
  if (!isFinite(x)) return String(x)
  if (x === 0) return '0'
  const abs = Math.abs(x)
  if (abs >= 1e15 || abs < 1e-9) return x.toExponential(6)
  let s = x.toPrecision(12)
  if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '')
  return s
}

function categoryIds() {
  const ids = Object.keys(LINEAR)
  return ['length', 'weight', 'area', 'volume', 'temperature', 'speed', 'time', 'data', 'power', 'pressure']
    .filter(function (id) { return ids.indexOf(id) >= 0 || id === 'temperature' || id === 'data' })
}

function categoryName(id) {
  if (id === 'temperature') return '温度'
  if (id === 'data') return '数据存储'
  return LINEAR[id] ? LINEAR[id].name : id
}

// 返回 [{id,name}] 供 param-form select 使用
function unitOptions(cat, std) {
  if (cat === 'temperature') {
    return [
      { id: 'c', name: '摄氏度 °C' },
      { id: 'f', name: '华氏度 °F' },
      { id: 'k', name: '开尔文 K' }
    ]
  }
  if (cat === 'data') {
    return DATA_UNITS.map(function (u) { return { id: u.id, name: dataLabel(u, std) + ' ' + dataName(u, std) } })
  }
  return LINEAR[cat].units.map(function (u) { return { id: u.id, name: u.name + ' (' + u.id + ')' } })
}

function unitName(cat, id, std) {
  if (cat === 'temperature') return TEMP_UNITS[id] ? TEMP_UNITS[id].name : id
  if (cat === 'data') {
    const u = DATA_UNITS.filter(function (x) { return x.id === id })[0]
    return u ? dataLabel(u, std) : id
  }
  const g = LINEAR[cat]
  if (!g) return id
  const hit = g.units.filter(function (x) { return x.id === id })[0]
  return hit ? hit.name : id
}

function linearFactor(cat, id, std) {
  if (cat === 'data') {
    const u = DATA_UNITS.filter(function (x) { return x.id === id })[0]
    if (!u) return null
    return Math.pow(dataBase(std), u.pow)
  }
  const g = LINEAR[cat]
  if (!g) return null
  const hit = g.units.filter(function (x) { return x.id === id })[0]
  return hit ? hit.f : null
}

/**
 * 换算主入口
 * @returns {value, formula, precisionHint} | null（单位非法时）
 */
function convert(cat, from, to, value, opts) {
  const std = (opts && opts.dataStd) || '1024'
  const v = Number(value)
  if (!isFinite(v)) return null
  if (cat === 'temperature') {
    if (!TEMP_UNITS[from] || !TEMP_UNITS[to]) return null
    const baseK = TEMP_UNITS[from].toBase(v)
    const out = TEMP_FROM_BASE[to](baseK)
    let formula
    if (from === 'c' && to === 'f') formula = '°F = °C × 9/5 + 32（非线性，独立公式）'
    else if (from === 'f' && to === 'c') formula = '°C = (°F − 32) × 5/9（非线性，独立公式）'
    else formula = '1 ' + unitName(cat, from) + ' = ' + trimNum(TEMP_FROM_BASE[to](TEMP_UNITS[from].toBase(1))) + ' ' + unitName(cat, to)
    return { value: out, formula: formula, unit: unitName(cat, to, std) }
  }
  const f1 = linearFactor(cat, from, std)
  const f2 = linearFactor(cat, to, std)
  if (f1 === null || f2 === null) return null
  const out = v * f1 / f2
  const ratio = f1 / f2
  let formula = '1 ' + unitName(cat, from, std) + ' = ' + trimNum(ratio) + ' ' + unitName(cat, to, std)
  if (cat === 'data') {
    formula += '（按 ' + dataBase(std) + ' 进制，' + (String(std) === '1024' ? 'KiB/MiB 二进制前缀' : 'kB/MB 十进制前缀') + '）'
  }
  return { value: out, formula: formula, unit: unitName(cat, to, std) }
}

// 有效位格式化（precision 0-10 有效数字）
function formatValue(v, precision) {
  if (!isFinite(v)) return '—'
  const p = Math.max(0, Math.min(10, Number(precision)))
  if (p === 0) return String(v)
  if (v === 0) return '0'
  const abs = Math.abs(v)
  if (abs >= 1e15 || abs < 1e-6) return v.toExponential(Math.min(p, 6))
  return String(Number(v.toPrecision(Math.max(1, p + 1))))
}

module.exports = {
  categories: categoryIds,
  categoryName: categoryName,
  unitOptions: unitOptions,
  unitName: unitName,
  linearFactor: linearFactor,
  convert: convert,
  formatValue: formatValue,
  trimNum: trimNum
}
