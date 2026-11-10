/**
 * packageVideo/utils/timeline.js —— 时间轴坐标 ⇄ 秒数换算（FR-VID-02 纯函数，可单测）
 *
 * 约定：
 *  - 所有对外秒数一律经 round1() 保留 0.1s 精度（拖动与数字输入共用同一量化）。
 *  - duration <= 0（未探测到时长）时所有换算返回 0 / 空集合，绝不产生 NaN。
 *  - 越界输入夹取到 [0, duration]，页面拿到的永远是合法秒数。
 */

function isFiniteNum(v) {
  return typeof v === 'number' && isFinite(v)
}

/** 量化到 0.1s（消除浮点尾差：0.1+0.2 → 0.3） */
function round1(v) {
  if (!isFiniteNum(v)) return 0
  return Math.round(v * 10) / 10
}

/** 夹取到 [0, max]；max 非正数时结果为 0 */
function clamp(v, max) {
  const m = isFiniteNum(max) && max > 0 ? max : 0
  const x = isFiniteNum(v) ? v : 0
  if (x < 0) return round1(0)
  if (x > m) return round1(m)
  return round1(x)
}

/**
 * 时间轴位移(px) → 秒数
 * @param {number} offsetPx 触点相对轨道左端的位移
 * @param {number} widthPx 轨道可视宽度
 * @param {number} duration 视频总时长(秒)
 * @returns {number} [0,duration] 内、0.1s 精度的秒数；宽度/时长非法时为 0
 */
function toSec(offsetPx, widthPx, duration) {
  if (!isFiniteNum(duration) || duration <= 0) return 0
  if (!isFiniteNum(widthPx) || widthPx <= 0) return 0
  const ratio = (isFiniteNum(offsetPx) ? offsetPx : 0) / widthPx
  return clamp(ratio * duration, duration)
}

/**
 * 秒数 → 轨道百分比（渲染手柄位置用）
 * @returns {number} 0–100；duration<=0 时恒为 0
 */
function toPercent(sec, duration) {
  if (!isFiniteNum(duration) || duration <= 0) return 0
  const s = clamp(sec, duration)
  return Math.round((s / duration) * 1000) / 10
}

/**
 * 时钟文本 → 秒。支持 "s"、"ss.t"、"m:ss(.t)"、"h:m:ss"。非法返回 null。
 */
function fromClock(text) {
  const s = String(text == null ? '' : text).trim()
  if (!s || !/^\d{1,4}(:\d{1,2}(\.\d{1,2})?|\.\d{1,2})$/.test(s)) return null
  const parts = s.split(':').map(Number)
  if (parts.some((n) => !isFiniteNum(n))) return null
  let sec = 0
  for (let i = 0; i < parts.length; i++) sec = sec * 60 + parts[i]
  return round1(sec)
}

/** 秒 → "m:ss" 展示文本（负数/NaN 归零） */
function toClock(sec) {
  const total = isFiniteNum(sec) && sec > 0 ? Math.floor(sec) : 0
  const m = Math.floor(total / 60)
  const s = total % 60
  return m + ':' + (s < 10 ? '0' + s : '' + s)
}

/** 秒 → "m:ss.t" 带十分位（时间轴读数用） */
function toClockPrecise(sec) {
  const v = round1(Math.max(0, isFiniteNum(sec) ? sec : 0))
  const whole = Math.floor(v)
  const tenth = Math.round((v - whole) * 10)
  return toClock(whole) + '.' + tenth
}

/**
 * 起止区间校验（FR-VID-02：0 ≤ start < end ≤ duration，end-start ≤ maxSpan）。
 * @param {{minSpan?:number,maxSpan?:number}} [opt] minSpan 默认 0.1s，maxSpan 默认 600s
 * @returns {null|{code:string, extra:object}} null=合法；否则错误码与插值（经 error.message 出话术）
 */
function validateRange(startSec, endSec, duration, opt) {
  const o = opt || {}
  const minSpan = isFiniteNum(o.minSpan) ? o.minSpan : 0.1
  const maxSpan = isFiniteNum(o.maxSpan) ? o.maxSpan : 600
  const d = isFiniteNum(duration) && duration > 0 ? duration : 0
  if (!isFiniteNum(startSec) || !isFiniteNum(endSec)) {
    return { code: 'PARAM_INVALID', extra: { field: '起止时间', range: '数字 0.1s 精度' } }
  }
  if (startSec < 0 || endSec < 0) {
    return { code: 'PARAM_INVALID', extra: { field: '起止时间', range: '不早于 0s' } }
  }
  if (d > 0 && (startSec > d || endSec > d)) {
    return { code: 'PARAM_INVALID', extra: { field: '起止时间', range: '0 ~ ' + round1(d) + 's（视频时长内）' } }
  }
  if (round1(endSec) - round1(startSec) < minSpan) {
    return { code: 'PARAM_INVALID', extra: { field: '片段时长', range: '不小于 ' + minSpan + 's' } }
  }
  if (round1(endSec) - round1(startSec) > maxSpan) {
    return { code: 'PARAM_INVALID', extra: { field: '片段时长', range: '不超过 ' + maxSpan + 's' } }
  }
  return null
}

/**
 * 在 [start,end] 内均匀取 count 个关键帧时间点（本地预览帧 / 抽帧预览用）。
 * count 非法或区间为空时返回 []；duration=0 时不产生 NaN。
 */
function keyframeTimes(startSec, endSec, count) {
  const n = isFiniteNum(count) ? Math.floor(count) : 0
  if (n <= 0 || n > 30) return []
  const a = Math.max(0, isFiniteNum(startSec) ? startSec : 0)
  const b = Math.max(a, isFiniteNum(endSec) ? endSec : a)
  if (b <= a) return [round1(a)]
  const out = []
  for (let i = 0; i < n; i++) {
    out.push(round1(a + ((b - a) * (i + 0.5)) / n)) // 帧中心对齐（与 FR-VID-05 验收同一公式）
  }
  return out
}

/**
 * 降级刻度条：无雪碧图时把轨道分成 count 段，返回刻度 {sec,label,percent}。
 */
function ticks(duration, count) {
  const d = isFiniteNum(duration) && duration > 0 ? duration : 0
  const n = isFiniteNum(count) ? Math.max(2, Math.floor(count)) : 6
  const out = []
  for (let i = 0; i <= n; i++) {
    const sec = d > 0 ? round1((d * i) / n) : 0
    out.push({ sec: sec, label: toClock(sec), percent: d > 0 ? Math.round((i / n) * 1000) / 10 : 0 })
  }
  return out
}

/**
 * 双手柄拖动布局：给定新起点秒数，保持片段长度不变地平移 end（并夹取回视频内）。
 * @returns {{startSec:number,endSec:number}}
 */
function shiftRange(startSec, endSec, duration) {
  const d = isFiniteNum(duration) && duration > 0 ? duration : 0
  const span = round1(Math.max(0, (isFiniteNum(endSec) ? endSec : 0) - (isFiniteNum(startSec) ? startSec : 0)))
  let ns = clamp(startSec, d)
  let ne = round1(ns + span)
  if (d > 0 && ne > d) {
    ne = round1(d)
    ns = round1(Math.max(0, ne - span))
  }
  return { startSec: ns, endSec: ne }
}

module.exports = {
  round1: round1,
  clamp: clamp,
  toSec: toSec,
  toPercent: toPercent,
  fromClock: fromClock,
  toClock: toClock,
  toClockPrecise: toClockPrecise,
  validateRange: validateRange,
  keyframeTimes: keyframeTimes,
  ticks: ticks,
  shiftRange: shiftRange
}
