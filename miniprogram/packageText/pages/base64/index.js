const registry = require('../../../tools/registry')
const store = require('../../../utils/store')
const track = require('../../../utils/track')
const error = require('../../../utils/error')
const codec = require('../../utils/codec')
const common = require('../../utils/common')

const TOOL_ID = 'text-base64'

const TIPS = [
  'UTF-8 字节级编解码，中文往返无损；非法字符/长度错误会提示具体位置',
  'URL-Safe 变体使用 - 与 _ 替代 + 与 /，并省略结尾填充 =',
  '行折按 MIME 习惯每 76 字符断行',
  '「图片转 Base64」读取相册图片本体编码（含 dataURI 与膨胀率）；「解码结果为图片」可将 Base64 还原为图片预览'
]

const SAMPLES = [
  { name: '中文编码', input: '你好，Base64！', v: { dir: 'encode', variant: 'std', charset: 'utf8', lineWrap: false } },
  { name: '解码还原', input: '5L2g5aW977yaQmFzZTY077yB', v: { dir: 'decode', variant: 'std', charset: 'utf8', lineWrap: false } },
  { name: 'URL-Safe', input: 'a?b&c=中文', v: { dir: 'encode', variant: 'url', charset: 'utf8', lineWrap: false } },
  { name: '非法字符', input: '!!!!@@@####@@@', v: { dir: 'decode', variant: 'std', charset: 'utf8', lineWrap: false } }
]

function defaults() {
  return { dir: 'encode', variant: 'std', charset: 'utf8', lineWrap: false }
}

/** 每 width 字符断行（76，MIME 习惯） */
function wrapLines(s, width) {
  const w = width || 76
  const out = []
  for (let i = 0; i < s.length; i += w) out.push(s.slice(i, i + w))
  return out.join('\n')
}

/** latin1 解码：字节直接映射字符 */
function latin1Decode(b64, variant) {
  const bytes = codec.base64ToBytes(b64, variant)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return s
}

function buildSchema() {
  return [
    { key: 'dir', label: '方向', type: 'segment', def: 'encode', options: [{ value: 'encode', label: '编码' }, { value: 'decode', label: '解码' }] },
    { key: 'charset', label: '字符集', type: 'segment', def: 'utf8', options: [{ value: 'utf8', label: 'UTF-8' }, { value: 'latin1', label: 'Latin-1' }] },
    { key: 'variant', label: '变体', type: 'segment', def: 'std', options: [{ value: 'std', label: '标准 std' }, { value: 'url', label: 'URL-Safe' }] },
    { key: 'lineWrap', label: '每 76 字符折行', type: 'switch', def: false, showIf: { key: 'dir', in: ['encode'] } }
  ]
}

