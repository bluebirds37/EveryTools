/**
 * JPEG / EXIF 解析（自研，无第三方依赖）
 * 用途：FR-IMG-10 图片信息展示、FR-IMG-01 判定「是否含 EXIF / GPS」。
 * 全部为纯函数，输入 Uint8Array；解析失败一律返回 null，不抛异常。
 */

const MARKER_NAMES = {
  0xc0: 'SOF0',
  0xc1: 'SOF1',
  0xc2: 'SOF2',
  0xc3: 'SOF3',
  0xc5: 'SOF5',
  0xc6: 'SOF6',
  0xc7: 'SOF7',
  0xc9: 'SOF9',
  0xca: 'SOF10',
  0xcb: 'SOF11',
  0xcc: 'DAC',
  0xd8: 'SOI',
  0xd9: 'EOI',
  0xda: 'SOS',
  0xdb: 'DQT',
  0xdc: 'DNL',
  0xdd: 'DHT',
  0xde: 'DRI',
  0xfe: 'COM',
  0xe0: 'APP0(JFIF)',
  0xe1: 'APP1(EXIF)',
  0xe2: 'APP2',
  0xe3: 'APP3',
  0xe4: 'APP4',
  0xe5: 'APP5',
  0xe6: 'APP6',
  0xe7: 'APP7',
  0xe8: 'APP8',
  0xe9: 'APP9',
  0xea: 'APP10',
  0xeb: 'APP11',
  0xec: 'APP12(DCF)',
  0xed: 'APP13',
  0xee: 'APP14',
  0xef: 'APP15'
}

const SOF_MARKERS = [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]

function isBytes(x) {
  return x && typeof x.length === 'number' && typeof x[0] === 'number'
}

function toBytes(input) {
  if (isBytes(input)) return input
  if (input && input.data instanceof Uint8Array) return input.data
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input)
  return null
}

/** 按 magic number 判定格式 */
function sniffFormat(input) {
  const b = toBytes(input)
  if (!b || b.length < 12) return 'unknown'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  const tag = String.fromCharCode(b[8], b[9], b[10], b[11])
  if (tag === 'WEBP') return 'webp'
  if (tag === 'TIFF' || tag === 'Exif') return 'tiff'
  if (tag === 'ftyp' || tag === 'jpx ') return 'heif'
  if (b[0] === 0x00 && (b[2] === 0x45 || b[3] === 0x45) && b[6] === 0x45 && b[7] === 0x58) return 'heif'
  return 'unknown'
}

function u16(b, o, le) {
  if (o + 1 >= b.length) return NaN
  return le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]
}

function u32(b, o, le) {
  if (o + 3 >= b.length) return NaN
  return le
    ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) + b[o + 3] * 16777216
    : b[o] * 16777216 + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]
}

/**
 * 遍历 JPEG 段（标记头 0xFFxx + 2 字节长度）。
 * @returns {Array<{marker:number,name:string,length:number,offset:number,payload:number}>}
 */
function walkSegments(input) {
  const b = toBytes(input)
  const out = []
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return out
  let p = 2
  let guard = 0
  out.push({ marker: 0xd8, name: 'SOI', length: 0, offset: 0, payload: 2 })
  while (p < b.length - 1 && guard++ < 4096) {
    if (b[p] !== 0xff) {
      p++
      continue
    }
    while (b[p] === 0xff) p++
    const marker = b[p]
    p += 1
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push({ marker, name: MARKER_NAMES[marker] || ('0x' + marker.toString(16)), length: 0, offset: p - 2, payload: p })
      if (marker === 0xda) break // 压缩数据开始，后续段不再遍历
      continue
    }
    if (p + 1 >= b.length) break
    const len = (b[p] << 8) | b[p + 1]
    if (len < 2 || p + len > b.length + 2) break
    out.push({
      marker,
      name: MARKER_NAMES[marker] || ('0x' + marker.toString(16)),
      length: len,
      offset: p,
      payload: p + 2
    })
    if (marker === 0xda) break
    p += len
  }
  return out
}

/** JPEG SOF 段读原始宽高 */
function readJpegSize(input) {
  const segs = walkSegments(input)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (SOF_MARKERS.indexOf(s.marker) < 0) continue
    const b = toBytes(input)
    const o = s.payload
    if (o + 7 >= b.length) continue
    return {
      height: (b[o + 1] << 8) | b[o + 2],
      width: (b[o + 3] << 8) | b[o + 4],
      components: b[o + 5],
      markers: s.name
    }
  }
  return null
}

