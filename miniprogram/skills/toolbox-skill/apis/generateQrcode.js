// generateQrcode —— 二维码生成参数准备 + 出卡接力（requirements §7.3；参数同源 FR-QR-01）
// content 必须来自用户原话【禁止编造】；生成动作（渲染/自检/保存）在接力页内完成。
const { buildQuery, pickEnum } = require('../utils/query.js')

const TOOL_ID = 'qr-generate'
const PAGE_PATH = '/packageQr/pages/generate/index'
// FR-QR-01 type 枚举
const TYPES = ['text', 'url', 'wifi', 'vcard', 'sms', 'tel', 'geo']

async function generateQrcode({ content, type } = {}) {
  try {
    const text = typeof content === 'string' ? content.trim() : ''
    if (!text) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: '缺少要编码的内容。禁止替用户编造内容（如随意生成示例网址）。正确出口：先向用户询问要生成二维码的内容（文本/网址/WiFi 等），拿到原话后携 content 再调用本接口。'
        }]
      }
    }
    if (text.length > 1000) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `内容过长（${text.length} 字符，上限 1000），二维码密度过高可能无法扫读。禁止截断用户内容后调用。正确出口：告知用户把内容缩短（或改为链接），或点击下方入口进入小程序二维码生成页处理。`
        }]
      }
    }

    const finalType = type !== undefined && type !== null && type !== ''
      ? (pickEnum(String(type).trim(), TYPES, null) || 'text')
      : 'text'

    // type=url 轻量校验 scheme（FR-QR-01「url 带 scheme 校验」），缺失则按 text 生成并提示
    let actualType = finalType
    let schemeNote = ''
    if (finalType === 'url' && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.+/.test(text)) {
      actualType = 'text'
      schemeNote = '内容不是带 http(s) 等协议头的网址，已按普通文本处理。'
    }

    const params = { type: actualType, content: text, size: 512, ecc: 'M' }

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `二维码内容已备好（${actualType} 类型，${text.length} 字符）。${schemeNote}请用一句简短话术引导用户点击下方小程序卡片进入二维码生成页，在页面内确认样式（尺寸/容错/配色）并生成保存。禁止在对话里以文本重复输出完整编码内容。`
      }],
      structuredContent: {
        toolId: TOOL_ID,
        params: { type: actualType, contentLength: text.length },
        pagePath: PAGE_PATH,
        presetContent: true
      },
      handoff: {
        query: buildQuery({ toolId: TOOL_ID, content: text, type: actualType }),
        payload: { toolId: TOOL_ID, params, from: 'ai' }
      },
      _meta: { card: { title: '二维码生成', desc: `${actualType} · ${text.length} 字符`, pagePath: PAGE_PATH } }
    }
  } catch (err) {
    console.error('[generateQrcode] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `准备二维码参数失败：${err.message || '未知错误'}。正确出口：引导用户直接进入二维码生成页手动输入内容。` }]
    }
  }
}

module.exports = generateQrcode
