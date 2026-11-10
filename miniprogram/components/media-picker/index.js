// components/media-picker —— 统一选图/选视频（C4 / tools-spec FR-G-01~02）
// 封装 wx.chooseMedia + 本地探测（getFileInfo / getImageInfo / getVideoInfo）+ 体积/格式白名单校验。
// 越界项：bind:error {code,message}（话术来自 utils/error.message），且不会出现在 bind:change 的 files 里。
const error = require('../../utils/error')

const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'avi', 'mkv', 'gif']

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    mediaType: { type: null, value: 'image' }, // 'image' | 'video' | ['image','video']
    multiple: { type: Boolean, value: false },
    maxCount: { type: Number, value: 20 },
    maxMB: { type: Number, value: 0 }, // 0 = 不限制
    accept: { type: Array, value: [] }, // ['jpg','png']；空 = 不限扩展名
    sourceType: { type: Array, value: ['album', 'camera'] },
    maxDuration: { type: Number, value: 600 }, // 秒（FR-G-02）
    hint: { type: String, value: '' }
  },
  data: {
    files: [], // 含展示字段 sizeLabel/durLabel
    totalText: '',
    picking: false,
    canAdd: true
  },
  methods: {
    types() {
      const t = this.properties.mediaType
      const arr = Array.isArray(t) ? t : [t]
      const out = arr
        .map(function (x) {
          return String(x || '').toLowerCase()
        })
        .filter(function (x) {
          return x === 'image' || x === 'video'
        })
      return out.length ? out : ['image']
    },
    acceptList() {
      return (this.properties.accept || [])
        .map(function (x) {
          return String(x || '').replace(/^\./, '').toLowerCase()
        })
        .filter(Boolean)
    },
    cap() {
      const max = Number(this.properties.maxCount) || 1
      return this.properties.multiple ? max : 1
    },
    remaining() {
      return Math.max(0, this.cap() - this.data.files.length)
    },
    onPick() {
      if (this.data.picking) return
      const left = this.remaining()
      if (left <= 0) {
        this.fail(error.CODES.PARAM_INVALID, { field: '数量', range: '≤ ' + this.cap() + ' 个' })
        return
      }
      this.setData({ picking: true })
      if (!wx.chooseMedia) {
        this.setData({ picking: false })
        this.fail(error.CODES.ENGINE_UNAVAILABLE, { reason: '基础库过低' })
        return
      }
      wx.chooseMedia({
        count: Math.min(left, 20),
        mediaType: this.types(),
        sourceType: this.properties.sourceType && this.properties.sourceType.length ? this.properties.sourceType : ['album', 'camera'],
        maxDuration: Number(this.properties.maxDuration) > 0 ? Number(this.properties.maxDuration) : 600,
        sizeType: ['original', 'compressed'],
        success: (res) => {
          this.setData({ picking: false })
          this.handle((res && res.tempFiles) || [])
        },
        fail: (e) => {
          this.setData({ picking: false })
          const n = error.normalize(e, error.CODES.PERMISSION_DENIED)
          if (n.code === error.INTERNAL_CODES.CANCELED) return // 用户主动取消不报错
          this.emitError(n.code, n.message)
        }
      })
    },
    handle(tempFiles) {
      if (!tempFiles.length) return
      Promise.all(
        tempFiles.map((f) => {
          return this.probe(f)
        })
      ).then((probed) => {
        const ok = probed.filter(function (x) {
          return !!x
        })
        if (!ok.length) return
        const fresh = ok.filter((x) => {
          return !this.data.files.some(function (y) {
            return y.path === x.path
          })
        })
        if (!fresh.length) return
        const files = this.properties.multiple ? this.data.files.concat(fresh).slice(0, this.cap()) : fresh.slice(0, 1)
        this.setData({ files: files, totalText: this.sumText(files), canAdd: files.length < this.cap() })
        this.triggerEvent('change', { files: files.map(toPublic) })
      })
    },
    // 探测 + 校验；不合规 → bind:error 且返回 null
    probe(f) {
      const ext = this.extOf(f.tempFilePath)
      const list = this.acceptList()
      const size = Number(f.size) || 0
      const maxMB = Number(this.properties.maxMB) || 0
      if (list.length && list.indexOf(ext) < 0) {
        this.fail(error.CODES.UNSUPPORTED_FORMAT, { format: ext })
        return Promise.resolve(null)
      }
      if (maxMB > 0 && size > maxMB * 1024 * 1024) {
        this.fail(error.CODES.FILE_TOO_LARGE, { max: maxMB * 1024 * 1024, size: size })
        return Promise.resolve(null)
      }
      const isVideo = f.fileType === 'video' || (this.types().indexOf('video') >= 0 && VIDEO_EXT.indexOf(ext) >= 0)
      if (isVideo) {
        return new Promise((resolve) => {
          wx.getVideoInfo({
            src: f.tempFilePath,
            success: (v) => {
              const duration = Number(v.duration) || Number(f.duration) || 0
              const cap = Number(this.properties.maxDuration) || 0
              if (cap > 0 && duration > cap) {
                this.fail(error.CODES.PARAM_INVALID, { field: '视频时长', range: '≤ ' + cap + ' 秒' })
                resolve(null)
                return
              }
              resolve({
                path: f.tempFilePath,
                size: size || Number(v.size) || 0,
                width: Number(v.width) || 0,
                height: Number(v.height) || 0,
                duration: duration,
                format: ext || 'mp4',
                kind: 'video',
                thumb: f.thumbTempFilePath || '',
                sizeLabel: this.sizeText(size),
                durLabel: this.durationText(duration)
              })
            },
            fail: () => {
              this.fail(error.CODES.UNSUPPORTED_FORMAT, { format: ext })
              resolve(null)
            }
          })
        })
      }
      return new Promise((resolve) => {
        wx.getImageInfo({
          src: f.tempFilePath,
          success: (img) => {
            resolve({
              path: f.tempFilePath,
              size: size,
              width: Number(img.width) || 0,
              height: Number(img.height) || 0,
              duration: 0,
              format: String(img.type || ext || 'jpg').toLowerCase(),
              kind: 'image',
              thumb: '',
              sizeLabel: this.sizeText(size),
              durLabel: ''
            })
          },
          fail: () => {
            this.fail(error.CODES.IMAGE_TOO_BIG)
            resolve(null)
          }
        })
      })
    },
    extOf(path) {
      const m = /\.([a-z0-9]+)(\?|$)/i.exec(String(path || ''))
      return m ? m[1].toLowerCase() : ''
    },
    sizeText(bytes) {
      const b = Number(bytes) || 0
      if (b <= 0) return ''
      if (b < 1024) return b + ' B'
      if (b < 1048576) return Math.round(b / 1024) + ' KB'
      return (b / 1048576).toFixed(b < 10485760 ? 1 : 0) + ' MB'
    },
    durationText(sec) {
      const s = Math.round(Number(sec) || 0)
      if (!s) return ''
      const m = Math.floor(s / 60)
      const r = s % 60
      return m + ':' + (r < 10 ? '0' + r : String(r))
    },
    sumText(files) {
      const total = files.reduce(function (n, x) {
        return n + (Number(x.size) || 0)
      }, 0)
      if (!files.length) return ''
      return files.length > 1 ? files.length + ' 项 · ' + this.sizeText(total) : this.sizeText(total)
    },
    fail(code, extra) {
      this.emitError(code, error.message(code, extra))
    },
    emitError(code, message) {
      this.triggerEvent('error', { code: code, message: message })
    },
    onRemove(e) {
      const i = Number(e.currentTarget.dataset.i)
      const files = this.data.files.slice()
      if (i < 0 || i >= files.length) return
      files.splice(i, 1)
      this.setData({ files: files, totalText: this.sumText(files), canAdd: files.length < this.cap() })
      this.triggerEvent('change', { files: files.map(toPublic) })
    },
    clear() {
      this.setData({ files: [], totalText: '', canAdd: true })
      this.triggerEvent('change', { files: [] })
    },
    preview(e) {
      const i = Number(e.currentTarget.dataset.i)
      const urls = this.data.files
        .filter(function (x) {
          return x.kind !== 'video'
        })
        .map(function (x) {
          return x.path
        })
      if (!urls.length || !wx.previewImage) return
      wx.previewImage({ current: (this.data.files[i] || {}).path, urls: urls })
    }
  }
})

function toPublic(x) {
  return { path: x.path, size: x.size, width: x.width, height: x.height, duration: x.duration, format: x.format, kind: x.kind, thumb: x.thumb }
}
