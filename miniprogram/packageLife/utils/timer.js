/**
 * 秒表/倒计时核心（FR-LIF-03）—— 纯函数：一切以 Date.now() 时间戳为基准，
 * setInterval 只负责刷 UI，不参与计时累加（防漂移；10 分钟误差 ≤1s 由系统时钟保证）。
 */

/** 秒表状态：{ startAt, accumMs, running } */
function swCreate() {
  return { startAt: 0, accumMs: 0, running: false, laps: [] }
}

function swStart(state, now) {
  if (state.running) return state
  return Object.assign({}, state, { startAt: now, running: true })
}

function swPause(state, now) {
  if (!state.running) return state
  return Object.assign({}, state, { accumMs: state.accumMs + (now - state.startAt), startAt: 0, running: false })
}

function swReset(state) {
  return swCreate()
}

function swElapsed(state, now) {
  return state.accumMs + (state.running ? now - state.startAt : 0)
}

/** 分段：追加 { no, totalMs, splitMs }（splitMs = 与上一段的差） */
function swLap(state, now) {
  const total = swElapsed(state, now)
  const prev = state.laps.length ? state.laps[state.laps.length - 1].totalMs : 0
  const laps = state.laps.concat([{ no: state.laps.length + 1, totalMs: total, splitMs: total - prev }])
  return Object.assign({}, state, { laps: laps })
}

/** 倒计时状态：{ endAt, remainMs, running, done } —— 多路各自独立 */
function cdCreate(totalMs) {
  return { endAt: 0, remainMs: Math.max(0, totalMs), running: false, done: false }
}

function cdStart(state, now) {
  if (state.running || state.remainMs <= 0) return state
  return Object.assign({}, state, { endAt: now + state.remainMs, running: true, done: false })
}

function cdPause(state, now) {
  if (!state.running) return state
  return Object.assign({}, state, { remainMs: Math.max(0, state.endAt - now), endAt: 0, running: false })
}

function cdReset(state, totalMs) {
  return cdCreate(totalMs)
}

/** 剩余毫秒（切后台后 onShow 用当前时间重算即自动校准） */
function cdRemain(state, now) {
  if (state.running) return Math.max(0, state.endAt - now)
  return Math.max(0, state.remainMs)
}

/** 秒表显示 mm:ss.cc（>1h 前缀 h:） */
function fmtStopwatch(ms) {
  const total = Math.max(0, Math.floor(ms))
  const cs = Math.floor((total % 1000) / 10)
  const s = Math.floor(total / 1000) % 60
  const m = Math.floor(total / 60000) % 60
  const h = Math.floor(total / 3600000)
  const p2 = function (n) { return n < 10 ? '0' + n : '' + n }
  const p10 = function (n) { return n < 10 ? '0' + n : '' + n }
  const core = p2(m) + ':' + p2(s) + '.' + p10(cs)
  return h > 0 ? h + ':' + core : core
}

/** 倒计时显示 h:mm:ss（不足 1 小时去前缀） */
function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const s = total % 60
  const m = Math.floor(total / 60) % 60
  const h = Math.floor(total / 3600)
  const p2 = function (n) { return n < 10 ? '0' + n : '' + n }
  return h > 0 ? h + ':' + p2(m) + ':' + p2(s) : p2(m) + ':' + p2(s)
}

/**
 * 多路倒计时轮询：返回新状态数组 + 本轮刚结束的索引（供震动/提示）
 * tick(items, now) —— items: [{id,label,state}] state 为 cd* 系列结构
 */
function cdTick(items, now) {
  const finished = []
  const next = items.map(function (it, idx) {
    if (it.state.running && it.state.endAt <= now) {
      finished.push(idx)
      return Object.assign({}, it, { state: { endAt: 0, remainMs: 0, running: false, done: true } })
    }
    return it
  })
  return { items: next, finished: finished }
}

module.exports = {
  swCreate: swCreate,
  swStart: swStart,
  swPause: swPause,
  swReset: swReset,
  swElapsed: swElapsed,
  swLap: swLap,
  cdCreate: cdCreate,
  cdStart: cdStart,
  cdPause: cdPause,
  cdReset: cdReset,
  cdRemain: cdRemain,
  cdTick: cdTick,
  fmtStopwatch: fmtStopwatch,
  fmtCountdown: fmtCountdown
}
