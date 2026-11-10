// convertUnit —— 单位换算（FR-AI-03：对话内直接返回结果，不出卡、不 handoff；同源 FR-CAL-01）
// 换算表在 utils/units.js（与主包 packageCalc 同源逻辑的 skill 内独立副本）。
// 单位与数值必须来自用户原话；用户没说要换算到哪一单位时先追问，禁止自行猜目标单位。
const { convertUnit } = require('../utils/calc.js')

async function convertUnitApi({ value, from, to, precision } = {}) {
  try {
    const missing = []
    if (value === undefined || value === null || value === '') missing.push('value（数值）')
    if (!from) missing.push('from（源单位）')
    if (!to) missing.push('to（目标单位）')
    if (missing.length) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `缺少参数：${missing.join('、')}。禁止编造数值或单位凑数。正确出口：向用户追问缺失项（换算哪个数值、从什么单位到什么单位），拿到原话后再调用本接口。`
        }]
      }
    }

    const p = precision !== undefined && precision !== null && precision !== '' ? Number(precision) : 6
    const res = convertUnit(value, from, to, p)

    if (!res.ok) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `换算失败：${res.message}。请把支持范围转告用户并让其确认单位写法；禁止自行换近义词单位反复重试。若用户要的单位不在支持列表，直接回复「该能力暂不支持」。`
        }]
      }
    }

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `${value} ${res.fromUnit} = ${res.result} ${res.toUnit}（${res.group} 类；${res.formula}）。请用一句话把结果告诉用户。`
      }],
      structuredContent: {
        value: Number(value),
        from: res.fromUnit,
        to: res.toUnit,
        result: res.result,
        group: res.group,
        formula: res.formula
      }
    }
  } catch (err) {
    console.error('[convertUnit] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `换算失败：${err.message || '未知错误'}。请引导用户使用小程序单位换算页。` }]
    }
  }
}

module.exports = convertUnitApi