/** DQT 段量化表摘要（FR-IMG-10 用于展示「压缩质量估计」） */
function readQuantTables(input) {
  const b = toBytes(input)
  const segs = walkSegments(input)
  const tables = []
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s.marker !== 0xdb || s.length < 3) continue
    let o = s.payload
    const end = s.offset + s.length
    while (o + 64 <= end && o + 64 <= b.length) {
      const pq = b[o] >> 4
      const id = b[o] & 0x0f
      const step = pq === 1 ? 2 : 1
      const vals = []
      for (let k = 0; k < 64; k++) {
        const v = step === 2 ? u16(b, o + 1 + k * 2, false) : b[o + 1 + k]
        vals.push(v)
      }
      tables.push({ id, precision: step === 2 ? 16 : 8, values: vals })
      o += 1 + 64 * step
    }
  }
  if (!tables.length) return null
  const flat = tables.reduce((a, t) => a.concat(t.values.slice(0, 25)), [])
  const avg = flat.reduce((a, v) => a + (v || 0), 0) / flat.length
  // 经验公式：量化表均值越小质量越高（仅供展示，界面标注「估算」）
  const quality = Math.round(avg < 50 ? 100 - avg * 2 : Math.sqrt(Math.max(0, (250 - avg) / 250)) * 100)
  return { tables: tables.length, avgQuant: Math.round(avg), qualityEstimate: Math.max(1, Math.min(100, quality)) }
}

/** 找到 APP1 中的 Exif TIFF 块 */
function findExifBlock(input) {
  const b = toBytes(input)
  const segs = walkSegments(input)
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i]
    if (s.marker !== 0xe1 || s.length < 14) continue
    const o = s.payload
    if (o + 14 > b.length) continue
    const head = String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3], b[o + 4], b[o + 5])
    if (head !== 'Exif\x00\x00') continue
    return b.subarray(o + 6, s.offset + s.length)
  }
  return null
}

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 }

function readValues(b, type, count, offset, le) {
  const size = TYPE_SIZE[type] || 1
  const total = size * count
  let o = offset
  if (total > 4) {
    o = u32(b, offset, le)
    if (!isFinite(o) || o < 0 || o + total > b.length) return null
  }
  const out = []
  for (let i = 0; i < count; i++) {
    const p = o + i * size
    if (p + size > b.length) break
    if (type === 3) out.push(u16(b, p, le))
    else if (type === 4) out.push(u32(b, p, le))
    else if (type === 9) out.push(u32(b, p, le) | 0)
    else if (type === 5 || type === 10) {
      const n = le ? [b[p], b[p + 1], b[p + 2], b[p + 3], b[p + 4], b[p + 5], b[p + 6], b[p + 7]]
        : [b[p + 7], b[p + 6], b[p + 5], b[p + 4], b[p + 3], b[p + 2], b[p + 1], b[p]]
      const num = le ? u32(b, p, le) : u32(b, p + 4, le)
      const den = le ? u32(b, p + 4, le) : u32(b, p, le)
      out.push({ num, den, raw: n })
    } else out.push(b[p])
  }
  return out
}

function ascii(b, values) {
  if (!values) return ''
  return values
    .map((v) => (typeof v === 'number' ? v : 0))
    .filter((c) => c > 0)
    .map((c) => String.fromCharCode(c))
    .join('')
    .trim()
}

function ratio(v) {
  if (!v) return null
  if (typeof v === 'number') return v
  if (v.num && v.den) return v.num / v.den
  return null
}

/** 解析一个 IFD，返回 {tagId: value} */
function readIfd(b, ifdOffset, le, depth) {
  const map = {}
  if (depth > 3) return { map, next: 0 }
  const n = u16(b, ifdOffset, le)
  if (!isFinite(n) || n <= 0 || n > 600) return { map, next: 0 }
  let p = ifdOffset + 2
  let sub = 0
  for (let i = 0; i < n; i++) {
    if (p + 12 > b.length) break
    const tag = u16(b, p, le)
    const type = u16(b, p + 2, le)
    const count = u32(b, p + 4, le)
    const valOff = p + 8
    if (tag === 0x8769 || tag === 0x8825 || tag === 0xa005) {
      sub = u32(b, valOff, le)
      p += 12
      continue
    }
    if (!count || count > 4096) {
      p += 12
      continue
    }
    const vals = readValues(b, type, count, valOff, le)
    if (vals === null) {
      p += 12
      continue
    }
    if (type === 2) map[tag] = ascii(b, vals)
    else if (type === 5 || type === 10) map[tag] = vals
    else map[tag] = vals.length === 1 ? vals[0] : vals
    p += 12
  }
  const next = p + 4 <= b.length ? u32(b, p, le) : 0
  if (sub && sub < b.length - 2) {
    const child = readIfd(b, sub, le, depth + 1)
    map['__sub_' + (tag_name(sub) || sub)] = child.map
  }
  return { map, next }
}

