/**
 * QR 解码·定位层：二值化、finder pattern（1:1:3:1:1）检测、三点分组、仿射网格采样
 * 纯计算模块，可 node require 自测。
 *
 * 变换模型：由三个定位图形中心 + 模块尺寸推导「仿射」采样网格，
 * 覆盖平移/缩放/旋转与轻度透视（屏幕截图、正拍/小角度实拍）。
 * 强透视（>~35° 大角度倾斜）不在支持范围，由上层 UI 明示。
 */

const mx = require('./qr-matrix')

/* ---------------- 灰度 / 二值化 ---------------- */

function grayFromRgba(data) {
  const g = new Uint8Array(Math.floor(data.length / 4))
  for (let i = 0, j = 0; i + 3 < data.length; i += 4, j++) {
    g[j] = (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8
  }
  return g
}

function grayFromRgb(data, width, height) {
  const g = new Uint8Array(width * height)
  for (let i = 0; i < width * height; i++) {
    g[i] = (data[i * 3] * 77 + data[i * 3 + 1] * 150 + data[i * 3 + 2] * 29) >> 8
  }
  return g
}

function otsu(gray) {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const total = gray.length
  let sum = 0
  for (let i = 0; i < 256; i++) sum += i * hist[i]
  let sumB = 0
  let wB = 0
  let best = -1
  let thr = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sum - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) {
      best = between
      thr = t
    }
  }
  return thr
}

function binarizeGlobal(gray, invert) {
  const thr = otsu(gray)
  const out = new Uint8Array(gray.length)
  for (let i = 0; i < gray.length; i++) out[i] = ((gray[i] <= thr) !== !!invert ? 1 : 0)
  return out
}

/** 分块自适应（大光照梯度）：邻域均值作为局部阈值 */
function binarizeAdaptive(gray, width, height, opts) {
  opts = opts || {}
  const blockSize = opts.blockSize
  const invert = opts.invert
  const K = opts.K === undefined ? 0.3 : opts.K // Bradley-Roth: 阈值 = 邻域均值 * (1 - K)
  const bs = Math.max(8, blockSize || Math.max(8, Math.round(Math.min(width, height) / 16)))
  const bx = Math.ceil(width / bs)
  const by = Math.ceil(height / bs)
  const sum = new Float64Array(bx * by)
  const cnt = new Float64Array(bx * by)
  for (let y = 0; y < height; y++) {
    const cy = Math.min(by - 1, Math.floor(y / bs))
    for (let x = 0; x < width; x++) {
      const cx = Math.min(bx - 1, Math.floor(x / bs))
      sum[cy * bx + cx] += gray[y * width + x]
      cnt[cy * bx + cx]++
    }
  }
  const mean = new Float64Array(bx * by)
  for (let i = 0; i < mean.length; i++) mean[i] = cnt[i] ? sum[i] / cnt[i] : 128
  const out = new Uint8Array(gray.length)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const cy = Math.min(by - 1, Math.floor(y / bs))
      const cx = Math.min(bx - 1, Math.floor(x / bs))
      let s = 0
      let n = 0
      for (let dy = -1; dy <= 1; dy++) {
        const yy = cy + dy
        if (yy < 0 || yy >= by) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = cx + dx
          if (xx < 0 || xx >= bx) continue
          s += mean[yy * bx + xx]
          n++
        }
      }
      const t = (s / n) * (1 - K)
      out[y * width + x] = ((gray[y * width + x] <= t) !== !!invert ? 1 : 0)
    }
  }
  return out
}

/** 梯度图二值化：Sobel 幅值低于阈值处视为深色边界内部，按幅值阈值切分 */
function binarizeGradient(gray, width, height, invert) {
  const mag = new Uint8Array(width * height)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x
      const gx = Math.abs(
        -gray[i - width - 1] + gray[i - width + 1] - 2 * gray[i - 1] + 2 * gray[i + 1] - gray[i + width - 1] + gray[i + width + 1]
      )
      const gy = Math.abs(
        -gray[i - width - 1] - 2 * gray[i - width] - gray[i - width + 1] + gray[i + width - 1] + 2 * gray[i + width] + gray[i + width + 1]
      )
      mag[i] = Math.min(255, gx + gy)
    }
  }
  const thr = Math.max(8, otsu(mag))
  const out = new Uint8Array(width * height)
  for (let i = 0; i < out.length; i++) out[i] = ((mag[i] > thr) !== !!invert ? 1 : 0)
  return out
}

