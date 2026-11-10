/**
 * 安全随机核心（FR-CAL-07）—— 纯函数模块
 * 随机源：wx.getRandomValues 优先（seedFromWx 注入种子），兜底 Math.random 混合种子。
 * PRNG：xorshift128+（确定性序列，可测试；转盘等场景先算结果再做动画）。
 */

let s0 = 0, s1 = 0, seeded = false

function mixSeed(num) {
  // splitmix64 风格的混合（double 域近似），避免弱种子
  s0 = (s0 ^ num) >>> 0
  s1 = (s1 * 1664525 + ((num + 1013904223) >>> 0)) >>> 0
  if (s0 === 0 && s1 === 0) s0 = 0x9e3779b9
}

function ensureSeed() {
  if (seeded) return
  seeded = true
  const t = Date.now()
  s0 = (t & 0xffffffff) >>> 0
  s1 = (Math.floor(t / 4294967296) * 2654435761 ^ Math.floor(Math.random() * 0xffffffff)) >>> 0
  for (let k = 0; k < 8; k++) {
    s0 = (s0 * 1103515245 + Math.floor(Math.random() * 1e6) + 12345) >>> 0
    s1 = (s1 * 1103515245 + Math.floor(Math.random() * 1e6) + 67891) >>> 0
  }
}

/** 若基础库支持 wx.getRandomValues，用其字节流重新播种（优先熵源） */
function seedFromWx(u8) {
  if (!u8 || !u8.length) return
  seeded = true
  let a = 0, b = 0
  for (let k = 0; k < u8.length; k++) {
    if (k % 2 === 0) a = ((a << 8) | u8[k]) >>> 0
    else b = ((b << 8) | u8[k]) >>> 0
  }
  s0 = (a || 0x9e3779b9) >>> 0
  s1 = (b || 0x85ebca6b) >>> 0
}

function nextU32() {
  ensureSeed()
  // xorshift128 变体（32bit 域）
  let x = s0 ^ ((s0 << 13) >>> 0)
  x = (x ^ (x >>> 17)) >>> 0
  x = (x ^ (x << 5)) >>> 0
  s0 = s1
  s1 = (s1 ^ x) >>> 0
  return x >>> 0
}

/** [0,1) 均匀分布 */
function random() {
  return nextU32() / 4294967296
}

/** [min,max] 闭区间整数 */
function intIn(min, max) {
  const a = Math.ceil(Number(min)), b = Math.floor(Number(max))
  if (!(a <= b)) return null
  return a + Math.floor(random() * (b - a + 1))
}

/** [min,max) 浮点 */
function floatIn(min, max, decimals) {
  const v = Number(min) + random() * (Number(max) - Number(min))
  const d = Math.max(0, decimals || 0)
  return Number(v.toFixed(d))
}

/** Fisher-Yates 洗牌（不改动原数组） */
function shuffle(arr) {
  const out = arr.slice()
  for (let k = out.length - 1; k > 0; k--) {
    const j = Math.floor(random() * (k + 1))
    const t = out[k]; out[k] = out[j]; out[j] = t
  }
  return out
}

/** 从池中不放回抽取 n 项 */
function sampleUnique(pool, n) {
  if (!pool || !pool.length) return []
  return shuffle(pool).slice(0, Math.min(Number(n) || 1, pool.length))
}

/** 从数字区间抽 n 个不重复整数 */
function uniqueInts(min, max, n) {
  const total = Math.floor(max) - Math.ceil(min) + 1
  if (total <= 0) return []
  const picked = []
  const used = {}
  let guard = 0
  while (picked.length < Math.min(n, total) && guard < total * 20) {
    guard++
    const v = intIn(min, max)
    if (used[v] === undefined) { used[v] = true; picked.push(v) }
  }
  return picked
}

function coinFlip() {
  return random() < 0.5 ? '正面' : '反面'
}

/** 按权重抽取（转盘：先算结果，再播动画到对应角度） */
function weightedIndex(weights) {
  const sum = weights.reduce(function (s, w) { return s + Number(w) }, 0)
  if (!(sum > 0)) return -1
  let r = random() * sum
  for (let k = 0; k < weights.length; k++) {
    r -= Number(weights[k])
    if (r < 0) return k
  }
  return weights.length - 1
}

/** 分组抽签：把名单分成 ceil(n/groupSize) 组，组间随机 */
function groupDraw(list, groupSize) {
  const g = Math.max(1, Math.trunc(Number(groupSize)) || 1)
  const sh = shuffle(list || [])
  const groups = []
  for (let k = 0; k < sh.length; k += g) groups.push(sh.slice(k, k + g))
  return groups
}

/** 跨轮不重复抽取：remaining 为上一轮剩余的池，抽 count 个返回 {picked, remaining} */
function drawRound(remaining, count) {
  const pool = (remaining || []).slice()
  if (!pool.length) return { picked: [], remaining: [], exhausted: true }
  const n = Math.min(Math.trunc(Number(count)) || 1, pool.length)
  const sh = shuffle(pool)
  return { picked: sh.slice(0, n), remaining: sh.slice(n), exhausted: false }
}

/** 尝试用 wx.getRandomValues 播种（页面 onLoad 调用；node 环境自动跳过） */
function trySeedFromWx() {
  if (typeof wx === 'undefined' || !wx.getRandomValues) return false
  try {
    wx.getRandomValues({
      length: 8,
      success: function (res) {
        try {
          const buf = res.randomValues || res.bytes
          const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : (buf && buf.length !== undefined ? Array.prototype.slice.call(buf) : null)
          seedFromWx(u8)
        } catch (e) { /* 保持 Math.random 混合种子 */ }
      }
    })
    return true
  } catch (e) {
    return false
  }
}

module.exports = {
  seedFromWx: seedFromWx,
  trySeedFromWx: trySeedFromWx,
  random: random,
  intIn: intIn,
  floatIn: floatIn,
  shuffle: shuffle,
  sampleUnique: sampleUnique,
  uniqueInts: uniqueInts,
  coinFlip: coinFlip,
  weightedIndex: weightedIndex,
  groupDraw: groupDraw,
  drawRound: drawRound
}