function tag_name(off) {
  return off
}

/**
 * 解析 EXIF。
 * @param {Uint8Array} tiff Exif 块（findExifBlock 的输出）
 * @returns {null|{orientation,make,model,dateTimeOriginal,...,gps}}
 */
function parseExif(tiff) {
  const b = toBytes(tiff)
  if (!b || b.length < 16) return null
  const mm = u16(b, 0, false)
  let le
  if (mm === 0x4949) le = true
  else if (mm === 0x4d4d) le = false
  else return null
  if (u16(b, 2, le) !== 42) return null
  const ifd0Off = u32(b, 4, le)
  if (!isFinite(ifd0Off) || ifd0Off + 2 > b.length) return null

  const r0 = readIfd(b, ifd0Off, le, 0)
  const ifd0 = r0.map
  let exif = null
  for (const k in ifd0) {
    if (String(k).indexOf('__sub_') === 0) {
      const src = ifd0[k]
      if (src && (src[0x9003] || src[0x829a] || src[0x8827] || src[0x920a])) {
        exif = src
      } else if (!exif) exif = src
    }
  }
  const out = {}
  const orientation = ifd0[0x0112]
  if (typeof orientation === 'number') out.orientation = orientation
  if (ifd0[0x010f]) out.make = String(ifd0[0x010f]).trim()
  if (ifd0[0x0110]) out.model = String(ifd0[0x0110]).trim()
  if (ifd0[0x011a]) out.xResolution = ratio(ifd0[0x011a][0])
  if (ifd0[0x0132]) out.dateTime = String(ifd0[0x0132]).trim()
  const software = ifd0[0x0131]
  if (software) out.software = String(software).trim()

  if (exif) {
    if (exif[0x9003]) out.dateTimeOriginal = String(exif[0x9003]).trim()
    if (exif[0x9004]) out.dateTimeDigitized = String(exif[0x9004]).trim()
    if (exif[0x8827]) out.iso = exif[0x8827]
    if (exif[0x829a]) out.exposureTime = ratio(exif[0x829a][0])
    if (exif[0x9201]) out.shutterValue = ratio(exif[0x9201][0])
    if (exif[0x9202]) out.aperture = ratio(exif[0x9202][0])
    if (exif[0x920a]) out.focalLength = ratio(exif[0x920a][0])
    if (exif[0xa433]) out.lensModel = String(exif[0xa433]).trim()
    if (exif[0xa434]) out.lensSerial = String(exif[0xa434]).trim()
    if (exif[0xa20e]) out.flash = exif[0xa20e]
    if (exif[0x012d]) out.encoding = String(exif[0x012d]).trim()
    if (exif[0x9204]) out.subjectDistance = ratio(exif[0x9204][0])
    if (exif[0xa002]) out.pixelXDimension = exif[0xa002]
    if (exif[0xa003]) out.pixelYDimension = exif[0xa003]
  }

  // GPS IFD（可能在子链中）
  const gps = findGps(b, ifd0Off, le)
  if (gps) out.gps = gps

  const hasAny =
    out.orientation || out.make || out.model || out.dateTimeOriginal || out.dateTime ||
    out.iso || out.exposureTime || out.focalLength || out.gps
  if (!hasAny) return null
  out.hasGps = !!out.gps
  out.hasExifSub = !!exif
  return out
}

function findGps(b, ifd0Off, le) {
  const n = u16(b, ifd0Off, le)
  if (!isFinite(n) || n <= 0) return null
  let ptr = 0
  for (let i = 0; i < n; i++) {
    const p = ifd0Off + 2 + i * 12
    if (p + 12 > b.length) break
    if (u16(b, p, le) === 0x8825) {
      ptr = u32(b, p + 8, le)
      break
    }
    if (i === n - 1) ptr = u32(b, p + 12, le)
  }
  if (!ptr || ptr + 2 > b.length) return null
  const r = readIfd(b, ptr, le, 1)
  const g = r.map
  if (!g || (!g[1] && !g[3] && !g[2] && !g[4])) return null
  const lat = dms(g[1], g[2])
  const lng = dms(g[3], g[4])
  const out = {}
  if (lat !== null) out.lat = lat
  if (lng !== null) out.lng = lng
  if (g[5] === 'S' || g[5] === 83) out.latRef = 'S'
  if (g[7] === 'W' || g[7] === 87) out.lngRef = 'W'
  if (typeof g[6] === 'number') out.altitude = g[6]
  if (g[1] && !lat) out.rawLat = g[1]
  return out.lat !== undefined || out.lng !== undefined ? out : null
}

