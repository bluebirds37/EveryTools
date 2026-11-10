/**
 * packageVideo/utils/video-estimate.js —— 预估大小/耗时与人读格式化（纯函数，可 node 单测）
 * 由 video-common.js 聚合导出（页面统一从 video-common 引用），拆分原因：C1 单文件 ≤400 行。
 * FR-VID-01 反算规则：视频码率 = (targetMB*8192/时长) - 音频码率，向下取安全余量 5%。
 */

function isFiniteNum(v) {
  return typeof v === 'number' && isFinite(v)
}

/** 字节 → 人读体积（KB / MB） */
function formatSize(bytes) {
  const b = isFiniteNum(bytes) && bytes > 0 ? bytes : 0
  if (b >= 1048576) return (b / 1048576).toFixed(b >= 10485760 ? 0 : 1) + 'MB'
  if (b >= 1024) return Math.round(b / 1024) + 'KB'
  return b + 'B'
}

/** 秒 → 「1分12秒」/「12.3秒」 */
function formatDuration(sec) {
  const s = isFiniteNum(sec) && sec > 0 ? sec : 0
  if (s < 60) return (Math.round(s * 10) / 10) + '秒'
  return Math.floor(s / 60) + '分' + Math.round(s % 60) + '秒'
}

/** (in-out)/in 节省百分比；参数非法或结果更大时返回 null（页面不显示负节省） */
function savePercent(beforeBytes, afterBytes) {
  if (!isFiniteNum(beforeBytes) || beforeBytes <= 0) return null
  if (!isFiniteNum(afterBytes) || afterBytes <= 0) return null
  const pct = Math.round(((beforeBytes - afterBytes) / beforeBytes) * 100)
  return pct > 0 ? pct : null
}

const AUDIO_KBPS = { '64k': 64, '96k': 96, '128k': 128, '192k': 192, '320k': 320 }
const PRESET_FACTOR = { ultrafast: 0.35, superfast: 0.5, fast: 0.7, medium: 1, slow: 1.5, slower: 2.2, veryslow: 3 }

/** kbps×秒 → MB（1MB = 8192kbit，与 FR-VID-01 反算公式同一单位体系） */
function kbpsSecToMB(kbps, sec) {
  if (!isFiniteNum(kbps) || kbps <= 0 || !isFiniteNum(sec) || sec <= 0) return 0
  return Math.round(((kbps * sec) / 8192) * 100) / 100
}

/**
 * FR-VID-01 target 模式反算视频码率（含 5% 安全余量）。
 * @param {{targetMB:number,durationSec:number,audioBitrate?:string,keepAudio?:boolean,margin?:number}} o
 * @returns {null|{videoKbps:number,audioKbps:number,predictedMB:number}} duration<=0 等非法输入返回 null（不 NaN）
 */
function estimateTargetBitrate(o) {
  const opt = o || {}
  const target = Number(opt.targetMB)
  const dur = Number(opt.durationSec)
  if (!isFiniteNum(target) || target <= 0 || !isFiniteNum(dur) || dur <= 0) return null
  const audioKbps = opt.keepAudio === false ? 0 : AUDIO_KBPS[opt.audioBitrate] || 128
  const raw = (target * 8192) / dur - audioKbps
  const margin = isFiniteNum(opt.margin) ? opt.margin : 0.05
  const videoKbps = Math.max(300, Math.floor(raw * (1 - margin)))
  return {
    videoKbps: videoKbps,
    audioKbps: audioKbps,
    predictedMB: kbpsSecToMB(videoKbps + audioKbps, dur)
  }
}

/** 上传预估耗时：4MB 分片并发 2（FR-V-00.2），按 ~1.2MB/s 有效上行估（展示用，误差有文案兜底） */
function estimateUploadSec(sizeBytes) {
  const mb = isFiniteNum(sizeBytes) && sizeBytes > 0 ? sizeBytes / 1048576 : 0
  if (mb <= 0) return 0
  return Math.max(3, Math.ceil(mb / 1.2))
}

/** 处理预估耗时：时长 × preset 系数；target 模式两遍编码 ×2；再加 5s 排队常数 */
function estimateProcessSec(durationSec, preset, twoPass) {
  const d = isFiniteNum(durationSec) && durationSec > 0 ? durationSec : 0
  const f = PRESET_FACTOR[preset] || 1
  const base = d * f * (twoPass ? 2 : 1)
  return Math.ceil(base) + 5
}

/** 预估总耗时 → 「预计约 1分20秒」 */
function estimateEtaText(uploadSec, processSec) {
  const total = (isFiniteNum(uploadSec) ? uploadSec : 0) + (isFiniteNum(processSec) ? processSec : 0)
  if (total <= 0) return ''
  return '预计约 ' + formatDuration(total)
}

/** 结果 meta：原大小 vs 结果大小 + 节省百分比 + 耗时 + 引擎 + 服务端说明（GIF 自动降档等必须如实透传） */
function buildMeta(beforeBytes, result, costMs, engine) {
  const parts = []
  const r = result || {}
  if (isFiniteNum(beforeBytes) && beforeBytes > 0) parts.push('原 ' + formatSize(beforeBytes))
  if (isFiniteNum(r.sizeMB) && r.sizeMB > 0) {
    const after = r.sizeMB * 1048576
    parts.push('结果 ' + formatSize(after))
    const sp = savePercent(beforeBytes, after)
    if (sp != null) parts.push('节省 ' + sp + '%')
  }
  if (isFiniteNum(costMs) && costMs > 0) parts.push('耗时 ' + Math.round(costMs / 100) / 10 + 's')
  parts.push('引擎 ' + (engine === 'client' ? '本地' : '云端'))
  if (r.meta) parts.push(String(r.meta))
  return parts.join(' · ')
}

module.exports = {
  formatSize: formatSize,
  formatDuration: formatDuration,
  savePercent: savePercent,
  kbpsSecToMB: kbpsSecToMB,
  estimateTargetBitrate: estimateTargetBitrate,
  estimateUploadSec: estimateUploadSec,
  estimateProcessSec: estimateProcessSec,
  estimateEtaText: estimateEtaText,
  buildMeta: buildMeta,
  AUDIO_KBPS: AUDIO_KBPS
}
