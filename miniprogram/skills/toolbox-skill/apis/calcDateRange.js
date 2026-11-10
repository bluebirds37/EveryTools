// calcDateRange —— 日期间隔计算（FR-AI-03：对话内直接返回结果，不出卡、不 handoff；同源 FR-CAL-02）
// 日期必须来自用户原话；相对日期（昨天/下周五）由 Agent 先解析成具体 YYYY-MM-DD 再调用。
const { calcDateRange } = require('../utils/calc.js')

async function calcDateRangeApi({ start, end } = {}) {
  try {
    const missing = []
    if (!start) missing.push('start（起始日期）')
    if (!end) missing.push('end（结束日期）')
    if (missing.length) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `缺少参数：${missing.join('、')}。禁止用今天或猜测日期凑数。正确出口：向用户追问具体日期（把「昨天/下周三」等相对说法先换算成 YYYY-MM-DD），拿到两端日期后再调用本接口。`
        }]
      }
    }

    const res = calcDateRange(start, end)
    if (!res.ok) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `日期无效：${res.error}。请把错误原因转告用户并让其核对日期（格式 YYYY-MM-DD，不存在如 2026-02-30 的日期）；禁止自行改成相近日期重试。`
        }]
      }
    }

    const dirText = res.direction === 'backward' ? '（end 早于 start，按间隔绝对值计算）' : ''
    return {
      isError: false,
      content: [{
        type: 'text',
        text: `${start} 到 ${end} 相差 ${res.days} 天${dirText}，约 ${res.breakdown.text}（${res.weeks.whole} 周零 ${res.weeks.rest} 天）；含首尾共 ${res.inclusiveDays} 天。起始日为${res.meta.startWeekday}，结束日为${res.meta.endWeekday}。请用一句话把结论告诉用户。`
      }],
      structuredContent: {
        start,
        end,
        days: res.days,
        inclusiveDays: res.inclusiveDays,
        direction: res.direction,
        breakdown: res.breakdown,
        weeks: res.weeks,
        meta: res.meta
      }
    }
  } catch (err) {
    console.error('[calcDateRange] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `日期计算失败：${err.message || '未知错误'}。请引导用户使用小程序日期计算页。` }]
    }
  }
}

module.exports = calcDateRangeApi
