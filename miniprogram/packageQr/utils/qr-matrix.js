/**
 * QR 功能图形 / 掩码 / 惩罚评分 / 码字排布
 * 纯计算模块，可 node require 自测。
 */

const T = require('./qr-tables')

/* ---------------- 网格 ---------------- */

function createGrid(size) {
  return {
    size,
    modules: new Uint8Array(size * size), // 1 = 深色
    isFunction: new Uint8Array(size * size)
  }
}

function isDark(g, x, y) {
  if (x < 0 || y < 0 || x >= g.size || y >= g.size) return false
  return g.modules[y * g.size + x] === 1
}

function setFn(g, x, y, dark) {
  if (x < 0 || y < 0 || x >= g.size || y >= g.size) return
  g.modules[y * g.size + x] = dark ? 1 : 0
  g.isFunction[y * g.size + x] = 1
}

function setBit(g, x, y, dark) {
  g.modules[y * g.size + x] = dark ? 1 : 0
}

function bitAt(value, i) {
  return ((value >>> i) & 1) === 1
}

/* ---------------- 功能图形 ---------------- */

function drawFinder(g, cx, cy) {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const dist = Math.max(Math.abs(dx), Math.abs(dy))
      setFn(g, cx + dx, cy + dy, dist !== 2 && dist !== 4)
    }
  }
}

function drawAlignment(g, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      setFn(g, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }
}

function drawTiming(g) {
  for (let i = 0; i < g.size; i++) {
    setFn(g, 6, i, i % 2 === 0)
    setFn(g, i, 6, i % 2 === 0)
  }
}

/** 格式信息：BCH(15,5) 生成多项式 0x537，结果异或 0x5412 */
function formatBits(ecc, mask) {
  const data = (T.ECC_FORMAT_BITS[ecc] << 3) | mask
  let rem = data
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  return ((data << 10) | (rem & 0x3ff)) ^ 0x5412
}

function drawFormat(g, ecc, mask) {
  const bits = formatBits(ecc, mask)
  for (let i = 0; i <= 5; i++) setFn(g, 8, i, bitAt(bits, i))
  setFn(g, 8, 7, bitAt(bits, 6))
  setFn(g, 8, 8, bitAt(bits, 7))
  setFn(g, 7, 8, bitAt(bits, 8))
  for (let i = 9; i < 15; i++) setFn(g, 14 - i, 8, bitAt(bits, i))
  for (let i = 0; i < 8; i++) setFn(g, g.size - 1 - i, 8, bitAt(bits, i))
  for (let i = 8; i < 15; i++) setFn(g, 8, g.size - 15 + i, bitAt(bits, i))
  setFn(g, 8, g.size - 8, true) // 固定深色模块
}

/** 版本信息：BCH(18,6)，生成多项式 0x1F25 */
function versionBits(version) {
  let rem = version
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
  return (version << 12) | rem
}

function drawVersion(g, version) {
  const bits = versionBits(version)
  for (let i = 0; i < 18; i++) {
    const dark = bitAt(bits, i)
    const a = g.size - 11 + (i % 3)
    const b = Math.floor(i / 3)
    setFn(g, a, b, dark)
    setFn(g, b, a, dark)
  }
}

function drawFunctionPatterns(g, version, ecc, mask) {
  drawTiming(g)
  drawFinder(g, 3, 3)
  drawFinder(g, g.size - 4, 3)
  drawFinder(g, 3, g.size - 4)
  const pos = T.alignmentPositions(version)
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === pos.length - 1) ||
        (i === pos.length - 1 && j === 0)
      if (!corner) drawAlignment(g, pos[j], pos[i])
    }
  }
  drawFormat(g, ecc, mask)
  if (version >= 7) drawVersion(g, version)
}

/* ---------------- 码字排布（Z 字序） ---------------- */