function dms(refVal, parts) {
  if (!parts || !parts.length || parts.length < 3) return null
  const d = ratio(parts[0])
  const m = ratio(parts[1])
  const s = ratio(parts[2])
  if (d === null || m === null || s === null) return null
  let v = d + m / 60 + s / 3600
  if (refVal === 'S' || refVal === 83 || refVal === 'W' || refVal === 87) v = -v
  return Math.round(v * 1e6) / 1e6
}

/** 一站式：从 JPEG 文件头字节解析 */
function analyze(bytes) {
  const b = toBytes(bytes)
  const format = sniffFormat(b)
  const res = { format, exif: null, size: null, quant: null, segments: [], nativeThumbnail: false }
  if (format === 'jpeg') {
    res.segments = walkSegments(b).map((s) => ({ marker: s.name, length: s.length }))
    res.size = readJpegSize(b)
    res.quant = readQuantTables(b)
    const block = findExifBlock(b)
    res.hasExif = !!block
    res.exif = block ? parseExif(block) : null
    res.nativeThumbnail = !!(res.exif && (res.exif.model || res.exif.dateTimeOriginal))
  }
  return res
}

/** 读取文件头部若干字节（避免整文件读入内存） */
function readHead(filePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const limit = Math.min(maxBytes || 256 * 1024, 512 * 1024)
    wx.getFileSystemManager().readFile({
      filePath,
      position: 0,
      length: limit,
      success: (res) => resolve(new Uint8Array(res.data)),
      fail: (e) => reject({ code: 'UNSUPPORTED_FORMAT', message: '无法读取文件头', raw: e && e.errMsg })
    })
  })
}

/** EXIF 字段 → 中文展示行（GPS 不在此处，由页面单独控制展开） */
function formatFields(exif) {
  if (!exif) return []
  const rows = []
  const push = (key, value) => {
    if (value !== undefined && value !== null && value !== '') rows.push({ key, value: String(value) })
  }
  push('拍摄时间', exif.dateTimeOriginal || exif.dateTime)
  push('相机厂商', exif.make)
  push('相机型号', exif.model)
  push('镜头', exif.lensModel)
  if (exif.exposureTime) {
    push(
      '快门',
      exif.exposureTime >= 1
        ? exif.exposureTime.toFixed(1) + 's'
        : '1/' + Math.round(1 / exif.exposureTime) + 's'
    )
  }
  push('光圈', exif.aperture ? 'f/' + exif.aperture.toFixed(1) : '')
  push('ISO', exif.iso)
  push('焦距', exif.focalLength ? exif.focalLength.toFixed(0) + 'mm' : '')
  push('方向标记', exif.orientation ? 'Orientation=' + exif.orientation : '')
  push('软件', exif.software)
  return rows
}

/** Orientation 的中文含义 */
function orientationText(o) {
  const map = {
    1: '正常',
    2: '水平翻转',
    3: '旋转 180°',
    4: '垂直翻转',
    5: '右转 90° 后镜像',
    6: '顺时针 90°',
    7: '左转 90° 后镜像',
    8: '逆时针 90°'
  }
  return map[o] || '未知'
}

/** Orientation → 预览所需 rotate/flip 组合 */
function orientationTransform(o) {
  switch (Number(o)) {
    case 2: return { rotate: 0, flipH: true, flipV: false }
    case 3: return { rotate: 180, flipH: false, flipV: false }
    case 4: return { rotate: 0, flipH: false, flipV: true }
    case 5: return { rotate: 90, flipH: true, flipV: false }
    case 6: return { rotate: 90, flipH: false, flipV: false }
    case 7: return { rotate: 270, flipH: true, flipV: false }
    case 8: return { rotate: 270, flipH: false, flipV: false }
    default: return { rotate: 0, flipH: false, flipV: false }
  }
}

module.exports = {
  sniffFormat,
  walkSegments,
  readJpegSize,
  readQuantTables,
  findExifBlock,
  parseExif,
  analyze,
  readHead,
  formatFields,
  orientationText,
  orientationTransform,
  MARKER_NAMES
}
