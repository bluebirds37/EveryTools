// extractFrames —— 视频抽帧/封面参数准备 + 出卡接力（FR-AI-02；参数同源 FR-VID-05）
// count 必须来自用户原话，未明说用默认 6 帧；选视频在接力页内完成。
const { buildQuery, clampInt, genHandoffId } = require('../utils/query.js')

const TOOL_ID = 'video-frames'
const PAGE_PATH = '/packageVideo/pages/frames/index'

async function extractFrames({ count } = {}) {
  try {
    const given = count !== undefined && count !== null && count !== ''
    const normalized = {
      mode: 'count',
      count: given ? clampInt(count, 1, 30, 6) : 6,
      format: 'jpg',
      quality: 90
    }
    const clamped = given && normalized.count !== Number(count)
    const orderId = genHandoffId('AI')

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `抽帧参数已准备好（均匀抽取 ${normalized.count} 帧${clamped ? '，已按 1–30 范围修正' : ''}）。本接口无法访问用户视频：请用一句简短话术引导用户点击下方小程序卡片进入抽帧页，在页面内选择视频后开始云端抽帧。${clamped ? '禁止再次用相同越界值调用本接口。' : ''}禁止以文本铺开参数细节。`
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
        query: buildQuery({ toolId: TOOL_ID, orderId, count: normalized.count }),
        payload: { orderId, toolId: TOOL_ID, params: normalized, from: 'ai' }
      },
      _meta: { card: { title: '提取抽帧', desc: `均匀 ${normalized.count} 帧`, pagePath: PAGE_PATH } }
    }
  } catch (err) {
    console.error('[extractFrames] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `准备抽帧参数失败：${err.message || '未知错误'}。正确出口：引导用户直接进入抽帧页在页内设置帧数。` }]
    }
  }
}

module.exports = extractFrames
