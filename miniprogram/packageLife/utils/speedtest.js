/**
 * 网速测试核心（FR-LIF-07）—— 纯函数：带宽/TTFB/抖动换算与结果组装
 * 下载动作由页面用 wx.downloadFile 执行，本模块只做计算。
 */

/** 带宽 Mbps：bytes / ms → (bytes*8/1000000) / (ms/1000) */
function mbps(bytes, ms) {
  if (!(bytes > 0) || !(ms > 0)) return 0
  return (bytes * 8 / 1000000) / (ms / 1000)
}

function fmtMbps(v) {
  return v.toFixed(1)
}

/** 抖动：三次采样最大值−最小值（Mbps） */
function jitter(samples) {
  const arr = (samples || []).filter(function (s) { return s > 0 })
  if (arr.length < 2) return 0
  return Math.max.apply(null, arr) - Math.min.apply(null, arr)
}

/** 延迟参考评级（按 Mbps 区间给定性结论） */
function grade(v) {
  if (v >= 100) return '优秀（100 Mbps 以上）'
  if (v >= 50) return '良好（50–100 Mbps）'
  if (v >= 20) return '中等（20–50 Mbps）'
  if (v >= 5) return '一般（5–20 Mbps）'
  if (v > 0) return '较慢（低于 5 Mbps）'
  return '未测得'
}

/** 组装结果 kv 列表 */
function toKv(r) {
  return [
    { key: '下载带宽', value: fmtMbps(r.mbps) + ' Mbps（' + grade(r.mbps) + '）' },
    { key: '服务器延迟 TTFB', value: r.ttfbMs != null ? r.ttfbMs + ' ms' : '未测得' },
    { key: '抖动（3 次采样极差）', value: fmtMbps(r.jitterMbps) + ' Mbps' },
    { key: '采样明细', value: r.samples.map(fmtMbps).join(' / ') + ' Mbps' },
    { key: '测试文件大小', value: r.sizeMB + ' MB ×3' },
    { key: '测试节点', value: r.node },
    { key: '测试时间', value: r.at }
  ]
}

function buildText(r) {
  return toKv(r).map(function (x) { return x.key + ': ' + x.value }).join('\n')
}

module.exports = {
  mbps: mbps,
  jitter: jitter,
  grade: grade,
  fmtMbps: fmtMbps,
  toKv: toKv,
  buildText: buildText
}
