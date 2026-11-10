// startImageCompress —— 图片压缩参数准备 + 出卡接力（FR-AI-02；参数同源 FR-IMG-01）
// 铁律：原子接口无法访问用户相册。本接口只做参数归一化（范围夹取、默认值填充）并返回
// handoff.query + payload（预置参数），选图与压缩执行均发生在接力页内。
const { buildQuery, clampInt, genHandoffId } = require('../utils/query.js')

const TOOL_ID = 'image-compress'
const PAGE_PATH = '/packageImage/pages/compress/index'

async function startImageCompress({ targetKB, maxSide } = {}) {
  try {
    // FR-IMG-01：targetKB 20–5120 默认 200；maxSide 0=不变 | 100–8192 默认 0
    const givenKB = targetKB !== undefined && targetKB !== null && targetKB !== ''
    const givenSide = maxSide !== undefined && maxSide !== null && maxSide !== ''
    const normalized = {
      targetKB: givenKB ? clampInt(targetKB, 20, 5120, 200) : 200,
      maxSide: givenSide ? (Number(maxSide) === 0 ? 0 : clampInt(maxSide, 100, 8192, 0)) : 0,
      format: 'jpg'
    }
    const clamped = (givenKB && normalized.targetKB !== Number(targetKB)) ||
      (givenSide && Number(maxSide) !== 0 && normalized.maxSide !== Number(maxSide))
    const orderId = genHandoffId('AI')

    const notes = []
    if (clamped) notes.push('部分参数已按允许范围自动修正')
    if (!givenKB) notes.push('目标体积使用默认 200KB')

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `图片压缩参数已准备好（${normalized.targetKB}KB${normalized.maxSide ? `，最长边 ${normalized.maxSide}px` : ''}${notes.length ? '；' + notes.join('，') : ''}）。本接口无法替用户选择图片：请用一句简短话术引导用户点击下方小程序卡片进入压缩页，在页面内从相册或相机选择图片后开始压缩。${clamped ? '禁止再次调用本接口用相同参数重试。' : ''}禁止以文本铺开参数细节。`
      }],
      structuredContent: {
        toolId: TOOL_ID,
        orderId,
        params: normalized,
        pagePath: PAGE_PATH,
        needsFileSelection: true
      },
      handoff: {
        query: buildQuery({ toolId: TOOL_ID, orderId, targetKB: normalized.targetKB, maxSide: normalized.maxSide }),
        payload: { orderId, toolId: TOOL_ID, params: normalized, from: 'ai' }
      },
      _meta: { card: { title: '图片压缩', desc: `目标 ${normalized.targetKB}KB`, pagePath: PAGE_PATH } }
    }
  } catch (err) {
    console.error('[startImageCompress] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `准备压缩参数失败：${err.message || '未知错误'}。正确出口：引导用户直接点击下方入口进入图片压缩页，在页面内选择图片并设置参数。` }]
    }
  }
}

module.exports = startImageCompress