function drawCodewords(g, codewords) {
  let i = 0
  for (let right = g.size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 跳过纵向时序图案列
    for (let vert = 0; vert < g.size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? g.size - 1 - vert : vert
        if (!g.isFunction[y * g.size + x] && i < codewords.length * 8) {
          setBit(g, x, y, bitAt(codewords[i >>> 3], 7 - (i & 7)))
          i++
        }
      }
    }
  }
}

/* ---------------- 掩码 ---------------- */

const MASK_FN = [
  (y, x) => (y + x) % 2 === 0,
  (y, x) => y % 2 === 0,
  (y, x) => x % 3 === 0,
  (y, x) => (y + x) % 3 === 0,
  (y, x) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (y, x) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (y, x) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (y, x) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0
]

function applyMask(g, mask) {
  const fn = MASK_FN[mask]
  if (!fn) throw new Error('[qr] 非法掩码: ' + mask)
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (g.isFunction[y * g.size + x]) continue
      if (fn(y, x)) g.modules[y * g.size + x] ^= 1
    }
  }
}

/* ---------------- 惩罚评分 ---------------- */

const FINDER_LIKE = [1, 0, 1, 1, 1, 0, 1]

function scoreLine(arr) {
  let score = 0
  let run = 1
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] === arr[i - 1]) {
      run++
    } else {
      if (run >= 5) score += 3 + (run - 5)
      run = 1
    }
  }
  if (run >= 5) score += 3 + (run - 5)
  return score
}

function check11(win) {
  let s = 0
  let a = true
  let b = true
  for (let i = 0; i < 7; i++) {
    if (win[i] !== FINDER_LIKE[i]) a = false
    if (win[i + 4] !== FINDER_LIKE[i]) b = false
  }
  for (let i = 7; i < 11; i++) if (win[i] !== 0) a = false
  for (let i = 0; i < 4; i++) if (win[i] !== 0) b = false
  if (a) s += 40
  if (b) s += 40
  return s
}

function penalty(g) {
  const n = g.size
  let p = 0
  const line = new Uint8Array(n)
  const win = new Uint8Array(11)

  // 规则 1：同色连续 >=5
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) line[x] = g.modules[y * n + x]
    p += scoreLine(line)
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) line[y] = g.modules[y * n + x]
    p += scoreLine(line)
  }
  // 规则 2：2x2 同色块
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = g.modules[y * n + x]
      if (v === g.modules[y * n + x + 1] && v === g.modules[(y + 1) * n + x] && v === g.modules[(y + 1) * n + x + 1]) p += 3
    }
  }
  // 规则 3：1:1:3:1:1 + 4 空白
  if (n >= 11) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x + 11 <= n; x++) {
        for (let k = 0; k < 11; k++) win[k] = g.modules[y * n + x + k]
        p += check11(win)
      }
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y + 11 <= n; y++) {
        for (let k = 0; k < 11; k++) win[k] = g.modules[(y + k) * n + x]
        p += check11(win)
      }
    }
  }
  // 规则 4：深色比例偏离 50%
  let dark = 0
  for (let i = 0; i < g.modules.length; i++) dark += g.modules[i]
  const total = n * n
  p += Math.floor(Math.abs(dark * 100 / total - 50) / 5) * 10
  return p
}

/** 评估某个掩码下的完整图形（自动掩码选择用） */
function renderWithMask(version, ecc, mask, codewords) {
  const size = version * 4 + 17
  const g = createGrid(size)
  drawFunctionPatterns(g, version, ecc, mask)
  drawCodewords(g, codewords)
  applyMask(g, mask)
  drawFormat(g, ecc, mask)
  return g
}

module.exports = {
  createGrid,
  isDark,
  setFn,
  drawFinder,
  drawAlignment,
  drawFormat,
  drawVersion,
  drawFunctionPatterns,
  drawCodewords,
  applyMask,
  MASK_FN,
  penalty,
  formatBits,
  versionBits,
  renderWithMask
}
