/**
 * QR 解码器（自研，jsQR 思路）
 * 流程：灰度 -> 二值化（Otsu / 分块自适应 / 反色，≤3 组预处理）
 *      -> 三个 finder pattern（1:1:3:1:1 行扫描 + 纵向复核 + 聚类）
 *      -> 三元组定向（直角顶点=TL，叉积定 TR/BL）
 *      -> 版本候选 + 仿射采样网格 -> 几何校验（时序图形/固定深色模块）
 *      -> 格式信息（BCH 容错 3bit）-> 反掩码 -> 去交织 -> RS 纠错 -> 模式解析
 *
 * 支持范围（诚实说明）：版本 1-40 的编码结构均尝试；实际识别率受限于
 *   仿射（无透视）模型 —— 屏幕截图/相册图/正对小角度实拍效果好，
 *   大角度倾斜、强烈镜像反光、模糊、单点 finder 缺失的场景会失败并返回原因。
 */

const T = require('./qr-tables')
const mx = require('./qr-matrix')
const fd = require('./qr-decode-find')
const rd = require('./qr-decode-bits')

function candidateVersions(trip) {
  const est = trip.legLen / trip.moduleSize + 7
  const v0 = Math.round((est - 17) / 4)
  const out = []
  for (let d = 0; d <= 3; d++) {
    for (const s of d === 0 ? [0] : [-d, d]) {
      const v = v0 + s
      if (v >= 1 && v <= 40 && out.indexOf(v) < 0) out.push(v)
    }
  }
  return out
}

/** 单张二值图的解码尝试 */
function decodeBinary(bin, width, height, stats) {
  const finders = fd.detectFinders(bin, width, height)
  stats.finders = finders.length
  if (finders.length < 3) return null
  const trips = fd.triplets(finders, 16)
  if (!trips.length) return null
  let best = null
  for (const trip of trips) {
    for (const version of candidateVersions(trip)) {
      const dim = version * 4 + 17
      const g = fd.sampleGrid(bin, width, height, trip, dim)
      const sanity = fd.gridSanity(g)
      if (sanity < 0.86) continue
      if (best && best.sanity >= sanity) continue
      stats.tried = (stats.tried || 0) + 1
      const fmt = rd.readFormatBits(g)
      if (!fmt) continue
      const realVersion = rd.readVersion(g)
      if (!realVersion || realVersion !== version) continue
      const template = rd.functionTemplate(version)
      const cw = rd.extractCodewords(g, version, fmt.ecc, fmt.mask, template)
      if (!cw) {
        stats.rsFail = (stats.rsFail || 0) + 1
        continue
      }
      const parsed = rd.parseDataCodewords(cw.data, version)

      if (!parsed) continue
      best = {
        sanity,
        text: parsed.text,
        version,
        size: dim,
        ecc: fmt.ecc,
        mask: fmt.mask,
        mode: parsed.mode,
        corrected: cw.fixed,
        modules: g.modules,
        terminated: parsed.terminated
      }
    }
  }
  return best
}

/**
 * 主入口
 * @param {{width:number,height:number,gray:Uint8Array}} image 灰度图（0-255）
 * @param {object} [opts] {tryInverted=true, adaptive=true}
 * @returns {object|null} 解码结果
 */
function decode(image, opts) {
  opts = opts || {}
  const w = image.width
  const h = image.height
  const gray = image.gray
  const plans = fd.makePlans(gray, w, h, opts)

  const stats = {}
  const runs = [{ scale: 1, plans }]
  // 低分辨率/小图二次通道：放大 2 倍再试（伪 finder 更少、比值更准）
  if (opts.upscale !== false && Math.min(w, h) <= 700) {
    const up = fd.upscale2(gray, w, h)
    runs.push({ scale: 2, plans: fd.makePlans(up.gray, up.width, up.height, opts) })
  }
  for (const run of runs) {
    for (const plan of run.plans) {
      const r = decodeBinary(plan.bin, run.scale === 1 ? w : arguments[0].width * run.scale, run.scale === 1 ? h : arguments[0].height * run.scale, stats)
      if (r) {
        r.preprocess = plan.name
        r.scale = run.scale
        r.stats = stats
        return r
      }
    }
  }
  const e = new Error(stats.finders ? '未识别到有效的二维码结构' : '未找到二维码定位图形')
  e.code = 'QR_NOT_DECODED'
  e.stats = stats
  throw e
}

/** 安全版：不抛异常，返回 {ok, ...} */
function decodeSafe(image, opts) {
  try {
    const r = decode(image, opts)
    return Object.assign({ ok: true }, r)
  } catch (err) {
    return { ok: false, code: err.code || 'QR_NOT_DECODED', message: err.message, stats: err.stats || null }
  }
}

/** 从 RGBA 像素解码 */
function decodeFromRgba(pix, opts) {
  return decode({ width: pix.width, height: pix.height, gray: fd.grayFromRgba(pix.data) }, opts)
}

/** 调试辅助：把矩阵打印成字符串（自测用） */
function dumpMatrix(modules, size) {
  const lines = []
  for (let y = 0; y < size; y++) {
    let s = ''
    for (let x = 0; x < size; x++) s += modules[y * size + x] ? '##' : '  '
    lines.push(s)
  }
  return lines.join('\n')
}

module.exports = {
  decode,
  decodeSafe,
  decodeFromRgba,
  decodeBinary,
  candidateVersions,
  dumpMatrix,
  ECC_LEVELS: T.ECC_LEVELS,
  MASK_FN: mx.MASK_FN
}
