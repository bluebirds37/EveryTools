const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')

const TOOL_ID = 'calc-bmi'

const ACTIVITY = [
  { value: '1.2', label: '久坐（几乎不运动）' },
  { value: '1.375', label: '轻度（每周 1–3 次）' },
  { value: '1.55', label: '中度（每周 3–5 次）' },
  { value: '1.725', label: '高度（每周 6–7 次）' },
  { value: '1.9', label: '专业（体力劳动/双练）' }
]

function defaults() {
  return { sex: 'male', age: 30, height: 172, weight: 68, neck: 38, waist: 84, hip: 92, act: '1.375', goal: 'maintain' }
}

function buildSchema() {
  return [
    { key: 'sex', label: '性别', type: 'segment', def: 'male', options: [{ value: 'male', label: '男' }, { value: 'female', label: '女' }] },
    { key: 'age', label: '年龄', type: 'slider', def: 30, min: 6, max: 100, step: 1, unit: '岁' },
    { key: 'height', label: '身高(cm)', type: 'number', def: 172, min: 100, max: 250, precision: 1 },
    { key: 'weight', label: '体重(kg)', type: 'number', def: 68, min: 20, max: 300, precision: 1 },
    { key: 'neck', label: '颈围(cm，算体脂必填)', type: 'number', def: 38, min: 0, max: 80, precision: 1 },
    { key: 'waist', label: '腰围(cm，男取肚脐水平)', type: 'number', def: 84, min: 0, max: 250, precision: 1 },
    { key: 'hip', label: '臀围(cm，女性体脂用)', type: 'number', def: 92, min: 0, max: 250, precision: 1, showIf: { key: 'sex', in: ['female'] } },
    { key: 'act', label: '活动水平', type: 'select', def: '1.375', options: ACTIVITY },
    { key: 'goal', label: '目标', type: 'segment', def: 'maintain', options: [{ value: 'lose', label: '减脂' }, { value: 'maintain', label: '维持' }, { value: 'gain', label: '增肌' }] }
  ]
}

function num(x) { return Number(x) }

function validate(v) {
  const invalid = function (reason) { return { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: reason }) } }
  const h = num(v.height), w = num(v.weight), a = num(v.age)
  if (!(h >= 100 && h <= 250)) return invalid('身高需在 100–250cm，超出范围无法评估')
  if (!(w >= 20 && w <= 300)) return invalid('体重需在 20–300kg，超出范围无法评估')
  if (!(a >= 6 && a <= 100)) return invalid('年龄需在 6–100 岁')
  const neck = num(v.neck), waist = num(v.waist)
  if (neck > 0 && waist > 0) {
    const d = v.sex === 'male' ? waist - neck : waist + num(v.hip) - neck
    if (d <= 0) return invalid('围度组合不合法：体脂公式对数项需为正（检查颈围/腰围/臀围）')
  }
  return null
}

function bmiGrade(bmi) {
  if (bmi < 18.5) return { name: '偏瘦', ref: '中国成人 BMI 标准：<18.5 偏瘦 / 18.5–23.9 正常 / 24–27.9 超重 / ≥28 肥胖' }
  if (bmi < 24) return { name: '正常', ref: '中国成人 BMI 标准：<18.5 偏瘦 / 18.5–23.9 正常 / 24–27.9 超重 / ≥28 肥胖' }
  if (bmi < 28) return { name: '超重', ref: '中国成人 BMI 标准：<18.5 偏瘦 / 18.5–23.9 正常 / 24–27.9 超重 / ≥28 肥胖' }
  return { name: '肥胖', ref: '中国成人 BMI 标准：<18.5 偏瘦 / 18.5–23.9 正常 / 24–27.9 超重 / ≥28 肥胖' }
}

/**
 * 体脂率：US Navy（腰颈围法）。
 * 页面输入是 cm，而官方公布式（86.010 / 70.041 / 36.76 与 163.205 / 97.684 / −78.387）
 * 的定义域是**英寸**；直接喂 cm 会把结果推高几十个点（女性 160/70/90/32 会算出 98%）。
 * 因此先按 1in = 2.54cm 换算再计算。
 */
function bodyFatPct(v) {
  const CM = 2.54
  const h = num(v.height) / CM
  const neck = num(v.neck) / CM
  const waist = num(v.waist) / CM
  if (!(neck > 0 && waist > 0)) return null
  if (v.sex === 'male') {
    const d = waist - neck
    if (!(d > 0)) return null
    return 86.01 * Math.log10(d) - 70.041 * Math.log10(h) + 36.76
  }
  const hip = num(v.hip) / CM
  if (!(hip > 0)) return null
  const d = waist + hip - neck
  if (!(d > 0)) return null
  return 163.205 * Math.log10(d) - 97.684 * Math.log10(h) - 78.387
}

function fatBand(sex, pct) {
  if (sex === 'male') {
    if (pct < 6) return '必需脂肪下限以下（数据可疑）'
    if (pct < 14) return '运动员水平'
    if (pct < 18) return '健康'
    if (pct < 25) return '一般'
    return '偏高'
  }
  if (pct < 14) return '必需脂肪下限以下（数据可疑）'
  if (pct < 21) return '运动员水平'
  if (pct < 25) return '健康'
  if (pct < 32) return '一般'
  return '偏高'
}

