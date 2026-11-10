// getToolDetail —— 查看单个工具的元信息与接力页可消费参数（requirements §7.3）
// 前置条件：toolId 必须来自 searchTools 返回的 items[].toolId 原值，【禁止编造】
// 返回：工具元信息 + 默认参数（接力页预置用）+ handoff 到工具详情页
const catalog = require('../data/catalog.js')
const { buildQuery } = require('../utils/query.js')

async function getToolDetail({ toolId } = {}) {
  try {
    if (!toolId || typeof toolId !== 'string') {
      return {
        isError: true,
        content: [{ type: 'text', text: '缺少 toolId。禁止编造，应先调用 searchTools 并取其返回的 items[].toolId 原值。' }]
      }
    }
    const tool = catalog.get(toolId)
    if (!tool) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `不存在 toolId=${toolId} 的工具。禁止编造 ID 或改写用户提到的名称后重试。正确出口：调用 searchTools（keyword 用用户原话关键词）获取有效 toolId 后重试；若检索零命中，直接回复用户「该能力暂不支持」。`
        }]
      }
    }
    if (tool.status === 'offline') {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `「${tool.name}」当前未上架（status=offline）。禁止引导用户访问未开放页面或编造相近工具。正确出口：调用 searchTools 不带关键词返回全部在线工具，让用户从中挑选替代。`
        }]
      }
    }

    const structuredContent = {
      toolId: tool.id,
      name: tool.name,
      desc: tool.desc,
      category: tool.category,
      categoryName: catalog.categoryName(tool.category),
      keywords: tool.keywords,
      fr: tool.fr,
      engine: tool.engine,
      status: tool.status,
      aiApi: tool.aiApi || null,
      params: tool.aiDefaults || {},
      entry: tool.entry
    }

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `已获取「${tool.name}」的工具详情（${structuredContent.categoryName}类，${tool.engine === 'client' ? '纯本地处理' : (tool.engine === 'server' ? '云端处理' : '本地优先、超限自动走云端')}${tool.aiApi ? '，支持 AI 直达' : ''}）。请用一句简短话术引导用户点击下方小程序卡片查看详情，禁止以文本铺开参数表。`
      }],
      structuredContent,
      handoff: {
        query: buildQuery({ toolId: tool.id }),
        payload: { tool: structuredContent }
      },
      _meta: {
        tool: Object.assign({}, structuredContent, {
          hot: !!tool.hot
        })
      }
    }
  } catch (err) {
    console.error('[getToolDetail] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `获取工具详情失败：${err.message || '未知错误'}。请引导用户稍后重试。` }]
    }
  }
}

module.exports = getToolDetail
