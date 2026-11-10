/* 换算/计算类（calc-*）逐工具功能用例
 *
 * 断言一律来自**手算的已知向量**（公式写在注释里），不拿产品输出自证。
 * 入口：calc-unit 是输入即算（只有 recompute()），其余页面走 onRun()。
 * 一次场景里要额外验别的输入时，用 prepare 预跑并把快照挂在 inst.__probe_x 上，
 * 由 expect( data, h, inst ) 一起断言（probe() 会还原 values，不影响正式运行）。
 */

const U_UNITS = 'packageCalc/utils/units.js'
const U_CAL = 'packageCalc/utils/calendar.js'
const U_FIN = 'packageCalc/utils/fin.js'
const U_RND = 'packageCalc/utils/random.js'

function relErr(got, want) {
  if (typeof got !== 'number' || !isFinite(got)) return Infinity
  if (want === 0) return Math.abs(got)
  return Math.abs(got - want) / Math.abs(want)
}

function kv(d, key) {
  const r = d && d.result
  if (!r || !Array.isArray(r.kv)) return null
  const hit = r.kv.filter(function (x) { return x.key === key })[0]
  return hit ? hit.value : null
}

function numOf(str) {
  const m = /-?\d[\d,]*(?:\.\d+)?/.exec(String(str == null ? '' : str))
  return m ? Number(m[0].replace(/,/g, '')) : NaN
}

function errCode(d) {
  return d && d.error ? d.error.code : null
}

function errMsg(d) {
  return d && d.error ? String(d.error.message || '') : ''
}

function errText(d) {
  return d && d.error ? String(d.error.code || '') + ' ' + String(d.error.message || '') : ''
}

function dirty(d) {
  const s = JSON.stringify(d.result || d.error || {})
  return /NaN|Infinity|undefined/.test(s)
}

function probe(inst, name, values, method) {
  const before = JSON.parse(JSON.stringify(inst.data.values))
  inst.setData({ values: Object.assign({}, inst.data.values, values) })
  const m = method || (typeof inst.onRun === 'function' ? 'onRun' : 'recompute')
  inst[m]()
  const snap = JSON.parse(JSON.stringify({
    result: inst.data.result,
    error: inst.data.error,
    rows: inst.data.rows,
    data: inst.data
  }))
  inst['__probe_' + name] = snap
  inst.setData({ values: before })
  return snap
}

function gp(inst, name) {
  return inst['__probe_' + name] || null
}

function picked(str) {
  return String(str == null ? '' : str).split('、').filter(function (x) { return x !== '' })
}

function allIn(arr, lo, hi) {
  for (let i = 0; i < arr.length; i++) {
    const n = Number(arr[i])
    if (!isFinite(n) || n < lo || n > hi) return arr[i]
  }
  return null
}

function distinctCount(arr) {
  const m = {}
  arr.forEach(function (x) { m[x] = true })
  return Object.keys(m).length
}