function run(v) {
  const h = num(v.height) / 100
  const w = num(v.weight)
  const a = num(v.age)
  const bmi = w / (h * h)
  const grade = bmiGrade(bmi)
  const kv = []
  kv.push({ key: 'BMI', value: bmi.toFixed(1) + '（' + grade.name + '）' })
  kv.push({ key: '分级参考', value: grade.ref })
  kv.push({ key: '健康体重区间', value: (18.5 * h * h).toFixed(1) + ' ~ ' + (23.9 * h * h).toFixed(1) + ' kg' })

  const bf = bodyFatPct(v)
  if (bf !== null && bf > 0) {
    kv.push({ key: '体脂率（US Navy）', value: bf.toFixed(1) + '%（' + fatBand(v.sex, bf) + '）' })
  } else {
    kv.push({ key: '体脂率（US Navy）', value: '未填围度或数据不足，跳过（男需颈围+腰围，女加臀围）' })
  }

  const bmr = 10 * w + 6.25 * num(v.height) - 5 * a + (v.sex === 'male' ? 5 : -161)
  const actRaw = num(v.act)
  // 活动系数拿不到合法值时，bmr*NaN 会把「NaN kcal/天」直接写上屏；退回最保守的一档
  const act = isFinite(actRaw) && actRaw >= 1 && actRaw <= 2.5 ? actRaw : 1.2
  const tdee = bmr * act
  kv.push({ key: 'BMR（Mifflin-St Jeor）', value: Math.round(bmr) + ' kcal/天' })
  kv.push({ key: 'TDEE', value: Math.round(tdee) + ' kcal/天（系数 ' + v.act + '）' })

  const goalDelta = v.goal === 'lose' ? -400 : v.goal === 'gain' ? 300 : 0
  const target = tdee + goalDelta
  const proteinPerKg = v.goal === 'lose' ? 1.8 : v.goal === 'gain' ? 1.6 : 1.2
  kv.push({ key: '建议热量', value: Math.round(target) + ' kcal/天（' + (goalDelta === 0 ? '维持当前体重' : goalDelta > 0 ? '增肌 +' + goalDelta : '减脂 −' + Math.abs(goalDelta)) + '）' })
  kv.push({ key: '建议蛋白质', value: Math.round(w * proteinPerKg) + ' g/天（' + proteinPerKg.toFixed(1) + ' g/kg 体重）' })
  kv.push({ key: '说明', value: '以上为一般人群参考值，不构成医疗建议；孕哺期、青少年、疾病人群请咨询专业人士' })

  return { kv: kv, text: kv.map(function (x) { return x.key + ': ' + x.value }).join('\n'), meta: 'BMI ' + bmi.toFixed(1) + ' · ' + grade.name }
}

Page({
  data: {
    tool: null,
    values: defaults(),
    schema: buildSchema(),
    busy: false,
    result: null,
    error: null,
    tips: [
      'BMI 按中国成人标准分级（18.5 / 24 / 28 阈值），非 WHO 分级',
      '体脂率使用 US Navy 腰颈围公式：男取腰围−颈围，女取腰围+臀围−颈围；公式原定义在英寸上，本工具已把输入的 cm 自动换算后再计算',
      'BMR 采用 Mifflin-St Jeor 公式，TDEE = BMR × 活动系数',
      '结果为一般参考值，不构成医疗建议；身高 100–250cm、体重 20–300kg、年龄 6–100 之外将被拒绝'
    ],
    samples: [
      { name: '男性 172/68 久坐减脂', v: { sex: 'male', height: 172, weight: 68, age: 30, act: '1.2', goal: 'lose', neck: 38, waist: 88 } },
      { name: '女性 160/50 中度维持', v: { sex: 'female', height: 160, weight: 50, age: 28, act: '1.55', goal: 'maintain', neck: 32, waist: 70, hip: 90 } },
      { name: '增肌男性 180/80', v: { sex: 'male', height: 180, weight: 80, age: 25, act: '1.725', goal: 'gain', neck: 40, waist: 86 } }
    ]
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const saved = store.params(TOOL_ID) || {}
    this.setData({ tool: tool, values: Object.assign(defaults(), saved) })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values, { [e.detail.key]: e.detail.value })
    this.setData({ values: values })
    store.saveParams(TOOL_ID, values)
    if (this.data.result) this.setData({ result: null })
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const invalid = validate(v)
    if (invalid) return this.setData({ error: invalid, result: null })
    this.setData({ busy: true, error: null })
    track.track('tool_run_start', { toolId: TOOL_ID, engine: 'client' })
    const t0 = Date.now()
    try {
      const result = run(v)
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, busy: false })
    } catch (e) {
      track.track('tool_run_fail', { toolId: TOOL_ID, code: e.code || 'TASK_FAILED' })
      this.setData({ error: { code: e.code || 'TASK_FAILED', message: error.message(e.code || 'TASK_FAILED') }, busy: false })
    }
  },

  onSample(e) {
    const idx = Number(e.currentTarget.dataset.index)
    const values = Object.assign(defaults(), this.data.samples[idx].v)
    this.setData({ values: values, result: null, error: null })
    this.onRun()
  },

  onCopy(e) {
    const text = (e.detail && e.detail.text) || (this.data.result && this.data.result.text) || ''
    if (!text) return
    wx.setClipboardData({
      data: text,
      success: function () {
        wx.showToast({ title: '已复制', icon: 'success' })
        track.track('result_copy', { toolId: TOOL_ID })
      }
    })
  },

  onShareAppMessage() {
    return { title: '身体指标 · BMI/体脂/BMR/TDEE 一次算全', path: '/packageCalc/pages/bmi/index?from=share' }
  }
})