/**
 * 生成预处理方案（≤3 次）：灰度→全局阈值 / 分块自适应 / 反色
 * 若首次为浅色码（深色底），反色方案可救回。
 */
function makePlans(gray, width, height, opts) {
  opts = opts || {}
  const plans = []
  plans.push({ name: 'global', bin: binarizeGlobal(gray, false) })
  if (opts.adaptive !== false) {
    const short = Math.min(width, height)
    plans.push({
      name: 'adaptive',
      bin: binarizeAdaptive(gray, width, height, { blockSize: Math.max(12, Math.round(short / 12)), K: 0.3 })
    })
  }
  if (opts.tryInverted !== false) plans.push({ name: 'global-inverted', bin: binarizeGlobal(gray, true) })
  return plans
}

/* ---------------- run-length 扫描 ---------------- */

function runsOfRow(bin, width, y) {
  const runs = []
  let cur = bin[y * width]
  let len = 1
  let start = 0
  for (let x = 1; x < width; x++) {
    const v = bin[y * width + x]
    if (v === cur) len++
    else {
      runs.push({ dark: cur === 1, len, start })
      cur = v
      start = x
      len = 1
    }
  }
  runs.push({ dark: cur === 1, len, start })
  return runs
}

function closeTo(actual, expect, tol) {
  return Math.abs(actual - expect) <= Math.max(tol, expect * 0.6)
}

function isFinderRatio(lens) {
  const total = lens[0] + lens[1] + lens[2] + lens[3] + lens[4]
  if (total < 7) return 0
  const ms = total / 7
  if (ms < 0.7) return 0
  if (
    closeTo(lens[0], ms, 1.3) &&
    closeTo(lens[1], ms, 1.3) &&
    closeTo(lens[2], ms * 3, 1.8) &&
    closeTo(lens[3], ms, 1.3) &&
    closeTo(lens[4], ms, 1.3)
  ) {
    return ms
  }
  return 0
}

/** 纵向复核，返回 {y, ms} 或 null */
function verifyVertical(bin, width, height, x, y) {
  let up = y
  while (up >= 0 && bin[up * width + x] === 1) up--
  let down = y
  while (down < height && bin[down * width + x] === 1) down++
  const centerLen = down - up - 1
  let upLight = 0
  let p = up
  while (p >= 0 && bin[p * width + x] === 0) {
    upLight++
    p--
  }
  let downLight = 0
  p = down
  while (p < height && bin[p * width + x] === 0) {
    downLight++
    p++
  }
  const ms = (upLight + centerLen + downLight) / 5
  if (ms < 0.7) return null
  if (!closeTo(upLight, ms, 1.3) || !closeTo(downLight, ms, 1.3)) return null
  if (!closeTo(centerLen, ms * 3, 1.8)) return null
  return { y: (up + 1 + down - 1) / 2, ms }
}

/**
 * 全图扫描，返回聚类后的 finder 中心 [{x,y,size,count}]
 */
function detectFinders(bin, width, height) {
  const raw = []
  const stepY = Math.max(1, Math.floor(height / 420))
  for (let y = 0; y < height; y += stepY) {
    const runs = runsOfRow(bin, width, y)
    for (let i = 0; i + 4 < runs.length; i++) {
      const w5 = runs[i]
      if (!w5.dark) continue
      if (!isFinderRatio([runs[i].len, runs[i + 1].len, runs[i + 2].len, runs[i + 3].len, runs[i + 4].len])) continue
      const cx = runs[i].start + runs[i].len + runs[i + 1].len + runs[i + 2].len / 2
      const v = verifyVertical(bin, width, height, Math.round(cx), y)
      if (!v) continue
      raw.push({ x: cx, y: v.y, ms: v.ms })
    }
  }
  return cluster(raw)
}

function findersClose(a, b) {
  const r = Math.max(4, ((a.size || 0) + (b.size || 0)) / 2 * 2.2)
  return Math.abs(a.x - b.x) <= r && Math.abs(a.y - b.y) <= r
}

function cluster(points) {
  const out = []
  for (const p of points) {
    let hit = null
    for (const c of out) {
      if (findersClose(c, p)) {
        hit = c
        break
      }
    }
    if (hit) {
      const n = hit.count + 1
      hit.x = (hit.x * hit.count + p.x) / n
      hit.y = (hit.y * hit.count + p.y) / n
      hit.size = (hit.size * hit.count + p.ms) / n
      hit.count = n
    } else {
      out.push({ x: p.x, y: p.y, size: p.ms, count: 1 })
    }
  }
  return out.filter((c) => c.count >= 1)
}