module.exports = {
  /* ============================ calc-unit ============================ */
  'calc-unit': [
    {
      name: '跨类别精确向量抽查 + 页面 mi→km 双向显示',
      values: { cat: 'length', from: 'mi', to: 'km', value: '1', precision: 6, dataStd: '1024' },
      run: 'recompute',
      expect(d, h) {
        const errs = []
        const u = h.lib(U_UNITS)
        // 手算精确值：全部按国际定义因子
        const table = [
          ['length', 'mi', 'km', 1, 1.609344, ''],            // 1 mi = 1609.344 m
          ['length', 'in', 'cm', 1, 2.54, ''],                 // 1 in = 0.0254 m
          ['length', 'ft', 'm', 1, 0.3048, ''],
          ['area', 'acre', 'm2', 1, 4046.8564224, ''],         // 1 acre = 4356 ft2 × 0.09290304
          ['area', 'ha', 'm2', 1, 10000, ''],
          ['weight', 'lb', 'kg', 1, 0.45359237, ''],
          ['weight', 'oz', 'g', 1, 28.349523125, ''],
          ['volume', 'gal', 'l', 1, 3.785411784, ''],          // 1 US gal = 3.785411784 L
          ['speed', 'kn', 'mps', 1, 1852 / 3600, ''],          // 1 节 = 0.514444… m/s
          ['speed', 'mph', 'kmh', 60, 96.56064, ''],           // 60 mph = 60×1.609344 km/h
          ['power', 'hp', 'kW', 1, 0.7456998715822702, ''],    // 1 英制马力 = 745.6998715822702 W
          ['pressure', 'atm', 'kPa', 1, 101.325, ''],
          ['time', 'year', 'd', 1, 365.25, ''],                // 儒略年 31557600 s
          ['time', 'd', 'h', 1, 24, ''],
          ['data', 'm', 'b', 1, 1048576, '1024'],              // 1 MiB = 1024^2 B
          ['data', 'm', 'b', 1, 1000000, '1000'],              // 1 MB = 1000^2 B
          ['data', 'g', 'm', 1, 1024, '1024'],
          ['temperature', 'c', 'f', 0, 32, ''],                // °F = °C×9/5+32
          ['temperature', 'c', 'f', 100, 212, ''],
          ['temperature', 'k', 'c', 0, -273.15, ''],
          ['temperature', 'c', 'k', -273.15, 0, '']
        ]
        for (let i = 0; i < table.length; i++) {
          const t = table[i]
          const r = u.convert(t[0], t[1], t[2], t[3], { dataStd: t[5] })
          if (!r) { errs.push('units.convert(' + t[0] + ',' + t[1] + '→' + t[2] + ') 返回 null'); continue }
          const e = relErr(r.value, t[4])
          if (!(e <= 1e-9)) errs.push('换算精度超差：' + t[1] + '→' + t[2] + ' 期望 ' + t[4] + ' 实得 ' + r.value + '（相对误差 ' + e.toExponential(2) + ' > 1e-9）')
        }
        const mu = u.convert('area', 'mu', 'm2', 3)
        if (!mu || relErr(mu.value, 2000) > 1e-9) errs.push('3 亩 应恰为 2000 m²，实得 ' + (mu && mu.value))
        const neg = u.convert('temperature', 'f', 'c', -40)
        if (!neg || Math.abs(neg.value - (-40)) > 1e-9) errs.push('-40°F 应 = -40°C，实得 ' + (neg && neg.value))
        if (!d.result) errs.push('页面无结果（result 为 null），error=' + errText(d))
        else {
          if (kv(d, '英里 → 千米') !== '1.609344') errs.push('页面 1 mi→km 显示应为 1.609344，实得 ' + kv(d, '英里 → 千米'))
          const back = d.result.kv.filter(function (x) { return x.key === '反向换算' })[0]
          if (!back || String(back.value).indexOf('0.6213712 英里') < 0) errs.push('反向 1 km→mi 应显示 0.6213712 英里，实得 ' + (back && back.value))
          if (d.result.text.indexOf('1 英里 = 1.609344 千米') < 0) errs.push('结果文案缺「1 英里 = 1.609344 千米」：' + d.result.text)
          if (d.result.meta.indexOf('长度') !== 0) errs.push('meta 应以类别名「长度」开头：' + d.result.meta)
        }
        return errs
      }
    },
    {
      name: '温度非线性：68°F=20°C、-40°F=-40°C、68°C=154.4°F',
      values: { cat: 'temperature', from: 'f', to: 'c', value: '68', precision: 6 },
      run: 'recompute',
      prepare(inst) {
        probe(inst, 'c2f', { cat: 'temperature', from: 'c', to: 'f', value: '68' }, 'recompute')
        probe(inst, 'neg40', { cat: 'temperature', from: 'f', to: 'c', value: '-40' }, 'recompute')
      },
      expect(d, h, inst) {
        const errs = []
        if (kv(d, '华氏度 °F → 摄氏度 °C') !== '20') errs.push('68°F 应显示 20（°C），实得 ' + kv(d, '华氏度 °F → 摄氏度 °C'))
        const formula = kv(d, '换算公式')
        if (!formula || formula.indexOf('°C = (°F − 32) × 5/9') < 0) errs.push('温度应走独立非线性公式并标注，实得 ' + formula)
        const p = gp(inst, 'c2f')
        if (!p || !p.result) errs.push('68°C→°F 预跑无结果：' + (p && p.error && p.error.message))
        else if (kv(p.data, '摄氏度 °C → 华氏度 °F') !== '154.4') errs.push('68°C 应 = 154.4°F，实得 ' + kv(p.data, '摄氏度 °C → 华氏度 °F'))
        const q = gp(inst, 'neg40')
        if (!q || !q.result) errs.push('-40°F 预跑无结果')
        else if (kv(q.data, '华氏度 °F → 摄氏度 °C') !== '-40') errs.push('-40°F 应 = -40°C，实得 ' + kv(q.data, '华氏度 °F → 摄氏度 °C'))
        return errs
      }
    },
    {
      name: '数据存储 1024 / 1000 双进制与单位名切换',
      values: { cat: 'data', from: 'm', to: 'b', value: '1', precision: 6, dataStd: '1024' },
      run: 'recompute',
      prepare(inst) {
        probe(inst, 'si', { cat: 'data', from: 'm', to: 'b', value: '1', dataStd: '1000' }, 'recompute')
      },
      expect(d, h, inst) {
        const errs = []
        if (kv(d, 'MiB → B') !== '1048576') errs.push('1 MiB 应 = 1048576 B，实得 ' + kv(d, 'MiB → B'))
        const f = kv(d, '换算公式')
        if (!f || f.indexOf('1024') < 0 || f.indexOf('KiB/MiB') < 0) errs.push('1024 进制公式提示应标注 KiB/MiB，实得 ' + f)
        const p = gp(inst, 'si')
        if (!p || !p.result) errs.push('1000 进制预跑无结果')
        else if (kv(p.data, 'MB → B') !== '1000000') errs.push('1 MB(1000) 应 = 1000000 B，实得 ' + kv(p.data, 'MB → B'))
        return errs
      }
    },
    {
      name: '单位不属于当前类别 → 可读错误且无结果',
      values: { cat: 'length', from: 'm', to: 'kg', value: '1', precision: 6 },
      run: 'recompute',
      expect(d, h) {
        const errs = []
        if (d.result !== null) errs.push('非法单位仍产出 result：' + JSON.stringify(d.result))
        if (errCode(d) !== 'PARAM_INVALID') errs.push('非法单位应给 PARAM_INVALID，实得 ' + errText(d))
        if (errMsg(d).indexOf('单位') < 0) errs.push('错误文案应说明单位不属于当前类别，实得：' + errMsg(d))
        const u = h.lib(U_UNITS)
        if (u.convert('length', 'm', 'nope', 1) !== null) errs.push('units.convert 对未知单位应返回 null')
        if (u.formatValue(NaN, 6) !== '—') errs.push('formatValue(NaN) 应返回「—」而非 ' + u.formatValue(NaN, 6))
        return errs
      }
    },
    {
      name: '空值 / 非数字 / 超界数值一律拒绝',
      values: { cat: 'length', from: 'm', to: 'cm', value: 'abc', precision: 6 },
      run: 'recompute',
      prepare(inst) {
        probe(inst, 'empty', { cat: 'length', from: 'm', to: 'cm', value: '' }, 'recompute')
        probe(inst, 'huge', { cat: 'length', from: 'm', to: 'cm', value: '1e19' }, 'recompute')
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('非数字应给 PARAM_INVALID，实得 ' + errText(d))
        const p = gp(inst, 'empty')
        if (!p || errCode(p.data) !== 'INPUT_EMPTY') errs.push('空值应给 INPUT_EMPTY，实得 ' + (p && errCode(p.data)))
        const q = gp(inst, 'huge')
        if (!q || errCode(q.data) !== 'PARAM_INVALID') errs.push('1e19 越界应给 PARAM_INVALID，实得 ' + (q && errCode(q.data)))
        if (dirty(d) || dirty(p.data) || dirty(q.data)) errs.push('异常输入时屏幕上出现 NaN/Infinity')
        return errs
      }
    }
  ],

  /* ============================ calc-date ============================ */
  'calc-date': [
    {
      name: '间隔：2024-01-01~2024-12-31 = 365 天 / 11 个月 30 天 / 52 周余 1 天',
      values: { mode: 'interval', dateA: '2024-01-01', dateB: '2024-12-31' },
      run: 'onRun',
      prepare(inst) {
        probe(inst, 'age', { mode: 'interval', dateA: '1990-05-15', dateB: '2026-10-27' })
        probe(inst, 'neg', { mode: 'interval', dateA: '2024-12-31', dateB: '2024-01-01' })
      },
      expect(d, h, inst) {
        const errs = []
        const cal = h.lib(U_CAL)
        if (kv(d, '相差') !== '11 个月 30 天') errs.push('相差应为「11 个月 30 天」，实得 ' + kv(d, '相差'))
        if (kv(d, '总天数') !== '365 天') errs.push('2024 为闰年，1/1→12/31 日序差应为 365 天，实得 ' + kv(d, '总天数'))
        if (kv(d, '总周数') !== '52 周 余 1 天') errs.push('总周数应为「52 周 余 1 天」，实得 ' + kv(d, '总周数'))
        if (!kv(d, '开始日农历') || String(kv(d, '开始日农历')).indexOf('癸卯') < 0) errs.push('2024-01-01 农历应为癸卯[兔]年冬月二十，实得 ' + kv(d, '开始日农历'))
        if (!kv(d, '结束日农历') || String(kv(d, '结束日农历')).indexOf('甲辰[龙]年 腊月初一') < 0) errs.push('2024-12-31 农历应为甲辰年腊月初一，实得 ' + kv(d, '结束日农历'))
        const p = gp(inst, 'age')
        if (!p || !p.result) errs.push('年龄预跑无结果')
        else if (kv(p.data, '相差') !== '36 年 5 个月 12 天') errs.push('1990-05-15 → 2026-10-27 应为 36 年 5 个月 12 天，实得 ' + kv(p.data, '相差'))
        if (cal.diffDates('1990-05-15', '2026-10-27').totalDays !== 13314) errs.push('两日期日序差应为 13314 天')
        const q = gp(inst, 'neg')
        if (!q || !q.result) errs.push('反向间隔预跑无结果')
        else if (kv(q.data, '总天数') !== '-365 天') errs.push('B−A 反向应给 -365 天，实得 ' + kv(q.data, '总天数'))
        if (!cal.validDate('2024-02-29')) errs.push('2024-02-29 是闰年合法日，validDate 却判非法')
        if (cal.validDate('2023-02-29') !== null) errs.push('2023-02-29 必须判非法')
        if (cal.validDate('2026-02-30') !== null) errs.push('2026-02-30 必须判非法')
        if (cal.validDate('2026-1-3') === null) errs.push('2026-1-3（不补零）应可解析')
        if (cal.isLeap(1900) || !cal.isLeap(2000)) errs.push('世纪年闰法则错：1900 非闰、2000 闰')
        return errs
      }
    },
    {
      name: '加减：闰日 +1 年走月末回退（2024-02-29 → 2025-02-28 周五）',
      values: { mode: 'add', addBase: '2024-02-29', delta: 1, deltaUnit: 'year' },
      run: 'onRun',
      prepare(inst) {
        probe(inst, 'plus30', { mode: 'add', addBase: '2024-03-15', delta: 30, deltaUnit: 'day' })
        probe(inst, 'jan31', { mode: 'add', addBase: '2024-01-31', delta: 1, deltaUnit: 'month' })
        probe(inst, 'minus', { mode: 'add', addBase: '2026-01-01', delta: -45, deltaUnit: 'day' })
      },
      expect(d, h, inst) {
        const errs = []
        const cal = h.lib(U_CAL)
        if (kv(d, '结果日期') !== '2025-02-28') errs.push('2024-02-29 + 1 年应为 2025-02-28，实得 ' + kv(d, '结果日期'))
        if (kv(d, '月末回退') !== '已触发') errs.push('该场景必须提示月末回退已触发，实得 ' + kv(d, '月末回退'))
        if (kv(d, '星期') !== '星期五') errs.push('2025-02-28 是星期五，实得 ' + kv(d, '星期'))
        const p = gp(inst, 'plus30')
        if (!p || kv(p.data, '结果日期') !== '2024-04-14') errs.push('2024-03-15 + 30 天应为 2024-04-14，实得 ' + (p && kv(p.data, '结果日期')))
        if (p && kv(p.data, '星期') !== '星期日') errs.push('2024-04-14 是星期日，实得 ' + (p && kv(p.data, '星期')))
        if (p && kv(p.data, '月末回退') !== '未触发') errs.push('按天加减不应触发月末回退')
        const q = gp(inst, 'jan31')
        if (!q || kv(q.data, '结果日期') !== '2024-02-29') errs.push('2024-01-31 + 1 月应为 2024-02-29（闰年 2 月有 29 天），实得 ' + (q && kv(q.data, '结果日期')))
        const r = gp(inst, 'minus')
        if (!r || kv(r.data, '结果日期') !== '2025-11-17') errs.push('2026-01-01 − 45 天应为 2025-11-17，实得 ' + (r && kv(r.data, '结果日期')))
        if (cal.addDate('2025-01-31', 1, 'month').date !== '2025-02-28') errs.push('2025-01-31 + 1 月应回退到 2025-02-28')
        return errs
      }
    },
    {
      name: '工作日：2026-10 按节假日表 = 18 工作日 / 13 休息（7 假日 + 1 补班）',
      values: { mode: 'workday', start: '2026-10-01', end: '2026-10-31', useHolidays: true },
      run: 'onRun',
      prepare(inst) {
        probe(inst, 'noHol', { mode: 'workday', start: '2026-10-01', end: '2026-10-31', useHolidays: false })
        probe(inst, 'wk', { mode: 'workday', start: '2026-10-26', end: '2026-10-30', useHolidays: true })
      },
      expect(d, h, inst) {
        const errs = []
        // 手算：10/1–10/7 国庆假（含 10/3 周六、10/4 周日）；10/10 周六补班；
        // 周末另有 11、17、18、24、25、31 → 休息 7+6=13，工作 18
        if (kv(d, '总天数') !== '31 天') errs.push('总天数应 31，实得 ' + kv(d, '总天数'))
        if (kv(d, '工作日') !== '18 天') errs.push('工作日应 18 天，实得 ' + kv(d, '工作日'))
        if (kv(d, '休息日') !== '13 天') errs.push('休息日应 13 天，实得 ' + kv(d, '休息日'))
        if (kv(d, '法定假日扣减') !== '7 天') errs.push('法定假日扣减应 7 天，实得 ' + kv(d, '法定假日扣减'))
        if (kv(d, '调休补班计入') !== '1 天') errs.push('调休补班应计入 10/10 一天，实得 ' + kv(d, '调休补班计入'))
        const p = gp(inst, 'noHol')
        if (!p) errs.push('关闭节假日表预跑缺失')
        else {
          if (kv(p.data, '工作日') !== '22 天') errs.push('仅排除周末时 2026-10 应 22 个工作日，实得 ' + kv(p.data, '工作日'))
          if (kv(p.data, '休息日') !== '9 天') errs.push('仅排除周末时应 9 个休息日，实得 ' + kv(p.data, '休息日'))
          if (String(kv(p.data, '数据说明')).indexOf('未启用节假日表') < 0) errs.push('关闭开关后数据说明应标注未启用节假日表')
        }
        const q = gp(inst, 'wk')
        if (!q || kv(q.data, '工作日') !== '5 天') errs.push('2026-10-26~10-30（周一至周五）应 5 个工作日，实得 ' + (q && kv(q.data, '工作日')))
        return errs
      }
    },
    {
      name: '周次与季度：2021-01-01 = ISO 2020-W53、2024-12-30 = 2025-W01',
      values: { mode: 'week', isoDate: '2021-01-01' },
      run: 'onRun',
      prepare(inst) {
        probe(inst, 'xmas', { mode: 'week', isoDate: '2024-12-30' })
        probe(inst, 'today', { mode: 'week', isoDate: '2026-10-27' })
      },
      expect(d, h, inst) {
        const errs = []
        const cal = h.lib(U_CAL)
        if (kv(d, 'ISO 周次') !== '2020-W53-5（2020 年第 53 周）') errs.push('2021-01-01 的 ISO 应为 2020-W53-5，实得 ' + kv(d, 'ISO 周次'))
        if (kv(d, '星期') !== '星期五') errs.push('2021-01-01 是星期五，实得 ' + kv(d, '星期'))
        if (kv(d, '年内天数') !== '1 / 365') errs.push('年内天数应 1 / 365，实得 ' + kv(d, '年内天数'))
        if (kv(d, '季度') !== 'Q1（2021-01-01 ~ 2021-03-31）') errs.push('季度应 Q1，实得 ' + kv(d, '季度'))
        if (kv(d, '本周区间') !== '2020-12-28 ~ 2021-01-03') errs.push('本周区间应 2020-12-28 ~ 2021-01-03，实得 ' + kv(d, '本周区间'))
        if (kv(d, '年中第几周') !== '第 1 周（周日起始）') errs.push('年中第几周应 1，实得 ' + kv(d, '年中第几周'))
        const p = gp(inst, 'xmas')
        if (!p || kv(p.data, 'ISO 周次') !== '2025-W01-1（2025 年第 1 周）') errs.push('2024-12-30 应属 ISO 2025-W01，实得 ' + (p && kv(p.data, 'ISO 周次')))
        const q = gp(inst, 'today')
        if (!q) errs.push('2026-10-27 预跑缺失')
        else {
          if (kv(q.data, 'ISO 周次') !== '2026-W44-2（2026 年第 44 周）') errs.push('2026-10-27 应 ISO 2026-W44-2，实得 ' + kv(q.data, 'ISO 周次'))
          if (kv(q.data, '年内天数') !== '300 / 365') errs.push('2026-10-27 年内天数应 300 / 365，实得 ' + kv(q.data, '年内天数'))
        }
        const cd = cal.countdown('2026-12-31', '2026-10-27', false)
        if (!cd || cd.days !== 65 || cd.status !== 'remaining') errs.push('2026-10-27 距 2026-12-31 应为还剩 65 天，实得 ' + JSON.stringify(cd))
        if (cal.countdown('2026-01-01', '2026-10-27', false).status !== 'passed') errs.push('过去日期应判 passed')
        return errs
      }
    },
    {
      name: '非法日期 / 非数字增减量必须拒绝',
      values: { mode: 'interval', dateA: '2023-02-29', dateB: '2024-01-01' },
      run: 'onRun',
      prepare(inst) {
        probe(inst, 'badDelta', { mode: 'add', addBase: '2024-01-01', delta: 'abc', deltaUnit: 'day' })
        probe(inst, 'badRange', { mode: 'workday', start: '2026-02-30', end: '2026-03-05' })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('2023-02-29 应报 PARAM_INVALID，实得 ' + errText(d))
        if (errMsg(d).indexOf('YYYY-MM-DD') < 0) errs.push('文案应说明日期格式与非法示例，实得：' + errMsg(d))
        if (d.result !== null) errs.push('非法日期不应有 result')
        const p = gp(inst, 'badDelta')
        if (!p || errCode(p.data) !== 'PARAM_INVALID') errs.push('delta=abc 应报 PARAM_INVALID，实得 ' + (p && errCode(p.data)))
        const q = gp(inst, 'badRange')
        if (!q || errCode(q.data) !== 'PARAM_INVALID') errs.push('2026-02-30 应报 PARAM_INVALID，实得 ' + (q && errCode(q.data)))
        return errs
      }
    }
  ]
  ,

  /* ============================ calc-loan ============================ */
  'calc-loan': [
    {
      name: '等额本息 100 万 / 30 年 / 4.9%：月供 5307.27、总息 910616.19',
      values: { type: 'commercial', principal: 1000000, years: 30, method: 'annuity', rate: 4.9, ratePf: 2.85, providentPart: 0 },
      expect(d, h, inst) {
        const errs = []
        // P=1000000 i=0.049/12 n=360 → M = P·i·(1+i)^n/((1+i)^n−1) = 5307.267206 → 5307.27
        const wantMonthly = 5307.27
        const wantInterest = 910616.19 // 360×5307.267206 − 1000000
        const gotM = numOf(kv(d, '月供'))
        if (!(Math.abs(gotM - wantMonthly) < 0.01)) errs.push('月供应为 5307.27 元，实得 ' + kv(d, '月供'))
        if (!(Math.abs(numOf(kv(d, '总利息')) - wantInterest) < 0.01)) errs.push('总利息应为 910616.19 元，实得 ' + kv(d, '总利息'))
        if (!(Math.abs(numOf(kv(d, '总还款')) - 1910616.19) < 0.01)) errs.push('总还款应为 1910616.19 元，实得 ' + kv(d, '总还款'))
        if (d.rowsTotal !== 360) errs.push('明细期数应 360，实得 ' + d.rowsTotal)
        if (d.rows.length !== 20) errs.push('明细应分页 20 期/页，实得 ' + d.rows.length)
        if (Math.abs(numOf(kv(d, '首月还款')) - 5307.27) > 0.01) errs.push('等额本息首月还款应等于月供 5307.27，实得 ' + kv(d, '首月还款'))
        const rows = inst._allRows || []
        if (rows.length !== 360) errs.push('inst._allRows 应 360 期，实得 ' + rows.length)
        else {
          let sum = 0
          for (let i = 0; i < rows.length; i++) {
            sum += rows[i].principalPart
            if (Math.abs(rows[i].payment - (rows[i].principalPart + rows[i].interest)) > 0.011) errs.push('第 ' + rows[i].i + ' 期 月供 ≠ 本金+利息：' + JSON.stringify(rows[i]))
          }
          if (Math.abs(sum - 1000000) > 0.1) errs.push('逐期本金求和应 ≈ 1000000（每期 round2 允许 ±0.1 累积），实得 ' + sum)
          if (rows[359].remain !== 0) errs.push('末期剩余本金应为 0，实得 ' + rows[359].remain)
          if (Math.abs(rows[0].interest - 4083.33) > 0.01) errs.push('首月利息应 1000000×0.049/12 = 4083.33，实得 ' + rows[0].interest)
          if (Math.abs(rows[0].principalPart - 1223.94) > 0.02) errs.push('首月本金应 ≈ 1223.94（5307.27−4083.33），实得 ' + rows[0].principalPart)
        }
        if (String(kv(d, '还款方式对比')).indexOf('等额本金总利息少') < 0) errs.push('缺少两法对比结论')
        return errs
      }
    },
    {
      name: '等额本金 80 万 / 25 年 / 2.85%：首月 4566.67、末月 2673.00、总息 285950.00',
      values: { type: 'commercial', principal: 800000, years: 25, method: 'principal', rate: 2.85, ratePf: 2.85, providentPart: 0 },
      expect(d, h) {
        const errs = []
        // P/n = 2666.6667；首月 = 2666.6667 + 800000×0.002375 = 4566.6667
        // 每月递减 = (P/n)·i = 6.3333；末月 = 2666.6667×(1+0.002375) = 2673.00
        // 总利息 = P·i·(n+1)/2 = 800000×0.002375×150.5 = 285950.00
        if (!(Math.abs(numOf(kv(d, '首月还款')) - 4566.67) < 0.01)) errs.push('首月还款应 4566.67，实得 ' + kv(d, '首月还款'))
        if (!(Math.abs(numOf(kv(d, '末月还款')) - 2673) < 0.01)) errs.push('末月还款应 2673.00，实得 ' + kv(d, '末月还款'))
        if (!(Math.abs(numOf(kv(d, '每月递减')) - 6.33) < 0.01)) errs.push('每月递减应 6.33，实得 ' + kv(d, '每月递减'))
        if (!(Math.abs(numOf(kv(d, '总利息')) - 285950) < 0.01)) errs.push('总利息应 285950.00，实得 ' + kv(d, '总利息'))
        if (d.result && String(d.result.meta).indexOf('300 期 · 等额本金') !== 0) errs.push('meta 应标「300 期 · 等额本金」（25 年 × 12），实得 ' + (d.result && d.result.meta))
        if (kv(d, '月供') !== null) errs.push('等额本金不应输出固定「月供」字段')
        return errs
      }
    },
    {
      name: '组合贷 150 万（公积金 60 万 @2.85 + 商贷 90 万 @4.35）/ 30 年：月供 6961.65',
      values: { type: 'mixed', principal: 1500000, years: 30, method: 'annuity', rate: 4.35, ratePf: 2.85, providentPart: 600000 },
      expect(d, h) {
        const errs = []
        const fin = h.lib(U_FIN)
        const pf = fin.annuitySchedule(600000, 2.85, 360).monthly
        const cm = fin.annuitySchedule(900000, 4.35, 360).monthly
        const want = Math.round((pf + cm) * 100) / 100
        if (Math.abs(want - 6961.65) > 0.01) errs.push('自检失败：分笔月供求和应 6961.65，算得 ' + want)
        const got = numOf(kv(d, '月供'))
        if (!(Math.abs(got - want) < 0.011)) errs.push('组合贷月供应 = 两笔月供之和 ' + want + '，实得 ' + kv(d, '月供'))
        if (String(kv(d, '拆分')).indexOf('公积金 600,000.00') !== 0) errs.push('拆分说明应以「公积金 600,000.00」开头，实得 ' + kv(d, '拆分'))
        if (d.rowsTotal !== 360) errs.push('组合贷明细应 360 期，实得 ' + d.rowsTotal)
        const total = numOf(kv(d, '总还款'))
        if (!(Math.abs(total - (1500000 + numOf(kv(d, '总利息')))) < 0.02)) errs.push('总还款应 = 本金 + 总利息，实得 ' + total)
        return errs
      }
    },
    {
      name: '公积金贷款：把年利率改成 5% 后月供必须按 5% 计算（应 6599.56）',
      values: { type: 'provident', principal: 1000000, years: 20, method: 'annuity', rate: 5, ratePf: 2.85, providentPart: 0 },
      expect(d, h) {
        const errs = []
        const fin = h.lib(U_FIN)
        // 用户在唯一可见的「年利率(%)」里输入 5：P=1000000 i=0.05/12 n=240 → M = 6599.5589 → 6599.56
        const want = fin.annuitySchedule(1000000, 5, 240).monthly
        const got = numOf(kv(d, '月供'))
        if (!(Math.abs(got - want) < 0.01)) {
          errs.push('公积金利率编辑无效：values.rate=5 → 月供应 ' + want + '，实得 ' + kv(d, '月供') +
            '（页面按 effRate=ratePf=2.85 得 ' + fin.annuitySchedule(1000000, 2.85, 240).monthly + '；' +
            'miniprogram/packageCalc/pages/loan/index.js:106 在 type=provident 时忽略可编辑的 rate）')
        }
        return errs
      }
    },
    {
      name: '本金 / 年限 / 利率越界与公积金部分非法 → 可读 PARAM_INVALID',
      values: { type: 'commercial', principal: 5000, years: 20, method: 'annuity', rate: 4.35, ratePf: 2.85, providentPart: 0 },
      prepare(inst) {
        probe(inst, 'years', { type: 'commercial', principal: 1000000, years: 50, rate: 4.35 })
        probe(inst, 'nan', { type: 'commercial', principal: 'abc', years: 20, rate: 4.35 })
        probe(inst, 'zeroRate', { type: 'commercial', principal: 1000000, years: 20, rate: 0 })
        probe(inst, 'mixed', { type: 'mixed', principal: 1000000, years: 20, rate: 4.35, ratePf: 2.85, providentPart: 0 })
        probe(inst, 'bigRate', { type: 'commercial', principal: 1000000, years: 20, rate: 25 })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('本金 5000（<1 万）应报 PARAM_INVALID，实得 ' + errText(d))
        if (errMsg(d).indexOf('本金') < 0) errs.push('文案应说明本金区间，实得：' + errMsg(d))
        if (d.result !== null) errs.push('参数非法时不应产出 result')
        const p = gp(inst, 'years')
        if (!p || errCode(p.data) !== 'PARAM_INVALID') errs.push('50 年越界应报 PARAM_INVALID，实得 ' + (p && errCode(p.data)))
        const q = gp(inst, 'nan')
        if (!q || errCode(q.data) !== 'PARAM_INVALID') errs.push('本金非数字应报 PARAM_INVALID，实得 ' + (q && errCode(q.data)))
        const r = gp(inst, 'mixed')
        if (!r || errCode(r.data) !== 'PARAM_INVALID') errs.push('组合贷公积金部分=0 应报 PARAM_INVALID，实得 ' + (r && errCode(r.data)))
        const s = gp(inst, 'bigRate')
        if (!s || errCode(s.data) !== 'PARAM_INVALID') errs.push('利率 25% 越界应报 PARAM_INVALID，实得 ' + (s && errCode(s.data)))
        const z = gp(inst, 'zeroRate')
        if (!z || !z.result) errs.push('0 利率是合法边界应可计算（预跑失败：' + (z && errCode(z.data)) + '）')
        else {
          if (!(Math.abs(numOf(kv(z.data, '月供')) - 4166.67) < 0.01)) errs.push('0 利率月供应 1000000/240 = 4166.67，实得 ' + kv(z.data, '月供'))
          if (numOf(kv(z.data, '总利息')) !== 0) errs.push('0 利率总利息应为 0，实得 ' + kv(z.data, '总利息'))
        }
        return errs
      }
    }
  ],

  /* ============================ calc-tax ============================ */
  'calc-tax': [
    {
      name: '月薪 2 万（社保 2000+公积金 2200+房贷 1000）：全年预扣 9240.00',
      values: { mode: 'salary', income: 20000, social: 2000, fund: 2200, homeLoan: 1000, child: 0, edu: 0, rent: 0, elderly: 0, infant: 0 },
      expect(d, h) {
        const errs = []
        // 月应税 = 20000 −(5000+2000+2200+1000) = 9800；12 月累计 117600
        // 117600 ∈ (36000,144000] → 117600×0.10 − 2520 = 9240.00
        if (!(Math.abs(numOf(kv(d, '12 月累计预扣税额')) - 9240) < 0.01)) errs.push('全年预扣应 9,240.00 元，实得 ' + kv(d, '12 月累计预扣税额'))
        if (kv(d, '最高预扣档位') !== '10%') errs.push('最高档应 10%，实得 ' + kv(d, '最高预扣档位'))
        if (d.rows.length !== 12) errs.push('逐月表应 12 行，实得 ' + d.rows.length)
        const expectMonth = [294, 294, 294, 518, 980, 980, 980, 980, 980, 980, 980, 980]
        for (let i = 0; i < Math.min(12, d.rows.length); i++) {
          if (Math.abs(numOf(d.rows[i].taxMonth) - expectMonth[i]) > 0.01) errs.push('第 ' + (i + 1) + ' 月预扣应 ' + expectMonth[i] + '，实得 ' + d.rows[i].taxMonth)
          const rateWant = i < 3 ? '3%' : '10%'
          if (d.rows[i].rate !== rateWant) errs.push('第 ' + (i + 1) + ' 月税率应 ' + rateWant + '，实得 ' + d.rows[i].rate)
        }
        let sum = 0
        d.rows.forEach(function (r) { sum += numOf(r.taxMonth) })
        if (Math.abs(sum - 9240) > 0.01) errs.push('逐月预扣求和应 = 9240，实得 ' + sum)
        if (String(kv(d, '每月减除费用')).indexOf('5000 元 + 社保 2,000.00 + 公积金 2,200.00 + 专项附加 1,000.00') < 0) errs.push('减除费用明细不符：' + kv(d, '每月减除费用'))
        return errs
      }
    },
    {
      name: '临界档：月应税 12000，第 3 月累计恰 36000 仍按 3%，全年 11880.00',
      values: { mode: 'salary', income: 17000, social: 0, fund: 0, child: 0, edu: 0, homeLoan: 0, rent: 0, elderly: 0, infant: 0 },
      expect(d, h) {
        const errs = []
        // 月应税 = 17000 − 5000 = 12000；m3 累计 36000（= 一档上限，含）→ 3% → 1080
        // m12 累计 144000（= 二档上限，含）→ 144000×0.1 − 2520 = 11880
        if (numOf(d.rows[2].taxableCum) !== 36000) errs.push('第 3 月累计应税应 36000，实得 ' + d.rows[2].taxableCum)
        if (d.rows[2].rate !== '3%') errs.push('累计恰为 36000 应仍落 3% 档，实得 ' + d.rows[2].rate)
        if (Math.abs(numOf(d.rows[2].taxMonth) - 360) > 0.01) errs.push('第 3 月预扣应 360.00，实得 ' + d.rows[2].taxMonth)
        if (d.rows[3].rate !== '10%') errs.push('第 4 月（累计 48000）应跳 10%，实得 ' + d.rows[3].rate)
        if (Math.abs(numOf(d.rows[3].taxMonth) - 1200) > 0.01) errs.push('第 4 月预扣应 1200.00（2280−1080），实得 ' + d.rows[3].taxMonth)
        if (!(Math.abs(numOf(kv(d, '12 月累计预扣税额')) - 11880) < 0.01)) errs.push('全年应 11,880.00 元，实得 ' + kv(d, '12 月累计预扣税额'))
        if (kv(d, '最高预扣档位') !== '10%') errs.push('最高档应 10%，实得 ' + kv(d, '最高预扣档位'))
        if (String(d.result && d.result.meta).indexOf('CN-2019') < 0) errs.push('meta 应展示税率表版本号，实得 ' + (d.result && d.result.meta))
        return errs
      }
    },
    {
      name: '年终奖单独计税 36000 → 1080.00；36001 跳档 → 3390.10（多缴 2310.10）',
      values: { mode: 'bonus', bonus: 36000, taxableOther: 100000 },
      prepare(inst) {
        probe(inst, 'jump', { mode: 'bonus', bonus: 36001, taxableOther: 100000 })
      },
      expect(d, h, inst) {
        const errs = []
        // 单独计税：36000/12 = 3000 → 月表一档 3% → 1080.00
        if (!(Math.abs(numOf(kv(d, '单独计税税额')) - 1080) < 0.01)) errs.push('36000 单独计税应 1,080.00 元，实得 ' + kv(d, '单独计税税额'))
        if (String(kv(d, '单独计税税额')).indexOf('3% 档') < 0) errs.push('应标注所在档位 3%，实得 ' + kv(d, '单独计税税额'))
        // 并入：annualTax(136000) − annualTax(100000) = 11080 − 7480 = 3600.00
        if (!(Math.abs(numOf(kv(d, '并入综合所得增加税额')) - 3600) < 0.01)) errs.push('并入增加税额应 3,600.00 元，实得 ' + kv(d, '并入综合所得增加税额'))
        if (String(kv(d, '方案建议')).indexOf('单独计税更省') < 0) errs.push('该组数据应建议单独计税，实得 ' + kv(d, '方案建议'))
        // 跳档：36001/12 > 3000 → 10% 档 −210 → 3390.10
        const p = gp(inst, 'jump')
        if (!p || !p.result) errs.push('36001 预跑无结果：' + (p && errCode(p.data)))
        else {
          const t = numOf(kv(p.data, '单独计税税额'))
          if (Math.abs(t - 3390.1) > 0.01) errs.push('36001 单独计税应 3,390.10 元，实得 ' + kv(p.data, '单独计税税额'))
          if (Math.abs((t - 1080) - 2310.1) > 0.01) errs.push('临界点跳档差额应 2310.10 元，实得 ' + (t - 1080))
        }
        return errs
      }
    },
    {
      name: '异常：年终奖 0 / 负收入 / 专项附加超界 / 年终奖超大',
      values: { mode: 'bonus', bonus: 0, taxableOther: 100000 },
      prepare(inst) {
        probe(inst, 'negIncome', { mode: 'salary', income: -1, social: 0, fund: 0 })
        probe(inst, 'bigSpecial', { mode: 'salary', income: 20000, child: 200000 })
        probe(inst, 'bigBonus', { mode: 'bonus', bonus: 30000000, taxableOther: 0 })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('年终奖 0 应报 PARAM_INVALID，实得 ' + errText(d))
        if (errMsg(d).indexOf('年终奖') < 0) errs.push('文案应指向年终奖金额，实得：' + errMsg(d))
        if (d.result !== null) errs.push('非法输入不应产出 result')
        const p = gp(inst, 'negIncome')
        if (!p || errCode(p.data) !== 'PARAM_INVALID') errs.push('负收入应报 PARAM_INVALID，实得 ' + (p && errCode(p.data)))
        const q = gp(inst, 'bigSpecial')
        if (!q || errCode(q.data) !== 'PARAM_INVALID') errs.push('专项附加 20 万越界应报 PARAM_INVALID，实得 ' + (q && errCode(q.data)))
        const r = gp(inst, 'bigBonus')
        if (!r || errCode(r.data) !== 'PARAM_INVALID') errs.push('年终奖 3000 万越界应报 PARAM_INVALID，实得 ' + (r && errCode(r.data)))
        return errs
      }
    }
  ],

  /* ============================ calc-discount ============================ */
  'calc-discount': [
    {
      name: '打折：599 × 8.5 折 = 509.15，省 89.85（15.0%）',
      values: { mode: 'discount', price: 599, zhe: 8.5 },
      prepare(inst) {
        probe(inst, 'zhe1', { mode: 'discount', price: 200, zhe: 1 })
        probe(inst, 'range', { mode: 'discount', price: 100, zhe: 10 })
      },
      expect(d, h, inst) {
        const errs = []
        if (!(Math.abs(numOf(kv(d, '到手价')) - 509.15) < 0.005)) errs.push('到手价应 509.15 元（599×0.85），实得 ' + kv(d, '到手价'))
        if (!(Math.abs(numOf(kv(d, '优惠')) - 89.85) < 0.005)) errs.push('优惠应 89.85 元，实得 ' + kv(d, '优惠'))
        if (kv(d, '相当于省') !== '15.0%') errs.push('省的比例应 15.0%，实得 ' + kv(d, '相当于省'))
        if (String(kv(d, '公式')).indexOf('599 × 8.5 ÷ 10') < 0) errs.push('公式文案应带入原值，实得 ' + kv(d, '公式'))
        const p = gp(inst, 'zhe1')
        if (!p || Math.abs(numOf(kv(p.data, '到手价')) - 20) > 0.005) errs.push('200 元 1 折应 20.00，实得 ' + (p && kv(p.data, '到手价')))
        const q = gp(inst, 'range')
        if (!q || errCode(q.data) !== 'PARAM_INVALID') errs.push('折扣 10 超出 0.1–9.9 应报 PARAM_INVALID，实得 ' + (q && errCode(q.data)))
        return errs
      }
    },
    {
      name: '满减：每满 300 减 50（1000 → 3 次 / 850.00）、单档 950.00、未达门槛原价',
      values: { mode: 'full', price: 1000, threshold: 300, reduce: 50, every: true },
      prepare(inst) {
        probe(inst, 'single', { mode: 'full', price: 1000, threshold: 300, reduce: 50, every: false })
        probe(inst, 'below', { mode: 'full', price: 200, threshold: 300, reduce: 50, every: true })
      },
      expect(d, h, inst) {
        const errs = []
        if (kv(d, '满足次数') !== '3 次（每满循环）') errs.push('floor(1000/300)=3 → 应「3 次（每满循环）」，实得 ' + kv(d, '满足次数'))
        if (!(Math.abs(numOf(kv(d, '到手价')) - 850) < 0.005)) errs.push('到手价应 850.00，实得 ' + kv(d, '到手价'))
        if (!(Math.abs(numOf(kv(d, '共减')) - 150) < 0.005)) errs.push('共减应 150.00，实得 ' + kv(d, '共减'))
        const p = gp(inst, 'single')
        if (!p || Math.abs(numOf(kv(p.data, '到手价')) - 950) > 0.005) errs.push('单档满减应 950.00，实得 ' + (p && kv(p.data, '到手价')))
        if (p && kv(p.data, '满足次数') !== '1 次（单档）') errs.push('单档满足次数应 1 次（单档），实得 ' + (p && kv(p.data, '满足次数')))
        const q = gp(inst, 'below')
        if (!q || Math.abs(numOf(kv(q.data, '到手价')) - 200) > 0.005) errs.push('未达门槛应维持原价 200.00，实得 ' + (q && kv(q.data, '到手价')))
        if (q && String(kv(q.data, '提示')).indexOf('未达门槛') < 0) errs.push('未达门槛应给出提示，实得 ' + (q && kv(q.data, '提示')))
        return errs
      }
    },
    {
      name: '含税反算：11300 @13% → 10000.00 + 税 1300.00，验算闭环',
      values: { mode: 'tax', priceTax: 11300, taxRate: 13 },
      prepare(inst) {
        probe(inst, 'zeroTax', { mode: 'tax', priceTax: 10000, taxRate: 0 })
        probe(inst, 'odd', { mode: 'tax', priceTax: 9999, taxRate: 9 })
      },
      expect(d, h, inst) {
        const errs = []
        if (!(Math.abs(numOf(kv(d, '不含税价')) - 10000) < 0.005)) errs.push('不含税价应 10,000.00，实得 ' + kv(d, '不含税价'))
        if (!(Math.abs(numOf(kv(d, '税额')) - 1300) < 0.005)) errs.push('税额应 1,300.00，实得 ' + kv(d, '税额'))
        if (String(kv(d, '验算')).indexOf('= 11,300.00 元') < 0) errs.push('验算应回到 11300.00，实得 ' + kv(d, '验算'))
        const p = gp(inst, 'zeroTax')
        if (p && Math.abs(numOf(kv(p.data, '税额')) - 0) > 0.005) errs.push('0 税率时税额应为 0.00，实得 ' + kv(p.data, '税额'))
        const q = gp(inst, 'odd')
        if (q) {
          // 9999/1.09 = 9173.394495… → 9173.39；税额 825.61
          if (Math.abs(numOf(kv(q.data, '不含税价')) - 9173.39) > 0.005) errs.push('9999@9% 不含税应 9,173.39，实得 ' + kv(q.data, '不含税价'))
          if (Math.abs(numOf(kv(q.data, '税额')) - 825.61) > 0.005) errs.push('税额应 825.61，实得 ' + kv(q.data, '税额'))
        }
        return errs
      }
    },
    {
      name: '多档对比：可解析档位给到手价与最优结论',
      values: { mode: 'multi', price: 1000, optionsText: '满500减60\n8折\n每满300减50' },
      expect(d, h) {
        const errs = []
        // 满500减60 → 940；8折 → 800；每满300减50 → 1000−3×50 = 850 → 最优 8 折
        if (String(kv(d, '满500减60')) !== '到手 940.00 元') errs.push('满500减60 应到手 940.00，实得 ' + kv(d, '满500减60'))
        if (String(kv(d, '8折')).indexOf('到手 800.00 元') !== 0) errs.push('8折 应到手 800.00 并标最优，实得 ' + kv(d, '8折'))
        if (String(kv(d, '每满300减50')) !== '到手 850.00 元') errs.push('每满300减50 应到手 850.00，实得 ' + kv(d, '每满300减50'))
        if (String(kv(d, '最优结论')).indexOf('8折') < 0 || String(kv(d, '最优结论')).indexOf('800.00') < 0) errs.push('最优结论应为 8折 / 800.00，实得 ' + kv(d, '最优结论'))
        if (String(d.result.meta).indexOf('3 档对比') !== 0) errs.push('meta 应说明 3 档对比，实得 ' + d.result.meta)
        return errs
      }
    },
    {
      name: '多档对比：默认示例文本里的「打8折」必须与「N折」同样可解析',
      values: { mode: 'multi', price: 1000, optionsText: '满1000减120\n满500减60\n满3000减450\n打8折' },
      expect(d, h) {
        const errs = []
        if (!d.result) { errs.push('默认示例档位无法解析（error=' + errText(d) + '）'); return errs }
        const n = Number(String(d.result.meta).split(' ')[0])
        if (n !== 4) errs.push('输入 4 行优惠应解析出 4 档（meta 显示「4 档对比」），实得「' + d.result.meta + '」：' +
          'miniprogram/packageCalc/pages/discount/index.js:50-56 的 parseOptions 只认「满X减Y / 每满X减Y / N折」，' +
          '「打8折」这类常见写法（也是本页 defaults() 与 samples[0] 自带的写法）被无声丢弃，用户看到的对比表少一档且毫无提示')
        if (kv(d, '打8折') === null) errs.push('「打8折」这一档应出现在结果里（到手价 800.00），实得缺失')
        return errs
      }
    },
    {
      name: '异常：原价 0 / 负数 / 负税率 / 档位一行都解析不出 / 门槛 0',
      values: { mode: 'discount', price: 0, zhe: 8.5 },
      prepare(inst) {
        probe(inst, 'neg', { mode: 'discount', price: -50, zhe: 8.5 })
        probe(inst, 'taxNeg', { mode: 'tax', priceTax: 11300, taxRate: -3 })
        probe(inst, 'optBad', { mode: 'multi', price: 100, optionsText: '买一送一\n第二件半价' })
        probe(inst, 'thZero', { mode: 'full', price: 100, threshold: 0, reduce: 10, every: true })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('原价 0 应报 PARAM_INVALID，实得 ' + errText(d))
        if (d.result !== null) errs.push('非法原价不应产出 result')
        const cases = [['neg', '原价负数'], ['taxNeg', '负税率'], ['optBad', '无法解析的档位'], ['thZero', '满减门槛为 0']]
        for (let i = 0; i < cases.length; i++) {
          const p = gp(inst, cases[i][0])
          if (!p) { errs.push(cases[i][1] + ' 预跑缺失'); continue }
          if (errCode(p.data) !== 'PARAM_INVALID') errs.push(cases[i][1] + ' 应报 PARAM_INVALID，实得 ' + (p.result ? '却产出了 ' + JSON.stringify(p.result.kv) : String(errCode(p.data))))
          if (p.error && (!p.error.message || p.error.message.length < 4)) errs.push(cases[i][1] + ' 缺少可读文案')
        }
        return errs
      }
    }
  ],

  /* ============================ calc-percent ============================ */
  'calc-percent': [
    {
      name: '求百分比：45÷60 = 75%、1÷3 = 33.3333%、2÷7 = 28.5714%',
      values: { mode: 'percent', a: 45, b: 60 },
      prepare(inst) {
        probe(inst, 'third', { mode: 'percent', a: 1, b: 3 })
        probe(inst, 'seventh', { mode: 'percent', a: 2, b: 7 })
      },
      expect(d, h, inst) {
        const errs = []
        if (kv(d, '占比') !== '75%') errs.push('45 是 60 的 75%，实得 ' + kv(d, '占比'))
        if (String(kv(d, '分式')).indexOf('= 0.75') < 0) errs.push('分式应给 0.75，实得 ' + kv(d, '分式'))
        if (String(kv(d, '反向')).indexOf('回到 45') < 0) errs.push('反向校验应回到 45，实得 ' + kv(d, '反向'))
        const p = gp(inst, 'third')
        if (!p || kv(p.data, '占比') !== '33.3333%') errs.push('1÷3 应显示 33.3333%（4 位小数四舍五入），实得 ' + (p && kv(p.data, '占比')))
        const q = gp(inst, 'seventh')
        if (!q || kv(q.data, '占比') !== '28.5714%') errs.push('2÷7 = 28.571428…% → 应 28.5714%，实得 ' + (q && kv(q.data, '占比')))
        return errs
      }
    },
    {
      name: '增长率：320→405 = +26.5625%、405→320 = −20.9877%（下降）',
      values: { mode: 'growth', a: 320, b: 405 },
      prepare(inst) {
        probe(inst, 'down', { mode: 'growth', a: 405, b: 320 })
      },
      expect(d, h, inst) {
        const errs = []
        // (405−320)/320 = 85/320 = 0.265625 → 26.5625%
        if (kv(d, '增长率') !== '26.5625%（增长）') errs.push('增长率应 26.5625%（增长），实得 ' + kv(d, '增长率'))
        if (String(kv(d, '变化量')).indexOf('85（320 → 405）') < 0) errs.push('变化量应 85（320 → 405），实得 ' + kv(d, '变化量'))
        if (String(kv(d, '终值倍率')).indexOf('1.265625 倍') < 0) errs.push('终值倍率应 1.265625 倍，实得 ' + kv(d, '终值倍率'))
        const p = gp(inst, 'down')
        if (!p) errs.push('下降场景预跑缺失')
        else {
          if (kv(p.data, '增长率') !== '-20.9877%（下降）') errs.push('(320−405)/405 = −20.9877% → 实得 ' + kv(p.data, '增长率'))
          if (String(kv(p.data, '变化量')).indexOf('-85') < 0) errs.push('变化量应为 −85，实得 ' + kv(p.data, '变化量'))
        }
        return errs
      }
    },
    {
      name: '比例分配：1000 按 1:1:1 → 333.33/333.33/333.34，合计恒等于 1000.00',
      values: { mode: 'share', total: 1000, weightsText: '甲:1\n乙:1\n丙:1', decimals: 2 },
      prepare(inst) {
        probe(inst, 'ratio', { mode: 'share', total: 1000, weightsText: '张三:1\n李四:2\n王五:2', decimals: 2 })
        probe(inst, 'one', { mode: 'share', total: 100, weightsText: '甲:1\n乙:1\n丙:1', decimals: 2 })
        probe(inst, 'd0', { mode: 'share', total: 10, weightsText: '甲:2\n乙:1', decimals: 0 })
      },
      expect(d, h, inst) {
        const errs = []
        if (String(kv(d, '甲')).indexOf('333.33') !== 0) errs.push('甲应分得 333.33，实得 ' + kv(d, '甲'))
        if (String(kv(d, '乙')).indexOf('333.33') !== 0) errs.push('乙应分得 333.33，实得 ' + kv(d, '乙'))
        if (String(kv(d, '丙')).indexOf('333.34') !== 0) errs.push('末项应吸收舍入差得 333.34，实得 ' + kv(d, '丙'))
        if (kv(d, '合计') !== '1000.00') errs.push('合计应恰为 1000.00，实得 ' + kv(d, '合计'))
        if (String(kv(d, '校验')).indexOf('Σ分配 = 总量') < 0) errs.push('校验应声明和恒等于总量，实得 ' + kv(d, '校验'))
        if (String(kv(d, '甲')).indexOf('33.33%') < 0) errs.push('权重占比应显示 33.33%，实得 ' + kv(d, '甲'))
        const p = gp(inst, 'ratio')
        if (!p) errs.push('1:2:2 预跑缺失')
        else {
          if (String(kv(p.data, '张三')).indexOf('200.00') !== 0) errs.push('1000×1/5 应 200.00，实得 ' + kv(p.data, '张三'))
          if (String(kv(p.data, '李四')).indexOf('400.00') !== 0) errs.push('1000×2/5 应 400.00，实得 ' + kv(p.data, '李四'))
        }
        const q = gp(inst, 'one')
        if (q && kv(q.data, '合计') !== '100.00') errs.push('100 三等分合计仍须为 100.00，实得 ' + kv(q.data, '合计'))
        const r = gp(inst, 'd0')
        if (!r) errs.push('0 位小数预跑缺失')
        else {
          if (String(kv(r.data, '甲')).indexOf('7') !== 0) errs.push('10 按 2:1 取整，甲应 7，实得 ' + kv(r.data, '甲'))
          if (String(kv(r.data, '合计')) !== '10') errs.push('0 位小数合计应为 10，实得 ' + kv(r.data, '合计'))
        }
        return errs
      }
    },
    {
      name: '倍数：10÷3 = 3.333333 倍余 1，A 比 B 多 233.3333%',
      values: { mode: 'multiple', a: 10, b: 3 },
      prepare(inst) {
        probe(inst, 'negBase', { mode: 'multiple', a: 10, b: -2 })
        probe(inst, 'less', { mode: 'multiple', a: 3, b: 12 })
      },
      expect(d, h, inst) {
        const errs = []
        if (kv(d, '倍数') !== '3.333333 倍') errs.push('10÷3 应显示 3.333333 倍，实得 ' + kv(d, '倍数'))
        if (kv(d, '整除部分') !== '3 倍余 1') errs.push('整除部分应「3 倍余 1」，实得 ' + kv(d, '整除部分'))
        if (kv(d, 'A 比 B') !== '233.3333%多') errs.push('A 比 B 多应 233.3333%多，实得 ' + kv(d, 'A 比 B'))
        const p = gp(inst, 'negBase')
        if (p && kv(p.data, '倍数') !== '-5 倍') errs.push('10÷(−2) 应 −5 倍，实得 ' + kv(p.data, '倍数'))
        const q = gp(inst, 'less')
        if (q && String(kv(q.data, 'A 比 B')).indexOf('少') < 0) errs.push('3 是 12 的 25% → 应判「少」，实得 ' + kv(q.data, 'A 比 B'))
        return errs
      }
    },
    {
      name: '异常：基准 0 / 起始 0 / 权重不足 2 项 / 权重和为 0 / 权重为负',
      values: { mode: 'percent', a: 45, b: 0 },
      prepare(inst) {
        probe(inst, 'growthZero', { mode: 'growth', a: 0, b: 100 })
        probe(inst, 'oneWeight', { mode: 'share', total: 100, weightsText: '甲:1' })
        probe(inst, 'zeroWeight', { mode: 'share', total: 100, weightsText: '甲:0\n乙:0' })
        probe(inst, 'negWeight', { mode: 'share', total: 100, weightsText: '甲:1\n乙:-2' })
        probe(inst, 'bigTotal', { mode: 'share', total: 1e13, weightsText: '甲:1\n乙:1' })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('基准 B=0 应报 PARAM_INVALID，实得 ' + errText(d))
        if (errMsg(d).indexOf('基准值') < 0) errs.push('文案应指向基准值不能为 0，实得：' + errMsg(d))
        if (d.result !== null) errs.push('除零场景不应产出 result（更不能出现 Infinity）')
        const names = { growthZero: '增长率起始 0', oneWeight: '权重只有 1 项', zeroWeight: '权重全 0', negWeight: '权重为负', bigTotal: '总量 1e13 越界' }
        Object.keys(names).forEach(function (k) {
          const p = gp(inst, k)
          if (!p) { errs.push(names[k] + ' 预跑缺失'); return }
          if (errCode(p.data) !== 'PARAM_INVALID') errs.push(names[k] + ' 应报 PARAM_INVALID，实得 ' + JSON.stringify(p.data.result))
          if (dirty(p.data)) errs.push(names[k] + ' 场景屏上出现 NaN/Infinity')
        })
        return errs
      }
    }
  ]
  ,

  /* ============================ calc-random ============================ */
  'calc-random': [
    {
      name: '随机整数 1–100 抽 5 个：数量对、不越界、同种子同序列',
      values: { mode: 'int', min: 1, max: 100, count: 5 },
      prepare(inst, h) {
        const rnd = h.lib(U_RND)
        // 同一种子播两次必须得到同一序列（xorshift 确定性 PRNG）
        const seed = [1, 2, 3, 4, 5, 6, 7, 8]
        rnd.seedFromWx(seed)
        const a = []
        for (let i = 0; i < 12; i++) a.push(rnd.intIn(1, 6))
        rnd.seedFromWx(seed)
        const b = []
        for (let i = 0; i < 12; i++) b.push(rnd.intIn(1, 6))
        inst.__probe_seed = { a: a, b: b }
        // 200 轮真跑页面入口，逐轮检查边界与个数
        const rounds = []
        for (let k = 0; k < 200; k++) {
          inst.onRun()
          rounds.push(picked(kv(inst.data, '结果')))
        }
        inst.__probe_rounds = rounds
      },
      expect(d, h, inst) {
        const errs = []
        const val = kv(d, '结果')
        const list = picked(val)
        if (list.length !== 5) errs.push('count=5 应输出 5 个数，实得 ' + list.length + '：' + val)
        const bad = allIn(list, 1, 100)
        if (bad !== null) errs.push('随机整数越界/非数字：' + bad + '（区间 [1,100]）')
        if (list.some(function (x) { return !/^-?\d+$/.test(x) })) errs.push('随机整数出现小数：' + val)
        if (kv(d, '范围') !== '[1, 100]') errs.push('范围回显应 [1, 100]，实得 ' + kv(d, '范围'))
        const rounds = inst.__probe_rounds || []
        if (rounds.length !== 200) errs.push('压测轮数不足：' + rounds.length)
        for (let i = 0; i < rounds.length; i++) {
          if (rounds[i].length !== 5) { errs.push('第 ' + (i + 1) + ' 轮输出 ' + rounds[i].length + ' 个（应 5 个）'); break }
          const b = allIn(rounds[i], 1, 100)
          if (b !== null) { errs.push('第 ' + (i + 1) + ' 轮出现越界值 ' + b); break }
        }
        const seen = {}
        rounds.forEach(function (r) { r.forEach(function (x) { seen[x] = true }) })
        if (Object.keys(seen).length < 20) errs.push('200 轮 ×5 次采样只覆盖 ' + Object.keys(seen).length + ' 个不同值，分布可疑（1–100 应明显更分散）')
        const s = inst.__probe_seed
        if (!s) errs.push('种子可复现预跑缺失')
        else if (JSON.stringify(s.a) !== JSON.stringify(s.b)) errs.push('同一 seedFromWx 种子两次生成的序列不一致：' + s.a.join(',') + ' vs ' + s.b.join(','))
        return errs
      }
    },
    {
      name: '不重复整数：1–10 抽 10 个恰好覆盖 1..10；抽 11 个拒绝',
      values: { mode: 'unique', min: 1, max: 10, count: 10 },
      prepare(inst) {
        probe(inst, 'over', { mode: 'unique', min: 1, max: 10, count: 11 })
        probe(inst, 'small', { mode: 'unique', min: 1, max: 10, count: 5 })
        probe(inst, 'negRange', { mode: 'unique', min: -5, max: -1, count: 5 })
      },
      expect(d, h, inst) {
        const errs = []
        const list = picked(kv(d, '结果'))
        if (list.length !== 10) errs.push('1–10 抽 10 应得 10 项，实得 ' + list.length)
        if (distinctCount(list) !== list.length) errs.push('不重复模式出现重复：' + list.join('、'))
        const sorted = list.map(Number).sort(function (a, b) { return a - b })
        if (sorted.join(',') !== '1,2,3,4,5,6,7,8,9,10') errs.push('1–10 抽满 10 个去重后应覆盖 1..10，实得 ' + sorted.join(','))
        if (String(kv(d, '去重校验')).indexOf('10 项互不相同') < 0) errs.push('去重校验文案应确认 10 项互不相同，实得 ' + kv(d, '去重校验'))
        const p = gp(inst, 'over')
        if (!p || errCode(p.data) !== 'PARAM_INVALID') errs.push('count=11 超出区间应报 PARAM_INVALID，实得 ' + (p && errCode(p.data)))
        if (p && p.result) errs.push('count=11 越界时不应产出 result：' + JSON.stringify(p.result))
        const q = gp(inst, 'small')
        if (q) {
          const l2 = picked(kv(q.data, '结果'))
          if (l2.length !== 5 || distinctCount(l2) !== 5) errs.push('抽 5 个应 5 项互不相同，实得 ' + l2.join('、'))
        }
        const r = gp(inst, 'negRange')
        if (r && allIn(picked(kv(r.data, '结果')), -5, -1) !== null) errs.push('负区间 [-5,-1] 抽取越界：' + kv(r.data, '结果'))
        return errs
      }
    },
    {
      name: '分组抽签：8 人每组 3 → 3 组（3/3/2），不重不漏',
      values: { mode: 'group', listText: 'A1\nA2\nB1\nB2\nC1\nC2\nD1\nD2', groupSize: 3 },
      prepare(inst) {
        probe(inst, 'g1', { mode: 'group', listText: 'A1\nA2\nB1', groupSize: 1 })
        probe(inst, 'skip', { mode: 'group', listText: 'A1\nA2\n重复\n重复', exclude: '重复', groupSize: 2 })
      },
      expect(d, h, inst) {
        const errs = []
        const groups = (d.result.kv || []).filter(function (x) { return /^第 \d+ 组/.test(x.key) })
        if (groups.length !== 3) errs.push('ceil(8/3)=3 组，实得 ' + groups.length)
        const sizes = groups.map(function (g) { return picked(g.value).length })
        if (sizes.join(',') !== '3,3,2') errs.push('各组人数应 3,3,2，实得 ' + sizes.join(','))
        if (kv(d, '总人数') !== '8 人 / 3 组') errs.push('总人数文案应「8 人 / 3 组」，实得 ' + kv(d, '总人数'))
        const flat = []
        groups.forEach(function (g) { flat.push.apply(flat, picked(g.value)) })
        if (distinctCount(flat) !== 8) errs.push('分组出现重复/遗漏，去重后 ' + distinctCount(flat) + ' 人')
        ;['A1', 'A2', 'B1', 'B2', 'C1', 'C2', 'D1', 'D2'].forEach(function (n) {
          if (flat.indexOf(n) < 0) errs.push('名单成员 ' + n + ' 未出现在任何组')
        })
        const p = gp(inst, 'g1')
        if (p && p.result && String(kv(p.data, '总人数')) !== '3 人 / 3 组') errs.push('groupSize=1 时 3 人应分 3 组，实得 ' + kv(p.data, '总人数'))
        const q = gp(inst, 'skip')
        if (!q || !q.result) errs.push('排除+重复行清洗预跑失败：' + (q && errCode(q.data)))
        else if (String(kv(q.data, '总人数')).indexOf('2 人') !== 0) errs.push('重复行与排除项应被剔除（A1/A2/重复×2 排除「重复」后剩 2 人），实得 ' + kv(q.data, '总人数'))
        return errs
      }
    },
    {
      name: '名单抽取跨轮不重复：6 人抽 2 → 剩 4 → 剩 2，两轮无交集',
      values: { mode: 'pick', listText: '甲\n乙\n丙\n丁\n戊\n己', count: 2, noRepeat: true },
      prepare(inst) {
        probe(inst, 'r1', { mode: 'pick', listText: '甲\n乙\n丙\n丁\n戊\n己', count: 2, noRepeat: true })
        probe(inst, 'indep', { mode: 'pick', listText: '甲\n乙\n丙\n丁\n戊\n己', count: 2, noRepeat: false })
      },
      expect(d, h, inst) {
        const errs = []
        const p = gp(inst, 'r1')
        if (!p || !p.result) { errs.push('第一轮预跑失败'); return errs }
        const r1 = picked(kv(p.data, '本轮抽出'))
        const r2 = picked(kv(d, '本轮抽出'))
        if (r1.length !== 2 || r2.length !== 2) errs.push('每轮应抽 2 个：r1=' + r1.length + ' r2=' + r2.length)
        if (kv(p.data, '剩余候选') !== '4 项') errs.push('第一轮后剩余应 4 项，实得 ' + kv(p.data, '剩余候选'))
        if (kv(d, '剩余候选') !== '2 项') errs.push('第二轮后剩余应 2 项，实得 ' + kv(d, '剩余候选'))
        const overlap = r1.filter(function (x) { return r2.indexOf(x) >= 0 })
        if (overlap.length) errs.push('跨轮不重复失效，两轮重复抽中：' + overlap.join('、'))
        const all = r1.concat(r2)
        if (distinctCount(all) !== 4) errs.push('两轮合计应有 4 个不同的人，实得 ' + distinctCount(all))
        if (all.some(function (x) { return ['甲', '乙', '丙', '丁', '戊', '己'].indexOf(x) < 0 })) errs.push('抽出名单外的人：' + all.join('、'))
        const q = gp(inst, 'indep')
        if (q && String(kv(q.data, '名单总数')).indexOf('每轮独立') < 0) errs.push('关闭不重复时应说明每轮独立，实得 ' + kv(q.data, '名单总数'))
        return errs
      }
    },
    {
      name: '转盘：先算结果后播动画，停止位置即中奖扇区',
      values: { mode: 'wheel', listText: '甲\n乙\n丙\n丁\n戊\n己', noRepeat: true },
      noRun: true,
      allowTimeout: true,
      async prepare(inst, h) {
        inst.onRun()
        inst.__probe_busy = { busy: inst.data.busy, hasResult: !!inst.data.result, sectors: inst.data.wheelSectors.length }
        await h.tick(2500)
      },
      expect(d, h, inst) {
        const errs = []
        const p = inst.__probe_busy || {}
        if (p.hasResult) errs.push('转盘应「先算后转」：动画结束前不应已有结果')
        if (!d.result) { errs.push('动画时长后仍未落定结果（busy=' + d.busy + '）'); return errs }
        if (d.busy !== false) errs.push('结果出来后 busy 应复位，实得 ' + d.busy)
        const winner = kv(d, '中奖')
        const items = ['甲', '乙', '丙', '丁', '戊', '己']
        if (items.indexOf(winner) < 0) errs.push('中奖者不在名单内：' + winner)
        if (kv(d, '扇区数') !== '6（等权重）') errs.push('扇区数应 6（等权重），实得 ' + kv(d, '扇区数'))
        if (kv(d, '剩余候选') !== '5 项') errs.push('开启跨轮不重复后中奖者应出池，剩 5 项，实得 ' + kv(d, '剩余候选'))
        if (d.wheelSectors.length !== 6) errs.push('wheelSectors 应 6 项，实得 ' + d.wheelSectors.length)
        const m = /rotate\((-?[\d.]+)deg\)/.exec(String(d.wheelStyle))
        if (!m) errs.push('wheelStyle 缺 rotate 角度：' + d.wheelStyle)
        else {
          const rot = Number(m[1])
          const sector = 360 / items.length
          const center = items.indexOf(winner) * sector + sector / 2
          const landed = ((center + rot) % 360 + 360) % 360
          if (Math.min(landed, 360 - landed) > 1e-6) errs.push('指针（0°）未停在中奖扇区中心：中心 ' + center + '° + 旋转 ' + rot + '° → 偏差 ' + landed.toFixed(6) + '°')
          if (rot < 1800) errs.push('旋转圈数不足（应 ≥ 5 圈 + 落点），实得 ' + rot + '°')
        }
        if (String(d.wheelStyle).indexOf('conic-gradient') < 0) errs.push('wheelStyle 应含 conic-gradient 扇区着色')
        if (!/transition: transform 2\.2s/.test(String(d.wheelStyle))) errs.push('动画时长应 ≥1.5s（规格），实得 ' + d.wheelStyle)
        return errs
      }
    },
    {
      name: '异常：min>max / 名单有效项不足 / 排除项清空名单 / 候选池已抽空',
      values: { mode: 'int', min: 10, max: 1, count: 3 },
      prepare(inst) {
        probe(inst, 'few', { mode: 'wheel', listText: '甲', exclude: '' })
        probe(inst, 'dup', { mode: 'group', listText: '甲\n甲\n甲', groupSize: 2 })
        probe(inst, 'excluded', { mode: 'pick', listText: '甲\n乙', exclude: '甲、乙', count: 1 })
        probe(inst, 'badList', { mode: 'pick', listText: '', count: 1 })
        inst._remaining = []
        inst._sig = '甲|乙|丙|丁|戊|己'.length + ':6'
        probe(inst, 'emptyPool', { mode: 'pick', listText: '甲\n乙\n丙\n丁\n戊\n己', count: 2, noRepeat: true })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('min>max 应报 PARAM_INVALID，实得 ' + errText(d))
        if (errMsg(d).indexOf('最小值') < 0) errs.push('文案应说明最小值不大于最大值，实得：' + errMsg(d))
        if (d.result !== null) errs.push('非法区间不应产出 result')
        const map = { few: '转盘名单只有 1 项', dup: '重复行去重后只剩 1 项', excluded: '排除项吃掉整个名单', badList: '空名单', emptyPool: '候选池已抽空' }
        Object.keys(map).forEach(function (k) {
          const p = gp(inst, k)
          if (!p) { errs.push(map[k] + ' 预跑缺失'); return }
          if (errCode(p.data) !== 'PARAM_INVALID') errs.push(map[k] + ' 应报 PARAM_INVALID，实得 ' + (p.result ? '却产出了结果 ' + JSON.stringify(p.result.kv) : String(errCode(p.data))))
          if (!p.error || !p.error.message || p.error.message.length < 4) errs.push(map[k] + ' 缺少可读文案')
        })
        return errs
      }
    }
  ],

  /* ============================ calc-bmi ============================ */
  'calc-bmi': [
    {
      name: '70kg / 1.75m → BMI 22.9（手算 22.857）正常，BMR 1649 / TDEE 2267',
      values: { sex: 'male', age: 30, height: 175, weight: 70, neck: 0, waist: 0, hip: 0, act: '1.375', goal: 'maintain' },
      expect(d, h) {
        const errs = []
        // BMI = 70 / 1.75² = 22.857142… → 1 位小数 22.9，落 18.5–23.9 → 正常
        if (String(kv(d, 'BMI')).indexOf('22.9（正常）') !== 0) errs.push('BMI 应显示「22.9（正常）」，实得 ' + kv(d, 'BMI'))
        // 健康体重区间：18.5×3.0625 = 56.65625 → 56.7；23.9×3.0625 = 73.19375 → 73.2
        if (kv(d, '健康体重区间') !== '56.7 ~ 73.2 kg') errs.push('健康体重区间应 56.7 ~ 73.2 kg，实得 ' + kv(d, '健康体重区间'))
        // BMR = 10×70 + 6.25×175 − 5×30 + 5 = 1648.75 → 1649
        if (kv(d, 'BMR（Mifflin-St Jeor）') !== '1649 kcal/天') errs.push('BMR 应 1649 kcal/天，实得 ' + kv(d, 'BMR（Mifflin-St Jeor）'))
        // TDEE = 1648.75 × 1.375 = 2267.03125 → 2267
        if (kv(d, 'TDEE') !== '2267 kcal/天（系数 1.375）') errs.push('TDEE 应 2267 kcal/天，实得 ' + kv(d, 'TDEE'))
        if (String(kv(d, '建议热量')).indexOf('2267 kcal/天（维持当前体重）') < 0) errs.push('维持目标建议热量应等于 TDEE 且文案为「2267 kcal/天（维持当前体重）」，实得 ' + kv(d, '建议热量') + '（页面把 goalDelta=0 也拼上数值 →「（维持0）」，miniprogram/packageCalc/pages/bmi/index.js:114）')
        // 蛋白质 = 70 × 1.2 = 84 g
        if (String(kv(d, '建议蛋白质')).indexOf('84 g/天') !== 0) errs.push('维持期蛋白质应 84 g/天（1.2 g/kg），实得 ' + kv(d, '建议蛋白质'))
        if (String(kv(d, '体脂率（US Navy）')).indexOf('未填围度') < 0) errs.push('未填围度应明确跳过体脂，实得 ' + kv(d, '体脂率（US Navy）'))
        if (String(kv(d, '说明')).indexOf('不构成医疗建议') < 0) errs.push('必须含「不构成医疗建议」免责声明（FR-CAL-09），实得 ' + kv(d, '说明'))
        if (String(d.result.meta).indexOf('BMI 22.9 · 正常') !== 0) errs.push('meta 应回显 BMI 与等级，实得 ' + d.result.meta)
        return errs
      }
    },
    {
      name: 'BMI 分级边界：18.5 / 24 / 28 阈值按中国标准',
      values: { sex: 'male', age: 30, height: 100, weight: 20, neck: 0, waist: 0, hip: 0, act: '1.2', goal: 'maintain' },
      prepare(inst) {
        // height=100cm → h²=1 → BMI 数值 = 体重数值，便于逐点验证阈值
        const cases = [[20, '20.0（正常）'], [23.9, '23.9（正常）'], [24, '24.0（超重）'], [27.9, '27.9（超重）'], [28, '28.0（肥胖）']]
        inst.__probe_grades = []
        cases.forEach(function (c) {
          const snap = probe(inst, 'g' + c[0], { sex: 'male', height: 100, weight: c[0], neck: 0, waist: 0, hip: 0 })
          inst.__probe_grades.push({ w: c[0], want: c[1], got: kv(snap.data, 'BMI'), err: snap.error && snap.error.message })
        })
        const lean = probe(inst, 'lean', { sex: 'male', height: 175, weight: 50, neck: 0, waist: 0, hip: 0 })
        inst.__probe_lean = { got: kv(lean.data, 'BMI') }
      },
      expect(d, h, inst) {
        const errs = []
        ;(inst.__probe_grades || []).forEach(function (r) {
          if (!r.got) { errs.push('体重 ' + r.w + 'kg（h=1m → BMI=' + r.w + '）无结果：' + r.err); return }
          if (r.got !== r.want) errs.push('体重 ' + r.w + 'kg → BMI 应「' + r.want + '」，实得「' + r.got + '」')
        })
        if (String(kv(d, 'BMI')).indexOf('20.0（正常）') !== 0) errs.push('主场景 BMI 20.0 应判正常，实得 ' + kv(d, 'BMI'))
        if (inst.__probe_lean && inst.__probe_lean.got !== '16.3（偏瘦）') errs.push('50kg/1.75m = 16.33 应判偏瘦，实得 ' + inst.__probe_lean.got)
        return errs
      }
    },
    {
      name: '体脂率：US Navy 公制公式（男 腰88/颈38/172 → 19.8%（常数按英寸定义，输入已换算））',
      values: { sex: 'male', age: 30, height: 172, weight: 75, neck: 38, waist: 88, hip: 0, act: '1.375', goal: 'maintain' },
      prepare(inst) {
        probe(inst, 'female', { sex: 'female', age: 28, height: 160, weight: 50, neck: 32, waist: 70, hip: 90, act: '1.55', goal: 'maintain' })
      },
      expect(d, h, inst) {
        const errs = []
        // 公制 US Navy（单位 cm）：
        // 男 %fat = 86.010·log10(腰−颈) − 70.041·log10(身高) + 36.066
        //        = 86.010·log10(19.685in) − 70.041·log10(67.717in) + 36.76 = 19.8%
        const got = numOf(kv(d, '体脂率（US Navy）'))
        if (!(Math.abs(got - 19.8) <= 0.2)) {
          errs.push('体脂率应按 US Navy（cm→英寸换算后）给 19.8%，实得 ' + kv(d, '体脂率（US Navy）') +
            '（页面把英制常数式 495/(1.0324−0.19077·log10(腰−颈)+0.15456·log10(身高))−450 直接喂 cm，' +
            'miniprogram/packageCalc/pages/bmi/index.js:63 / :69，文案却声称「US Navy 公式（公制）」）')
        }
        if (got <= 3 || got >= 60) errs.push('体脂率结果 ' + got + '% 不在人体可能区间 (3%,60%)')
        const p = gp(inst, 'female')
        if (!p || !p.result) errs.push('女性体脂预跑失败：' + (p && errCode(p.data)))
        else {
          const f = numOf(kv(p.data, '体脂率（US Navy）'))
          // 女 %fat = 163.205·log10((腰+臀−颈)/2.54) − 97.684·log10(身高/2.54) − 78.387 = 23.6%
          if (!(Math.abs(f - 23.6) <= 0.4)) errs.push('女性 160cm/腰70/臀90/颈32 体脂应约 23.7%，实得 ' + f + '%')
          if (f > 60) errs.push('女性体脂率算出 ' + f + '%，超出人体可能区间（>60% 必然是量纲错误）')
        }
        return errs
      }
    },
    {
      name: '目标热量与蛋白质：减脂 TDEE−400 且 1.8 g/kg；增肌 +300 且 1.6 g/kg',
      values: { sex: 'male', age: 30, height: 175, weight: 70, neck: 0, waist: 0, hip: 0, act: '1.2', goal: 'lose' },
      prepare(inst) {
        probe(inst, 'gain', { sex: 'female', age: 28, height: 160, weight: 50, neck: 0, waist: 0, hip: 0, act: '1.55', goal: 'gain' })
      },
      expect(d, h, inst) {
        const errs = []
        // 男 30 岁 175/70：BMR = 700 + 1093.75 − 150 + 5 = 1648.75；TDEE(1.2) = 1978.5 → 1979
        if (kv(d, 'BMR（Mifflin-St Jeor）') !== '1649 kcal/天') errs.push('BMR 应 1649，实得 ' + kv(d, 'BMR（Mifflin-St Jeor）'))
        if (String(kv(d, 'TDEE')).indexOf('1979 kcal/天') !== 0) errs.push('TDEE = 1648.75×1.2 = 1978.5 → 应 1979，实得 ' + kv(d, 'TDEE'))
        if (String(kv(d, '建议热量')).indexOf('1579 kcal/天') !== 0) errs.push('减脂建议热量应 1978.5−400 = 1579 kcal/天，实得 ' + kv(d, '建议热量'))
        if (String(kv(d, '建议热量')).indexOf('减脂 −400') < 0) errs.push('应标注减脂缺口 400，实得 ' + kv(d, '建议热量'))
        if (String(kv(d, '建议蛋白质')).indexOf('126 g/天') !== 0) errs.push('减脂蛋白质应 70×1.8 = 126 g/天，实得 ' + kv(d, '建议蛋白质'))
        const p = gp(inst, 'gain')
        if (!p || !p.result) errs.push('增肌预跑失败')
        else {
          // 女 28 岁 160/50：BMR = 500 + 1000 − 140 − 161 = 1199；TDEE(1.55) = 1858.45 → 1858
          if (kv(p.data, 'BMR（Mifflin-St Jeor）') !== '1199 kcal/天') errs.push('女性 BMR 应 1199（−161），实得 ' + kv(p.data, 'BMR（Mifflin-St Jeor）'))
          if (String(kv(p.data, 'TDEE')).indexOf('1858 kcal/天') !== 0) errs.push('女性 TDEE 应 1858，实得 ' + kv(p.data, 'TDEE'))
          if (String(kv(p.data, '建议热量')).indexOf('2158 kcal/天') !== 0) errs.push('增肌建议热量应 1858.45+300 = 2158，实得 ' + kv(p.data, '建议热量'))
          if (String(kv(p.data, '建议蛋白质')).indexOf('80 g/天') !== 0) errs.push('增肌蛋白质应 50×1.6 = 80 g/天，实得 ' + kv(p.data, '建议蛋白质'))
        }
        return errs
      }
    },
    {
      name: '异常：身高 50cm / 体重 400kg / 年龄 5 岁 / 颈围≥腰围 / 身高非数字',
      values: { sex: 'male', age: 30, height: 50, weight: 60, neck: 38, waist: 84, hip: 92, act: '1.375', goal: 'maintain' },
      prepare(inst) {
        probe(inst, 'heavy', { sex: 'male', age: 30, height: 175, weight: 400, neck: 38, waist: 84 })
        probe(inst, 'kid', { sex: 'male', age: 5, height: 110, weight: 25, neck: 30, waist: 55 })
        probe(inst, 'neckBig', { sex: 'male', age: 30, height: 175, weight: 70, neck: 45, waist: 40 })
        probe(inst, 'nanH', { sex: 'male', age: 30, height: 'abc', weight: 70, neck: 0, waist: 0 })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('身高 50cm 应报 PARAM_INVALID，实得 ' + errText(d))
        if (errMsg(d).indexOf('身高') < 0) errs.push('文案应指向身高区间，实得：' + errMsg(d))
        if (d.result !== null) errs.push('越界输入不应产出 result')
        const map = { heavy: '体重 400kg', kid: '年龄 5 岁', neckBig: '颈围≥腰围（对数项非正）', nanH: '身高非数字' }
        Object.keys(map).forEach(function (k) {
          const p = gp(inst, k)
          if (!p) { errs.push(map[k] + ' 预跑缺失'); return }
          if (errCode(p.data) !== 'PARAM_INVALID') errs.push(map[k] + ' 应报 PARAM_INVALID，实得 ' + (p.result ? '却产出 BMI=' + kv(p.data, 'BMI') : String(errCode(p.data))))
          if (p.result && dirty(p.data)) errs.push(map[k] + ' 场景把 NaN 算成了结果')
        })
        return errs
      }
    }
  ]
  ,

  /* ============================ calc-compound ============================ */
  'calc-compound': [
    {
      name: '复利终值：10 万 @3.5% × 10 年 月计 → 141834.48（(1+r/m)^(m·t) 手算）',
      values: { mode: 'compound', principal: 100000, rate: 3.5, years: 10, freq: '12' },
      expect(d, h) {
        const errs = []
        // FV = 100000 × (1 + 0.035/12)^120 = 141834.4797… → 141834.48
        const wantFv = Math.round(100000 * Math.pow(1 + 0.035 / 12, 12 * 10) * 100) / 100
        if (Math.abs(wantFv - 141834.48) > 0.005) errs.push('自检失败：公式算出 ' + wantFv)
        const got = numOf(kv(d, '终值'))
        if (!(Math.abs(got - wantFv) < 0.01)) errs.push('终值应 ' + wantFv.toFixed(2) + ' 元，实得 ' + kv(d, '终值'))
        const gotI = numOf(kv(d, '利息'))
        if (!(Math.abs(gotI - (wantFv - 100000)) < 0.01)) errs.push('利息应 = 终值 − 本金 = 41834.48，实得 ' + kv(d, '利息'))
        if (kv(d, '增长倍数') !== '1.4183 倍') errs.push('增长倍数应 1.4183 倍（4 位），实得 ' + kv(d, '增长倍数'))
        if (kv(d, '计息') !== '120 期 × 期利率 0.2917%') errs.push('计息参数应 120 期 × 0.2917%，实得 ' + kv(d, '计息'))
        if (String(kv(d, '公式')).indexOf('FV = P × (1 + r/m)^(m×n)') < 0) errs.push('应展示公式，实得 ' + kv(d, '公式'))
        return errs
      }
    },
    {
      name: '计息频次：年 / 半年 / 季 / 月 / 日 终值与公式一致且单调递增',
      values: { mode: 'compound', principal: 100000, rate: 3.5, years: 10, freq: '1' },
      prepare(inst) {
        inst.__probe_freqs = []
        ;['2', '4', '12', '365'].forEach(function (f) {
          const snap = probe(inst, 'f' + f, { mode: 'compound', principal: 100000, rate: 3.5, years: 10, freq: f })
          inst.__probe_freqs.push({ f: f, got: numOf(kv(snap.data, '终值')) })
        })
        const daily = probe(inst, 'daily', { mode: 'compound', principal: 100000, rate: 5, years: 3, freq: '365' })
        inst.__probe_daily = numOf(kv(daily.data, '终值'))
      },
      expect(d, h, inst) {
        const errs = []
        // 年计：FV = 100000 × 1.035^10 = 141059.8760… → 141059.88
        const wantAnnual = Math.round(100000 * Math.pow(1.035, 10) * 100) / 100
        const got = numOf(kv(d, '终值'))
        if (!(Math.abs(got - wantAnnual) < 0.01)) errs.push('年计终值应 ' + wantAnnual.toFixed(2) + '，实得 ' + kv(d, '终值'))
        if (kv(d, '计息') !== '10 期 × 期利率 3.5000%') errs.push('年计应 10 期 × 3.5000%，实得 ' + kv(d, '计息'))
        const ms = [2, 4, 12, 365]
        const rows = inst.__probe_freqs || []
        if (rows.length !== 4) errs.push('频次预跑不足：' + rows.length)
        for (let i = 0; i < rows.length; i++) {
          const want = Math.round(100000 * Math.pow(1 + 0.035 / ms[i], ms[i] * 10) * 100) / 100
          if (!(Math.abs(rows[i].got - want) < 0.01)) errs.push('频次 ' + rows[i].f + ' 终值应 ' + want.toFixed(2) + '，实得 ' + rows[i].got)
        }
        const seq = [got].concat(rows.map(function (r) { return r.got }))
        for (let i = 1; i < seq.length; i++) if (!(seq[i] > seq[i - 1])) errs.push('终值应随计息频次递增：' + seq.join(' < '))
        // 10 万 @5% 3 年 日计：100000×(1+0.05/365)^1095 = 116182.23
        if (!(Math.abs((inst.__probe_daily || 0) - 116182.23) < 0.01)) errs.push('日计 5% 3 年终值应 116182.23，实得 ' + inst.__probe_daily)
        return errs
      }
    },
    {
      name: '定投：每月 2000 @6% × 20 年 → 期末 924081.79 / 投入 480000 / 收益 444081.79',
      values: { mode: 'dca', monthlyInvest: 2000, rate: 6, years: 20 },
      prepare(inst) {
        const z = probe(inst, 'zero', { mode: 'dca', monthlyInvest: 1000, rate: 0, years: 5 })
        inst.__probe_zero = numOf(kv(z.data, '期末价值'))
      },
      expect(d, h, inst) {
        const errs = []
        // i = 0.005，n = 240：FV = 2000×((1.005)^240 − 1)/0.005 = 924081.7905…
        const want = Math.round(2000 * (Math.pow(1.005, 240) - 1) / 0.005 * 100) / 100
        if (Math.abs(want - 924081.79) > 0.01) errs.push('自检失败：定投公式算出 ' + want)
        if (!(Math.abs(numOf(kv(d, '期末价值')) - want) < 0.01)) errs.push('期末价值应 ' + want.toFixed(2) + '，实得 ' + kv(d, '期末价值'))
        if (!(Math.abs(numOf(kv(d, '累计投入')) - 480000) < 0.01)) errs.push('累计投入应 480,000.00，实得 ' + kv(d, '累计投入'))
        if (!(Math.abs(numOf(kv(d, '收益')) - 444081.79) < 0.01)) errs.push('收益应 444,081.79，实得 ' + kv(d, '收益'))
        if (String(kv(d, '收益')).indexOf('92.52%') < 0) errs.push('收益率应 444081.79/480000 = 92.52%，实得 ' + kv(d, '收益'))
        if (kv(d, '期数') !== '240 期（月末投入，月利率 0.5000%）') errs.push('期数文案应 240 期 × 0.5000%，实得 ' + kv(d, '期数'))
        // 0 利率退化为等差：1000×60 = 60000
        if (!(Math.abs((inst.__probe_zero || 0) - 60000) < 0.01)) errs.push('0 利率定投期末价值应 = 累计投入 60000.00，实得 ' + inst.__probe_zero)
        return errs
      }
    },
    {
      name: '存款：整存整取 1 万×3 年 @2.75% = 10825.00；零存整取 1000×36 月 @1.65% = 36915.75',
      values: { mode: 'deposit', depositType: 'lump', depositAmount: 10000, years: 3, rate: 2.75 },
      prepare(inst) {
        const z = probe(inst, 'zero', { mode: 'deposit', depositType: 'zero', depositMonthly: 1000, years: 3, rate: 1.65 })
        inst.__probe_zero = {
          total: numOf(kv(z.data, '到期本息')),
          interest: numOf(kv(z.data, '利息')),
          principal: numOf(kv(z.data, '累计本金'))
        }
      },
      expect(d, h, inst) {
        const errs = []
        // 单利：利息 = 10000 × 0.0275 × 3 = 825.00 → 本息 10825.00
        if (!(Math.abs(numOf(kv(d, '到期本息')) - 10825) < 0.01)) errs.push('整存整取到期本息应 10,825.00，实得 ' + kv(d, '到期本息'))
        if (!(Math.abs(numOf(kv(d, '利息')) - 825) < 0.01)) errs.push('利息应 825.00，实得 ' + kv(d, '利息'))
        if (String(kv(d, '类型')).indexOf('整存整取') < 0) errs.push('类型应标注整存整取，实得 ' + kv(d, '类型'))
        const p = inst.__probe_zero || {}
        // 零存整取累计月积数法：利息 = 1000 × (36×37/2) × (0.0165/12) = 1000×666×0.001375 = 915.75
        if (!(Math.abs((p.interest || 0) - 915.75) < 0.01)) errs.push('零存整取利息应 915.75，实得 ' + p.interest)
        if (!(Math.abs((p.total || 0) - 36915.75) < 0.01)) errs.push('零存整取本息应 36,915.75，实得 ' + p.total)
        if (!(Math.abs((p.principal || 0) - 36000) < 0.01)) errs.push('零存整取累计本金应 36,000.00，实得 ' + p.principal)
        return errs
      }
    },
    {
      name: '异常：年数 60 / 年化 150% / 本金 0 / 每月投入 0 / 存款超 5 年',
      values: { mode: 'compound', principal: 100000, rate: 3.5, years: 60, freq: '12' },
      prepare(inst) {
        probe(inst, 'rate', { mode: 'compound', principal: 100000, rate: 150, years: 10 })
        probe(inst, 'p0', { mode: 'compound', principal: 0, rate: 3.5, years: 10 })
        probe(inst, 'dca0', { mode: 'dca', monthlyInvest: 0, rate: 3.5, years: 10 })
        probe(inst, 'depLong', { mode: 'deposit', depositType: 'lump', depositAmount: 10000, years: 6, rate: 2 })
        probe(inst, 'negRate', { mode: 'compound', principal: 100000, rate: -30, years: 10 })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'PARAM_INVALID') errs.push('年数 60 应报 PARAM_INVALID，实得 ' + errText(d))
        if (errMsg(d).indexOf('年数') < 0) errs.push('文案应说明年数区间，实得：' + errMsg(d))
        if (d.result !== null) errs.push('越界参数不应产出 result')
        const map = { rate: '年化 150%', p0: '本金 0', dca0: '每月投入 0', depLong: '存款 6 年', negRate: '年化 −30%' }
        Object.keys(map).forEach(function (k) {
          const p = gp(inst, k)
          if (!p) { errs.push(map[k] + ' 预跑缺失'); return }
          if (errCode(p.data) !== 'PARAM_INVALID') errs.push(map[k] + ' 应报 PARAM_INVALID，实得 ' + (p.result ? '却产出 ' + JSON.stringify(p.result.kv && p.result.kv[0]) : String(errCode(p.data))))
        })
        return errs
      }
    }
  ],

  /* ============================ calc-calculator ============================ */
  'calc-calculator': [
    {
      name: '优先级 / 括号 / 右结合幂 / 隐式乘：2+3*4=14、(1+2)^3=27、-2^2=-4、5^2^3=390625',
      values: { expr: '2+3*4', angle: 'deg', thousands: true },
      prepare(inst) {
        const cases = [
          ['(1+2)^3', 27], ['2(3+1)', 8], ['-2^2', -4], ['5^2^3', 390625],
          ['1+2*3-4/2', 5], ['(1+2)*(3+4)', 21], ['0.1+0.2', 0.3], ['10/4', 2.5], ['2^0.5', Math.SQRT2],
          ['12/5', 2.4], ['100/10/5', 2]
        ]
        inst.__probe_exprs = []
        cases.forEach(function (c) {
          const snap = probe(inst, 'e' + c[0], { expr: c[0], angle: 'deg', thousands: false })
          inst.__probe_exprs.push({ expr: c[0], want: c[1], got: Number(String(kv(snap.data, '结果')).replace(/,/g, '')), err: snap.error && snap.error.message })
        })
      },
      expect(d, h, inst) {
        const errs = []
        if (kv(d, '结果') !== '14') errs.push('2+3*4 应为 14（乘除优先于加减），实得 ' + kv(d, '结果'))
        if (kv(d, '表达式') !== '2+3*4') errs.push('结果区应回显表达式，实得 ' + kv(d, '表达式'))
        if (kv(d, '角度模式') !== 'DEG') errs.push('应回显 DEG，实得 ' + kv(d, '角度模式'))
        if (!d.hist.length || d.hist[0].expr !== '2+3*4') errs.push('历史记录应写入表达式，实得 ' + JSON.stringify(d.hist[0]))
        ;(inst.__probe_exprs || []).forEach(function (r) {
          if (!isFinite(r.got)) { errs.push(r.err ? (r.expr + ' 报错：' + r.err) : (r.expr + ' 无结果')); return }
          if (Math.abs(r.got - r.want) > 1e-12) errs.push(r.expr + ' 应 ' + r.want + '，实得 ' + r.got)
        })
        return errs
      }
    },
    {
      name: 'DEG/RAD 三角与百分号后缀：sin(30)=0.5、asin(1)=90、10%=0.1',
      values: { expr: 'sin(30)', angle: 'deg', thousands: true },
      prepare(inst) {
        const degCases = [['cos(60)', 0.5], ['tan(45)', 1], ['sin(90)', 1], ['asin(1)', 90], ['atan(1)', 45], ['ln(e)', 1], ['log(100)', 2], ['sqrt(16)', 4], ['abs(-3.5)', 3.5], ['10%', 0.1], ['100+10%', 100.1], ['1.5%', 0.015], ['200*10%', 20]]
        inst.__probe_deg = []
        degCases.forEach(function (c) {
          const snap = probe(inst, 'd' + c[0], { expr: c[0], angle: 'deg', thousands: false })
          inst.__probe_deg.push({ expr: c[0], want: c[1], got: Number(String(kv(snap.data, '结果')).replace(/,/g, '')), err: snap.error && snap.error.message })
        })
        const rad = probe(inst, 'rad', { expr: 'sin(1.5707963267948966)', angle: 'rad', thousands: false })
        inst.__probe_rad = Number(String(kv(rad.data, '结果')).replace(/,/g, ''))
        const radAsin = probe(inst, 'radAsin', { expr: 'asin(1)', angle: 'rad', thousands: false })
        inst.__probe_radAsin = { got: Number(String(kv(radAsin.data, '结果')).replace(/,/g, '')), angle: kv(radAsin.data, '角度模式') }
      },
      expect(d, h, inst) {
        const errs = []
        if (kv(d, '结果') !== '0.5') errs.push('DEG 模式 sin(30) 应为 0.5，实得 ' + kv(d, '结果'))
        ;(inst.__probe_deg || []).forEach(function (r) {
          if (!isFinite(r.got)) { errs.push(r.err ? (r.expr + ' 报错：' + r.err) : (r.expr + ' 无结果')); return }
          if (Math.abs(r.got - r.want) > 1e-9) errs.push(r.expr + ' 应 ' + r.want + '，实得 ' + r.got)
        })
        if (!(Math.abs((inst.__probe_rad || 0) - 1) < 1e-9)) errs.push('RAD 模式 sin(π/2) 应 1，实得 ' + inst.__probe_rad)
        const ra = inst.__probe_radAsin || {}
        if (!(Math.abs((ra.got || 0) - Math.PI / 2) < 1e-9)) errs.push('RAD 模式 asin(1) 应 1.5707963267949，实得 ' + ra.got)
        if (ra.angle !== 'RAD') errs.push('RAD 模式结果区应回显 RAD，实得 ' + ra.angle)
        return errs
      }
    },
    {
      name: 'π 常量（回归）：键盘 π 键与内置示例 2π 必须能求值',
      values: { expr: '2π', angle: 'deg', thousands: false },
      prepare(inst) {
        probe(inst, 'pi', { expr: 'π', angle: 'deg', thousands: false })
        probe(inst, 'piExpr', { expr: 'sin(π)', angle: 'deg', thousands: false })
      },
      expect(d, h, inst) {
        const errs = []
        // 手算：2π = 6.283185307179586（页面 tips 明写「π、e 可直接点按」「2(3+1)=8、2π」，KEYS 面板第 3 排有 π 键）
        if (d.error) {
          errs.push('2π 求值失败（回归）：' + errText(d) + '；calc-parser.js 的 tokenizer 必须把键盘注入的「π」归一到 pi 常量（历史缺陷：只认 ASCII 字母与 + - * / ( ) ^ % ,，' +
            'π 落到「无法识别的字符」分支，点 π 键再点等号必然报错，samples 里的 2π 同样不可用）')
        } else {
          const shown = Number(String(kv(d, '结果')).replace(/,/g, ''))
          if (Math.abs(shown - Math.PI * 2) > 1e-9) errs.push('2π 应 6.2831853071796，实得 ' + shown)
        }
        if (inst.__probe_pi && !inst.__probe_pi.result) errs.push('单独 π 也无法求值：' + errText(inst.__probe_pi.data))
        if (inst.__probe_piExpr && !inst.__probe_piExpr.result) errs.push('sin(π) 无法求值（DEG 下应 0.0548…）：' + errText(inst.__probe_piExpr.data))
        return errs
      }
    },
    {
      name: '除零 / 溢出 / 定义域：可读错误，屏上不出现 NaN、Infinity，也不残留上次结果',
      values: { expr: '1/0', angle: 'deg', thousands: true },
      prepare(inst) {
        probe(inst, 'ok', { expr: '2+3', angle: 'deg', thousands: true })
        probe(inst, 'overflow', { expr: '9^9^9', angle: 'deg', thousands: true })
        probe(inst, 'domain', { expr: 'asin(2)', angle: 'deg', thousands: true })
        probe(inst, 'log0', { expr: 'log(0)', angle: 'deg', thousands: true })
        probe(inst, 'sqrtNeg', { expr: 'sqrt(-1)', angle: 'deg', thousands: true })
        probe(inst, 'zeroNegPow', { expr: '0^-1', angle: 'deg', thousands: true })
      },
      expect(d, h, inst) {
        const errs = []
        if (errCode(d) !== 'DIV_ZERO') errs.push('1/0 应报 DIV_ZERO，实得 ' + errText(d))
        if (errMsg(d) !== '除数为 0，无法计算') errs.push('除零文案应「除数为 0，无法计算」，实得：' + errMsg(d))
        if (d.result !== null) errs.push('除零后 result 未清空，屏上仍显示上一次答案（' + JSON.stringify(d.result.kv && d.result.kv[1]) +
          '）：miniprogram/packageCalc/pages/calculator/index.js:128 的 catch 分支只 setData({error})，没有把 result 置 null，' +
          '手写表达式（onExprInput 路径）出错时结果区仍是旧值')
        if (dirty(d)) errs.push('除零场景屏上出现 NaN/Infinity/undefined')
        const map = {
          overflow: ['RANGE', '数值超出可显示范围'],
          domain: ['DOMAIN', '参数超出函数定义域'],
          log0: ['DOMAIN', '参数超出函数定义域'],
          sqrtNeg: ['DOMAIN', '参数超出函数定义域'],
          zeroNegPow: ['DIV_ZERO', '除数为 0']
        }
        Object.keys(map).forEach(function (k) {
          const p = gp(inst, k)
          if (!p) { errs.push(k + ' 预跑缺失'); return }
          if (!p.error) { errs.push(k + ' 应报错，实得结果 ' + JSON.stringify(p.result && p.result.kv)); return }
          if (p.error.code !== map[k][0]) errs.push(k + ' 错误码应为 ' + map[k][0] + '，实得 ' + errText(p.data))
          if (!p.error.message || p.error.message.indexOf(map[k][1]) < 0) errs.push(k + ' 文案应含「' + map[k][1] + '」，实得 ' + p.error.message)
          if (p.result) errs.push(k + ' 报错时仍残留上次 result（应为 null）')
        })
        const ok = gp(inst, 'ok')
        if (!ok || !ok.result || kv(ok.data, '结果') !== '5') errs.push('前置正常计算 2+3 应得 5，实得 ' + (ok && kv(ok.data, '结果')))
        return errs
      }
    },
    {
      name: '千分位开关与超长/深嵌套表达式；空表达式、语法错误、未知函数都要可读',
      values: { expr: '1234567+890', angle: 'deg', thousands: true },
      prepare(inst) {
        probe(inst, 'plain', { expr: '1234567+890', angle: 'deg', thousands: false })
        const ones = []
        for (let i = 0; i < 2000; i++) ones.push('1')
        probe(inst, 'long', { expr: ones.join('+'), angle: 'deg', thousands: false })
        const deep = probe(inst, 'deep', { expr: '('.repeat(400) + '1+1' + ')'.repeat(400), angle: 'deg', thousands: false })
        inst.__probe_deep = { got: Number(String(kv(deep.data, '结果')).replace(/,/g, '')), err: deep.error && deep.error.message }
        const huge = probe(inst, 'huge', { expr: '('.repeat(10000) + '1' + ')'.repeat(10000), angle: 'deg', thousands: false })
        inst.__probe_huge = { hasResult: !!huge.result, err: huge.error && (huge.error.code + '|' + huge.error.message) }
        probe(inst, 'empty', { expr: '', angle: 'deg', thousands: true })
        probe(inst, 'unclosed', { expr: '(1+2', angle: 'deg', thousands: true })
        probe(inst, 'badFunc', { expr: 'foo(2)', angle: 'deg', thousands: true })
        probe(inst, 'badChar', { expr: '2，+1', angle: 'deg', thousands: true })
        probe(inst, 'trailing', { expr: '2+', angle: 'deg', thousands: true })
      },
      expect(d, h, inst) {
        const errs = []
        if (kv(d, '结果') !== '1,235,457') errs.push('千分位应显示 1,235,457，实得 ' + kv(d, '结果'))
        const p = gp(inst, 'plain')
        if (p && kv(p.data, '结果') !== '1235457') errs.push('关闭千分位后应显示 1235457，实得 ' + (p && kv(p.data, '结果')))
        const l = gp(inst, 'long')
        if (!l || !l.result) errs.push('2000 项连加失败：' + (l && errText(l.data)))
        else if (Number(String(kv(l.data, '结果')).replace(/,/g, '')) !== 2000) errs.push('2000 个 1 相加应 2000，实得 ' + kv(l.data, '结果'))
        const dep = inst.__probe_deep || {}
        if (dep.got !== 2 && !dep.err) errs.push('深嵌套 (1+1) 应得 2，实得 ' + JSON.stringify(dep))
        const hg = inst.__probe_huge || {}
        if (!hg.hasResult && !hg.err) errs.push('1 万层括号既没结果也没错误')
        if (hg.err && /NaN|Infinity|undefined/.test(hg.err)) errs.push('1 万层括号把内部异常直接上屏：' + hg.err)
        if (hg.err && hg.err.indexOf('Maximum call stack') >= 0) errs.push('深嵌套把 V8 的 RangeError 文案直接当用户文案：' + hg.err)
        const e = gp(inst, 'empty')
        if (!e || errCode(e.data) !== 'PARAM_INVALID' || errMsg(e.data).indexOf('表达式') < 0) errs.push('空表达式应提示「请先输入表达式」，实得 ' + (e && errText(e.data)))
        const cases = { unclosed: 'SYNTAX', badFunc: 'UNKNOWN_FUNC', badChar: 'SYNTAX', trailing: 'SYNTAX' }
        Object.keys(cases).forEach(function (k) {
          const q = gp(inst, k)
          if (!q) { errs.push(k + ' 预跑缺失'); return }
          if (!q.error) { errs.push(k + ' 应报错，实得 ' + JSON.stringify(q.result && q.result.kv)); return }
          if (q.error.code !== cases[k]) errs.push(k + ' 错误码应为 ' + cases[k] + '，实得 ' + errText(q.data))
          if (!q.error.message || q.error.message.length < 4) errs.push(k + ' 文案不可读：' + JSON.stringify(q.error.message))
          if (q.result) errs.push(k + ' 报错时未清空上次 result')
        })
        return errs
      }
    }
  ]
}
