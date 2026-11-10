// searchTools —— 检索 / 浏览工具清单（FR-AI-04；requirements §7.3）
// 规范（对齐 ai-mode-demo searchDrinks）：
// - keyword 有值：按 name / keywords / desc / id 命中检索；keyword 留空：返回全部在线工具（按分类分组）
// - content：「事实陈述 + 业务动作」两段式，禁止纯文本铺开工具清单
// - structuredContent：Agent 可见精简结构；_meta.viewItems：渲染数据（accent 等），Agent 不可见
// - 失败分支：带关键词零命中 → isError:true，文案给唯一正确出口，禁止编造关键词重试
const catalog = require('../data/catalog.js')
const { buildQuery } = require('../utils/query.js')

async function searchTools({ keyword } = {}) {
  try {
    const hasKw = !!(keyword && typeof keyword === 'string' && keyword.trim())
    const matched = hasKw ? catalog.search(keyword) : catalog.online()

    if (hasKw && !matched.length) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `未在工具清单中匹配到包含「${keyword}」的工具。禁止编造关键词再次调用本接口。正确出口：引导用户换个说法（如压缩、裁剪、二维码、换算）重新调用，或不带关键词调用本接口返回全部在线工具；若用户要的功能确实不在清单内，直接回复「该能力暂不支持」。`
        }]
      }
    }

    const toItem = (t) => ({
      toolId: t.id,
      name: t.name,
      desc: t.desc,
      category: t.category,
      categoryName: catalog.categoryName(t.category),
      aiApi: t.aiApi || null,
      entry: t.entry
    })

    // 无关键词时按分类分组（FR-AI-04），有关键词时平铺按相关度排序
    let groups = null
    if (!hasKw) {
      groups = catalog.CATEGORY_META.map((c) => ({
        category: c.id,
        categoryName: c.name,
        count: catalog.byCategory(c.id).length
      })).filter((g) => g.count > 0)
    }

    const items = matched.map(toItem)
    const viewItems = matched.map((t) => {
      let accent = ''
      for (let i = 0; i < catalog.CATEGORY_META.length; i++) {
        if (catalog.CATEGORY_META[i].id === t.category) { accent = catalog.CATEGORY_META[i].accent; break }
      }
      return Object.assign(toItem(t), { accent, hot: !!t.hot })
    })

    return {
      isError: false,
      content: [{
        type: 'text',
        text: hasKw
          ? `已搜索到 ${matched.length} 个匹配「${keyword}」的工具。本次检索已完成，请直接用一句简短话术引导用户点击下方小程序卡片，在结果列表中自行挑选，禁止再次调用检索接口重复筛选。禁止以文本罗列工具名称、简介或参数细节。`
          : `已为用户列出全部 ${matched.length} 个在线工具（按分类分组）。请用一句简短话术引导用户点击下方小程序卡片进入首页浏览，禁止以文本罗列工具清单。`
      }],
      structuredContent: {
        items,
        total: matched.length,
        keyword: hasKw ? String(keyword).trim() : null,
        groups
      },
      handoff: {
        query: hasKw ? buildQuery({ keyword: String(keyword).trim() }) : '',
        payload: { keyword: hasKw ? String(keyword).trim() : null, items: viewItems }
      },
      _meta: { viewItems }
    }
  } catch (err) {
    console.error('[searchTools] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `工具检索失败：${err.message || '未知错误'}。请引导用户稍后重试，或在小程序首页直接浏览。` }]
    }
  }
}

module.exports = searchTools