/* ---------------- 三点分组 ---------------- */

function dist(a, b) {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))
}

/**
 * 三元组枚举 + 排序
 * 排序依据：大版本/密集码内部会产生大量伪 finder，
 * 真 finder 的 count（命中行数）明显更高，且 legLen/moduleSize 必须落在合法边长上
 * （dim = legLen/ms + 7，dim ≡ 1 (mod 4)，21..177）。
 */
function triplets(list, max) {
  const cap = max || 48
  const pool = list.slice().sort((a, b) => b.count - a.count).slice(0, 14)
  const maxCount = pool.length ? pool[0].count : 0
  const strong = pool.filter((c) => maxCount < 3 || c.count >= Math.max(2, maxCount * 0.25))
  const cand = strong.length >= 3 ? strong : pool
  const res = []
  for (let i = 0; i < cand.length; i++) {
    for (let j = i + 1; j < cand.length; j++) {
      for (let k = j + 1; k < cand.length; k++) {
        const t = orient([cand[i], cand[j], cand[k]])
        if (t) res.push(t)
        if (res.length > 4000) break
      }
    }
  }
  for (const t of res) {
    const est = t.legLen / t.moduleSize + 7
    const nearest = Math.round((est - 1) / 4) * 4 + 1
    t.dimScore = 1 - Math.min(1, Math.abs(est - nearest) / (est * 0.06))
    t.conf = (t.TL.count + t.TR.count + t.BL.count) / 3
    t.score = t.dimScore * 2 + Math.min(1, t.conf / 12)
  }
  return res.sort((a, b) => b.score - a.score).slice(0, cap)
}

function orient(f) {
  const cands = [
    { v: 0, a: 1, b: 2 },
    { v: 1, a: 0, b: 2 },
    { v: 2, a: 0, b: 1 }
  ]
  let best = null
  for (const c of cands) {
    const tl = f[c.v]
    const p = f[c.a]
    const q = f[c.b]
    const l1 = dist(tl, p)
    const l2 = dist(tl, q)
    const hyp = dist(p, q)
    if (l1 < 8 || l2 < 8) continue
    const ratio = Math.min(l1, l2) / Math.max(l1, l2)
    if (ratio < 0.72) continue
    const pythag = Math.abs(hyp * hyp - (l1 * l1 + l2 * l2)) / (l1 * l1 + l2 * l2)
    if (pythag > 0.45) continue
    const score = ratio - pythag
    if (!best || score > best.score) best = { score, tl, p, q, l1, l2 }
  }
  if (!best) return null
  const cross = (best.p.x - best.tl.x) * (best.q.y - best.tl.y) - (best.p.y - best.tl.y) * (best.q.x - best.tl.x)
  const TR = cross > 0 ? best.p : best.q
  const BL = cross > 0 ? best.q : best.p
  const msAvg = (best.tl.size + TR.size + BL.size) / 3
  return {
    TL: best.tl,
    TR,
    BL,
    legLen: (dist(best.tl, TR) + dist(best.tl, BL)) / 2,
    moduleSize: msAvg > 0 ? msAvg : Math.max(1, (dist(best.tl, TR) + dist(best.tl, BL)) / 2 / 24)
  }
}

/** 双线性放大（小图/低分辨率截图识别前预处理） */
function upscale2(gray, width, height) {
  const w = width * 2
  const h = height * 2
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const fy = y * 0.5 - 0.25
    const y0 = Math.max(0, Math.min(height - 1, Math.floor(fy)))
    const y1 = Math.min(height - 1, y0 + 1)
    const ty = fy - y0
    for (let x = 0; x < w; x++) {
      const fx = x * 0.5 - 0.25
      const x0 = Math.max(0, Math.min(width - 1, Math.floor(fx)))
      const x1 = Math.min(width - 1, x0 + 1)
      const tx = fx - x0
      const a = gray[y0 * width + x0] * (1 - tx) + gray[y0 * width + x1] * tx
      const b = gray[y1 * width + x0] * (1 - tx) + gray[y1 * width + x1] * tx
      out[y * w + x] = Math.max(0, Math.min(255, Math.round(a * (1 - ty) + b * ty)))
    }
  }
  return { gray: out, width: w, height: h }
}

