// videoToGif —— 视频转 GIF 参数准备 + 出卡接力（FR-AI-02；参数同源 FR-VID-04）
// 时间段/帧率必须来自用户原话（秒数），未明说用默认 0–5s / 12fps；选视频在接力页内完成。
const { buildQuery, clampNumber, clampInt, genHandoffId } = require('../utils/query.js')

const TOOL_ID = 'video-gif'
const PAGE_PATH = '/packageVideo/pages/gif/index'

async function videoToGif({ start, end, fps } = {}) {
  try {
    const hasStart = start !== undefined && start !== null && start !== ''
    const hasEnd = end !== undefined && end !== null && end !== ''
    // 非法/缺省起点回 0；上限单段 15s（FR-VID-04），越界夹取
    const s = hasStart ? clampNumber(start, 0, 600, 0) : 0
    let e = hasEnd ? clampNumber(end, 0, 600, s + 5) : s + 5
    let fixedRange = false
    if (e <= s) { e = s + 5; fixedRange = true }
    if (e - s > 15) { e = s + 15; fixedRange = true }
    const normalized = {
      start: Math.round(s * 100) / 100,
      end: Math.round(e * 100) / 100,
      fps: fps !== undefined && fps !== null && fps !== '' ? clampInt(fps, 5, 25, 12) : 12,
      width: 480,
      loop: 0
    }

    const orderId = genHandoffId('AI')
    const note = fixedRange ? `时间段已修正为 ${normalized.start}s–${normalized.end}s（单段上限 15s，结束必须晚于开始）；禁止再次用同一越界值调用本接口。` : ''

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `转 GIF 参数已准备好（${normalized.start}s–${normalized.end}s，${normalized.fps}fps）。本接口无法访问用户视频：请用一句简短话术引导用户点击下方小程序卡片进入 GIF 页，在页面内选择视频、确认时间段后开始云端转换。${note}禁止以文本铺开参数细节。`
      }],
      structuredContent: {
        toolId: TOOL_ID,
        orderId,
        params: normalized,
        pagePath: PAGE_PATH,
        needsFileSelection: true,
        cloudTask: true
      },
      handoff: {
        query: buildQuery({ toolId: TOOL_ID, orderId, start: normalized.start, end: normalized.end, fps: normalized.fps }),
        payload: { orderId, toolId: TOOL_ID, params: normalized, from: 'ai' }
      },
      _meta: { card: { title: '视频转 GIF', desc: `${normalized.start}–${normalized.end}s · ${normalized.fps}fps`, pagePath: PAGE_PATH } }
    }
  } catch (err) {
    console.error('[videoToGif] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `准备转 GIF 参数失败：${err.message || '未知错误'}。正确出口：引导用户直接进入视频转 GIF 页在页内设置时间段。` }]
    }
  }
}

module.exports = videoToGif