Page({
  data: {
    tool: null,
    values: defaults(),
    input: '',
    schema: buildSchema(),
    tips: TIPS,
    busy: false,
    result: null,
    error: null,
    samples: SAMPLES
  },

  onLoad(query) {
    const tool = registry.get(TOOL_ID)
    const values = Object.assign(defaults(), store.params(TOOL_ID) || {})
    this.setData({ tool: tool, values: values, input: values.__input || '' })
    track.track('tool_open', { toolId: TOOL_ID, from: query.from || 'menu' })
  },

  onParamChange(e) {
    const values = Object.assign({}, this.data.values)
    values[e.detail.key] = e.detail.value
    this.setData({ values: values })
    this.remember(values)
  },

  remember(values) {
    store.saveParams(TOOL_ID, Object.assign({}, values, { __input: this.data.input }))
  },

  onInput(e) { this.setData({ input: e.detail.value }) },
  onPaste() {
    wx.getClipboardData({
      success: (res) => {
        const v = String((res && res.data) || '')
        if (!v) return wx.showToast({ title: '剪贴板为空', icon: 'none' })
        this.setData({ input: v.slice(0, common.MAX_INPUT_LEN) })
      },
      fail: () => wx.showToast({ title: '无法读取剪贴板', icon: 'none' })
    })
  },
  onClearInput() { this.setData({ input: '', result: null, error: null }) },
  onSwap() {
    const v = Object.assign({}, this.data.values)
    const nextDir = v.dir === 'encode' ? 'decode' : 'encode'
    const outText = this.data.result && this.data.result.text
    this.setData({ values: Object.assign(v, { dir: nextDir }), input: nextDir === 'decode' && outText ? outText : this.data.input })
    this.remember(this.data.values)
  },

  onSample(e) {
    const s = SAMPLES[Number(e.currentTarget.dataset.index)]
    if (!s) return
    const values = Object.assign(defaults(), s.v)
    this.setData({ input: s.input, values: values, result: null, error: null })
    this.remember(values)
  },

  doCodec() {
    const v = this.data.values
    const input = this.data.input
    if (v.dir === 'encode') {
      if (v.charset === 'latin1') {
        const bytes = []
        for (let i = 0; i < input.length; i++) {
          const c = input.charCodeAt(i)
          if (c > 0xff) throw { code: 'PARAM_INVALID', message: '参数错误：Latin1 只支持 U+0000–U+00FF（第 ' + (i + 1) + ' 个字符超出）' }
          bytes.push(c)
        }
        return codec.bytesToBase64(new Uint8Array(bytes), v.variant)
      }
      return codec.encodeBase64(input, v.variant)
    }
    if (v.charset === 'latin1') return latin1Decode(input, v.variant)
    return codec.decodeBase64ToStr(input, v.variant)
  },

  onRun() {
    if (this.data.busy) return
    const v = this.data.values
    const emptyMsg = common.checkTextInput(this.data.input)
    if (emptyMsg) return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: emptyMsg }) }, result: null })
    if (this.data.input.length > common.MAX_INPUT_LEN) {
      return this.setData({ error: { code: 'PARAM_INVALID', message: error.message('PARAM_INVALID', { reason: '文本超过 1,000,000 字符，请拆分处理' }) }, result: null })
    }
    this.setData({ busy: true, error: null, result: null })
    track.track('tool_run_start', { toolId: TOOL_ID, dir: v.dir })
    const t0 = Date.now()
    try {
      let out = this.doCodec()
      const rawLen = out.length
      if (v.dir === 'encode' && v.lineWrap) out = wrapLines(out, 76)
      const rows = v.dir === 'encode'
        ? [{ key: '输入字符数', value: String(this.data.input.length) }, { key: '输出长度', value: String(rawLen) }, { key: '膨胀率', value: '+' + Math.round((rawLen / Math.max(1, this.byteLenOfInput())) * 100 - 100) + '%' }]
        : [{ key: '输入 Base64 长度', value: String(this.data.input.length) }, { key: '还原字符数', value: String(out.length) }]
      const result = {
        text: out,
        kv: rows,
        meta: (v.dir === 'encode' ? '编码' : '解码') + ' · ' + v.variant + ' · ' + v.charset + ' · ' + (Date.now() - t0) + 'ms · 端'
      }
      track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
      this.setData({ result: result, busy: false })
      this.remember(v)
    } catch (e) {
      const code = e.code || 'PARAM_INVALID'
      const message = e.message || error.message(code)
      track.track('tool_run_fail', { toolId: TOOL_ID, code: code })
      this.setData({ busy: false, error: { code: code, message: /参数错误|解码失败/.test(message) ? message : error.message(code, { reason: String(message).slice(0, 28) }) } })
    }
  },

  byteLenOfInput() {
    const v = this.data.values
    try {
      return v.charset === 'latin1' ? this.data.input.length : codec.utf8ToBytes(this.data.input).length
    } catch (e) {
      return this.data.input.length
    }
  },

  /** 图片 → Base64（dataURI + 膨胀率） */
  onChooseImage() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0]
        if (!f) return
        const fmt = String(f.path.split('.').pop() || 'png').toLowerCase()
        const mime = fmt === 'jpg' || fmt === 'jpeg' ? 'image/jpeg' : fmt === 'gif' ? 'image/gif' : fmt === 'webp' ? 'image/webp' : 'image/png'
        track.track('tool_run_start', { toolId: TOOL_ID, action: 'image2b64' })
        const t0 = Date.now()
        wx.getFileSystemManager().readFile({
          filePath: f.path,
          encoding: 'base64',
          success: (r) => {
            const b64 = String(r.data || '')
            const dataUri = 'data:' + mime + ';base64,' + b64
            const expand = f.size > 0 ? Math.round((b64.length / f.size) * 100 - 100) : 0
            this.setData({
              result: {
                text: dataUri,
                kv: [{ key: '原始体积', value: (f.size / 1024).toFixed(1) + ' KB' }, { key: 'Base64 长度', value: b64.length + ' 字符' }, { key: '膨胀率', value: '+' + expand + '%' }],
                meta: '图片 → Base64 · ' + (Date.now() - t0) + 'ms · 端'
              },
              error: null
            })
            track.track('tool_run_success', { toolId: TOOL_ID, costMs: Date.now() - t0, engine: 'client' })
          },
          fail: () => {
            track.track('tool_run_fail', { toolId: TOOL_ID, code: 'UNSUPPORTED_FORMAT' })
            this.setData({ error: { code: 'UNSUPPORTED_FORMAT', message: error.message('UNSUPPORTED_FORMAT', { reason: '图片读取失败' }) } })
          }
        })
      },
      fail: () => {}
    })
  },

  /** Base64（解码方向）→ 图片：写临时文件并预览 */
  onOpenAsImage() {
    const out = this.data.result && this.data.result.text
    if (!out) return this.setData({ error: { code: 'INPUT_EMPTY', message: error.message('INPUT_EMPTY', { reason: '先解码得到 Base64 结果' }) } })
    const fs = wx.getFileSystemManager()
    const path = (wx.env && wx.env.USER_DATA_PATH ? wx.env.USER_DATA_PATH : '/tmp') + '/tb_b64_' + Date.now() + '.img'
    try {
      fs.writeFile({
        filePath: path,
        data: out,
        encoding: 'base64',
        success: () => {
          wx.previewImage({ urls: [path], fail: () => wx.showToast({ title: '该数据不是合法图片', icon: 'none' }) })
          track.track('result_save', { toolId: TOOL_ID, action: 'b64-to-image' })
        },
        fail: () => wx.showToast({ title: '该数据无法还原为图片', icon: 'none' })
      })
    } catch (e) {
      wx.showToast({ title: '该数据无法还原为图片', icon: 'none' })
    }
  },

  onCopy(e) {
    common.copyText((e.detail && e.detail.text) || '', TOOL_ID, track)
  },

  onShare() {
    track.track('result_share', { toolId: TOOL_ID })
    wx.showToast({ title: '点右上角「…」转发给朋友', icon: 'none' })
  },

  onShareAppMessage() {
    return { title: 'Base64 · 中文往返无损编解码', path: '/packageText/pages/base64/index?toolId=' + TOOL_ID + '&from=share' }
  }
})

module.exports = { wrapLines: wrapLines, latin1Decode: latin1Decode }