/* ---------------- 采样 ---------------- */

function sampleGrid(bin, width, height, trip, dim) {
  const TL = trip.TL
  const span = dim - 7
  const e1x = (trip.TR.x - TL.x) / span
  const e1y = (trip.TR.y - TL.y) / span
  const e2x = (trip.BL.x - TL.x) / span
  const e2y = (trip.BL.y - TL.y) / span
  const ms = (Math.sqrt(e1x * e1x + e1y * e1y) + Math.sqrt(e2x * e2x + e2y * e2y)) / 2
  const g = mx.createGrid(dim)
  const rad = Math.max(0, Math.round(ms * 0.3))
  for (let r = 0; r < dim; r++) {
    for (let c = 0; c < dim; c++) {
      const px = TL.x + (c - 3) * e1x + (r - 3) * e2x
      const py = TL.y + (c - 3) * e1y + (r - 3) * e2y
      const v = vote(bin, width, height, px, py, rad)
      g.modules[r * dim + c] = v < 0 ? 0 : v
    }
  }
  return g
}

function vote(bin, width, height, cx, cy, rad) {
  const x0 = Math.round(cx)
  const y0 = Math.round(cy)
  if (x0 < 0 || y0 < 0 || x0 >= width || y0 >= height) return -1
  if (!rad) return bin[y0 * width + x0]
  let dark = 0
  let n = 0
  for (let dy = -rad; dy <= rad; dy++) {
    for (let dx = -rad; dx <= rad; dx++) {
      const x = x0 + dx
      const y = y0 + dy
      if (x < 0 || y < 0 || x >= width || y >= height) continue
      n++
      if (bin[y * width + x]) dark++
    }
  }
  return n && dark * 2 > n ? 1 : 0
}

/** 几何一致性评分 0..1：固定深色模块 + 时序图形交替 + 定位图形外围分隔符 */
function gridSanity(g) {
  const n = g.size
  if (n < 21 || (n - 17) % 4 !== 0) return 0
  if (!g.modules[(n - 8) * n + 8]) return 0 // 固定深色模块
  if (g.modules[7 * n] || g.modules[n - 8]) return 0 // 分隔符起点必须为浅色
  let ok = 0
  let tot = 0
  for (let i = 8; i < n - 8; i++) {
    tot++
    if (g.modules[6 * n + i] === (i % 2 === 0 ? 1 : 0)) ok++
    tot++
    if (g.modules[i * n + 6] === (i % 2 === 0 ? 1 : 0)) ok++
  }
  let sepBad = 0
  for (let i = 0; i < 8; i++) {
    if (g.modules[7 * n + i]) sepBad++ // 左上定位图形下方
    if (g.modules[i * n + 7]) sepBad++ // 左上定位图形右方
    if (g.modules[i * n + (n - 8)]) sepBad++ // 右上定位图形左方
    if (g.modules[7 * n + (n - 1 - i)]) sepBad++ // 右上定位图形下方
    if (g.modules[(n - 8) * n + i]) sepBad++ // 左下定位图形上方
    if (g.modules[(n - 1 - i) * n + 7]) sepBad++ // 左下定位图形右方
  }
  const sepScore = 1 - Math.min(1, sepBad / 24)
  const fs = finderScore(g)
  return tot ? sepScore * (ok / tot) * fs : 0
}

/** 三个定位图形 7x7 + 外围分隔符模板一致度（0..1，任一不匹配返回 0） */
function finderScore(g) {
  const n = g.size
  const centers = [[3, 3], [n - 4, 3], [3, n - 4]]
  let good = 0
  for (const [cx, cy] of centers) {
    let bad = 0
    let cells = 0
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= n || y >= n) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        const expect = d !== 2 ? 1 : 0
        cells++
        if (g.modules[y * n + x] !== expect) bad++
      }
    }
    if (cells >= 45 && bad === 0) good++
  }
  return good === 3 ? 1 : good === 2 ? 0.55 : 0
}

module.exports = {
  grayFromRgba,
  grayFromRgb,
  otsu,
  binarizeGlobal,
  binarizeAdaptive,
  detectFinders,
  cluster,
  findersClose,
  triplets,
  orient,
  makePlans,
  binarizeGradient,
  upscale2,
  finderScore,
  sampleGrid,
  vote,
  gridSanity
}
