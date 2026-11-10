// addWatermark —— 批量水印参数准备 + 出卡接力（FR-AI-02；参数同源 FR-IMG-05）
// 选图发生在水印接力页内；text 必须来自用户原话（≤60 字），position 用英文九宫格枚举。
const { buildQuery, pickEnum, genHandoffId } = require('../utils/query.js')

const TOOL_ID = 'image-watermark'
const PAGE_PATH = '/packageImage/pages/watermark/index'
// FR-IMG-05 position 九宫格枚举：tl/tm/tr/ml/mc/mr/bl/bm/br
const POSITIONS = ['tl', 'tm', 'tr', 'ml', 'mc', 'mr', 'bl', 'bm', 'br']

async function addWatermark({ text, position } = {}) {
  try {
    const givenText = typeof text === 'string' && text.trim()
    const rawText = givenText ? text.trim() : ''
    const truncated = rawText.length > 60
    const finalText = truncated ? rawText.slice(0, 60) : rawText

    const givenPos = position !== undefined && position !== null && position !== ''
    let finalPos = 'br'
    let invalidPos = false
    if (givenPos) {
      const picked = pickEnum(String(position).trim(), POSITIONS, null)
      if (picked) finalPos = picked
      else invalidPos = true
    }

    const orderId = genHandoffId('AI')
    const notes = []
    if (!finalText) notes.push('水印文字留待用户在页面内输入')
    if (truncated) notes.push('文字超过 60 字已截断')
    if (invalidPos) notes.push(`位置「${position}」不在枚举（${POSITIONS.join('/')}）内，已使用默认 br（右下角）；禁止再次用同一非法值调用`)

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `水印参数已准备好（${finalText ? '文字「' + finalText + '」，' : ''}位置 ${finalPos}；${notes.length ? notes.join('；') : '参数均合法'}）。本接口无法替用户选择图片：请用一句简短话术引导用户点击下方小程序卡片进入水印页，在页面内选图并确认效果。禁止以文本铺开参数细节。`
      }],
      structuredContent: {
        toolId: TOOL_ID,
        orderId,
        params: { type: 'text', text: finalText, position: finalPos },
        pagePath: PAGE_PATH,
        needsFileSelection: true
      },
      handoff: {
        query: buildQuery({ toolId: TOOL_ID, orderId, text: finalText, position: finalPos }),
        payload: { orderId, toolId: TOOL_ID, params: { type: 'text', text: finalText, position: finalPos }, from: 'ai' }
      },
      _meta: { card: { title: '批量水印', desc: finalText ? `「${finalText}」· ${finalPos}` : `位置 ${finalPos}`, pagePath: PAGE_PATH } }
    }
  } catch (err) {
    console.error('[addWatermark] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `准备水印参数失败：${err.message || '未知错误'}。正确出口：引导用户直接进入批量水印页在页内设置。` }]
    }
  }
}

module.exports = addWatermark
