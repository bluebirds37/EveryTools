// startImageCrop —— 图片裁剪参数准备 + 出卡接力（FR-AI-02；参数同源 FR-IMG-02）
// 选图发生在接力页内；ratio 必须来自用户原话，未明说用默认 'free'（自由裁剪）。
const { buildQuery, pickEnum, genHandoffId } = require('../utils/query.js')

const TOOL_ID = 'image-crop'
const PAGE_PATH = '/packageImage/pages/crop/index'
// FR-IMG-02 ratio 枚举（英文/符号值，禁止中文）
const RATIOS = ['free', '1:1', '4:3', '3:4', '16:9', '9:16', 'original']

async function startImageCrop({ ratio } = {}) {
  try {
    const given = ratio !== undefined && ratio !== null && ratio !== ''
    let normalized = 'free'
    let invalid = false
    if (given) {
      const picked = pickEnum(String(ratio).trim(), RATIOS, null)
      if (picked) normalized = picked
      else invalid = true // 非法比例 → 回落默认，但明确告知
    }

    const orderId = genHandoffId('AI')
    const hint = invalid
      ? `用户提到的比例「${ratio}」不在支持列表内，已回落为自由裁剪。支持的裁剪比例仅枚举：${RATIOS.join(' / ')}。禁止再次用同一非法值调用本接口。`
      : ''

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `图片裁剪参数已准备好（比例 ${normalized}）。本接口无法替用户选择图片：请用一句简短话术引导用户点击下方小程序卡片进入裁剪页，在页面内选图并框选裁剪区域。${hint}禁止以文本铺开参数细节。`
      }],
      structuredContent: {
        toolId: TOOL_ID,
        orderId,
        params: { ratio: normalized },
        pagePath: PAGE_PATH,
        needsFileSelection: true
      },
      handoff: {
        query: buildQuery({ toolId: TOOL_ID, orderId, ratio: normalized }),
        payload: { orderId, toolId: TOOL_ID, params: { ratio: normalized }, from: 'ai' }
      },
      _meta: { card: { title: '图片裁剪', desc: `比例 ${normalized}`, pagePath: PAGE_PATH } }
    }
  } catch (err) {
    console.error('[startImageCrop] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `准备裁剪参数失败：${err.message || '未知错误'}。正确出口：引导用户直接进入图片裁剪页设置比例。` }]
    }
  }
}

module.exports = startImageCrop
