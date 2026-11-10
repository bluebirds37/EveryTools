// startVideoCompress —— 视频压缩参数准备 + 出卡接力（FR-AI-02；参数同源 FR-VID-01）
// 云端任务：选视频、分片上传、任务轮询均在接力页内完成（FR-AI-09 游客进入后页面自动静默登录）。
const { buildQuery, clampInt, pickEnum, genHandoffId } = require('../utils/query.js')

const TOOL_ID = 'video-compress'
const PAGE_PATH = '/packageVideo/pages/compress/index'
// FR-VID-01 resolution 枚举
const RESOLUTIONS = ['source', '1080p', '720p', '480p', '360p']

async function startVideoCompress({ targetMB, resolution } = {}) {
  try {
    const givenMB = targetMB !== undefined && targetMB !== null && targetMB !== ''
    const normalized = {
      mode: 'target',
      targetMB: givenMB ? clampInt(targetMB, 5, 200, 20) : 20,
      resolution: resolution !== undefined && resolution !== null && resolution !== ''
        ? (pickEnum(String(resolution).trim(), RESOLUTIONS, '720p') || '720p')
        : '720p'
    }
    const clamped = givenMB && normalized.targetMB !== Number(targetMB)
    const orderId = genHandoffId('AI')

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `视频压缩参数已准备好（目标 ${normalized.targetMB}MB，输出 ${normalized.resolution === 'source' ? '保持原分辨率' : normalized.resolution}${clamped ? '；目标体积已按 5–200MB 范围修正' : ''}）。本接口无法访问用户相册/视频：请用一句简短话术引导用户点击下方小程序卡片进入压缩页，在页面内选择视频后开始上传与压缩（云端处理约 1–2 分钟，游客会在页内自动完成静默登录）。${clamped ? '禁止再次用相同越界参数调用本接口。' : ''}禁止以文本铺开参数细节。`
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
        query: buildQuery({ toolId: TOOL_ID, orderId, targetMB: normalized.targetMB, resolution: normalized.resolution }),
        payload: { orderId, toolId: TOOL_ID, params: normalized, from: 'ai' }
      },
      _meta: { card: { title: '视频压缩', desc: `目标 ${normalized.targetMB}MB · ${normalized.resolution}`, pagePath: PAGE_PATH } }
    }
  } catch (err) {
    console.error('[startVideoCompress] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `准备视频压缩参数失败：${err.message || '未知错误'}。正确出口：引导用户直接进入视频压缩页在页内设置参数并选择视频。` }]
    }
  }
}

module.exports = startVideoCompress
