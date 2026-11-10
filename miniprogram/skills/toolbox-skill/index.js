/**
 * toolbox-skill 入口 —— 注册 13 条原子接口（requirements §7.2 / FR-AI-08）
 *
 * 范式对齐 ai-mode-demo/skills/drink-skill/index.js：
 *   wx.modelContext.createSkill(path) + skill.registerAPI(name, handler)，
 *   path 与 app.json 的 agent.skills[].path 一致，name 与 mcp.json apis[].name 严格一致。
 *
 * 降级（FR-AI-08 / §7.6）：基础库不支持 wx.modelContext 时 console.warn 并静默跳过，
 * 不抛出、不影响小程序主流程。
 */
const apis = [
  ['searchTools', require('./apis/searchTools.js')],
  ['getToolDetail', require('./apis/getToolDetail.js')],
  ['startImageCompress', require('./apis/startImageCompress.js')],
  ['startImageCrop', require('./apis/startImageCrop.js')],
  ['addWatermark', require('./apis/addWatermark.js')],
  ['startVideoCompress', require('./apis/startVideoCompress.js')],
  ['videoToGif', require('./apis/videoToGif.js')],
  ['extractFrames', require('./apis/extractFrames.js')],
  ['generateQrcode', require('./apis/generateQrcode.js')],
  ['formatJson', require('./apis/formatJson.js')],
  ['convertUnit', require('./apis/convertUnit.js')],
  ['calcDateRange', require('./apis/calcDateRange.js')],
  ['listHistory', require('./apis/listHistory.js')]
]

function register() {
  try {
    if (typeof wx === 'undefined' || !wx.modelContext || !wx.modelContext.createSkill) {
      console.warn('[toolbox-skill] 当前基础库不支持 wx.modelContext，AI 原子接口跳过注册')
      return
    }
    const skill = wx.modelContext.createSkill('skills/toolbox-skill')
    for (let i = 0; i < apis.length; i++) {
      skill.registerAPI(apis[i][0], apis[i][1])
    }
    console.log('[toolbox-skill] ' + apis.length + ' APIs registered via createSkill')
  } catch (err) {
    console.warn('[toolbox-skill] 注册失败（不影响主流程）', err && err.message)
  }
}

register()

module.exports = { apis, register }
