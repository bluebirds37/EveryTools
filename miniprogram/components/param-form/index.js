// components/param-form —— schema 驱动的参数区（C4）
// 支持 8 种控件：slider | number | segment | switch | color | chip | select | textarea
// 规则（tools-spec §0.2）：slider 松手才 emit；number 失焦校验并夹取；switch 关闭时隐藏依赖子项（showIf）；
// 任何变化都通过 bind:change 抛出 { key, value }，由页面更新 values 并 store.saveParams。
const error = require('../../utils/error')
const PRESET_COLORS = ['#FFFFFF', '#000000', '#3B5BFE', '#06A44A', '#F97316', '#E5484D', '#8B5CF6', '#0EA5E9']

Component({
  options: { styleIsolation: 'apply-shared' },
  properties: {
    schema: { type: Array, value: [] },
    values: { type: Object, value: {} },
    disabled: { type: Boolean, value: false }
  },
  data: {
    rows: [],
    // slider / switch 这些原生控件的属性不吃 CSS 变量，按主题取实际色值（值同 app.wxss 的 --brand）
    brand: '#3B5BFE'
  },
  lifetimes: {
    attached() {
      let dark = false
      try {
        const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
        dark = !!(info && info.theme === 'dark')
      } catch (e) {
        dark = false
      }
      this.setData({ brand: dark ? '#7C93FF' : '#3B5BFE' })
    }
  },
  observers: {
    'schema, values': function (schema, values) {
      this.build(schema, values)
    }
  },
  methods: {
    /* ---------- 构建视图模型 ---------- */
    build(schema, values) {
      const list = Array.isArray(schema) ? schema : []
      const vals = values && typeof values === 'object' ? values : {}
      const rows = []
      list.forEach((item) => {
        if (!item || !item.key) return
        const raw = vals[item.key] !== undefined && vals[item.key] !== null ? vals[item.key] : item.def
        const value = this.coerce(item, raw)
        const visible = this.pass(item, vals)
        if (!visible) return
        const options = (item.options || []).map((o) => {
          if (o && typeof o === 'object') return { value: this.coerce(item, o.value), label: String(o.label != null ? o.label : o.value) }
          return { value: this.coerce(item, o), label: String(o) }
        })
        const idx = options.findIndex((o) => String(o.value) === String(value))
        rows.push({
          key: item.key,
          label: item.label || item.key,
          type: item.type || 'number',
          hint: item.hint || '',
          unit: item.unit || '',
          min: Number(item.min) || 0,
          max: item.max === undefined || item.max === null ? 100 : Number(item.max),
          step: Number(item.step) > 0 ? Number(item.step) : 1,
          precision: item.precision === undefined || item.precision === null ? -1 : Number(item.precision),
          value: value,
          display: this.display(item, value),
          checked: value === true || value === 'true',
          options: options,
          labels: options.map((o) => o.label),
          selIndex: idx < 0 ? 0 : idx,
          selected: idx >= 0 ? options[idx] : null,
          swatches: PRESET_COLORS.map((c) => ({ hex: c, on: String(value).toLowerCase() === c.toLowerCase() })),
          rows: Number(item.rows) || 4,
          placeholder: item.placeholder || ''
        })
      })
      // 死循环保护：只在渲染数据真的变了才 setData
      const next = JSON.stringify(rows)
      if (next !== this._sig) {
        this._sig = next
        this.setData({ rows: rows })
      }
    },
    pass(item, vals) {
      const rule = item.showIf
      if (!rule || !rule.key) return true
      const cur = vals[rule.key]
      const list = Array.isArray(rule.in) ? rule.in : rule.in === undefined ? [] : [rule.in]
      if (!list.length) return cur !== false && cur !== undefined && cur !== '' && cur !== 0
      return list.some((x) => String(x) === String(cur))
    },
    coerce(item, raw) {
      const type = item.type || 'number'
      if (type === 'switch') return raw === true || raw === 'true' || raw === 1
      if (type === 'slider' || type === 'number') return this.num(item, raw)
      if (type === 'color') {
        const s = String(raw == null ? item.def || '#FFFFFF' : raw).trim()
        return /^#[0-9a-fA-F]{3,8}$/.test(s) ? s.toUpperCase() : String(item.def || '#FFFFFF')
      }
      if (raw === undefined || raw === null) return item.def === undefined ? '' : item.def
      return raw
    },
    num(item, raw) {
      const min = Number(item.min) || 0
      const max = item.max === undefined || item.max === null ? 100 : Number(item.max)
      let n = Number(raw)
      if (!isFinite(n)) n = Number(item.def)
      if (!isFinite(n)) n = min
      n = Math.min(max, Math.max(min, n))
      const step = Number(item.step) > 0 ? Number(item.step) : 0
      if (step > 0) {
        const snapped = Math.round((n - min) / step) * step + min
        n = Math.min(max, Math.max(min, snapped))
      }
      const p = item.precision === undefined || item.precision === null ? -1 : Number(item.precision)
      if (p >= 0) {
        const f = Math.pow(10, p)
        n = Math.round(n * f) / f
      } else if (step > 0 && String(step).indexOf('.') >= 0) {
        n = +(Math.round(n * 1000) / 1000).toFixed(3)
      }
      return n
    },
    display(item, value) {
      if ((item.type || 'number') !== 'slider' && (item.type || 'number') !== 'number') return ''
      const unit = item.unit || ''
      return value === 0 && !unit ? '0' : value + unit
    },

    /* ---------- 交互 ---------- */
    emit(key, value, index) {
      if (index != null && this.data.rows[index] && this.data.rows[index].type === 'slider') {
        this.setData({ ['rows[' + index + '].value']: value, ['rows[' + index + '].display']: this.displayOf(index, value) })
      }
      this.triggerEvent('change', { key: key, value: value })
    },
    displayOf(index, value) {
      const row = this.data.rows[index] || {}
      return (row.unit ? value + row.unit : String(value))
    },
    indexOf(e) {
      return Number(e.currentTarget.dataset.i)
    },
    onSliderChange(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      this.emit(row.key, Number(e.detail.value), i)
    },
    onSliderLive(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      this.setData({ ['rows[' + i + '].value']: Number(e.detail.value), ['rows[' + i + '].display']: this.displayOf(i, Number(e.detail.value)) })
    },
    onNumberInput(e) {
      const i = this.indexOf(e)
      this.setData({ ['rows[' + i + '].value']: e.detail.value })
    },
    onNumberBlur(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      const item = { type: 'number', min: row.min, max: row.max, step: row.step, precision: row.precision < 0 ? undefined : row.precision, def: row.value }
      const v = this.num(item, e.detail.value)
      this.triggerEvent('change', { key: row.key, value: v })
    },
    onSwitch(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      this.setData({ ['rows[' + i + '].checked']: !!e.detail.value })
      this.triggerEvent('change', { key: row.key, value: !!e.detail.value })
    },
    onPickOption(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      const j = Number(e.currentTarget.dataset.j)
      const opt = row.options[j]
      if (!opt) return
      if (row.type === 'chip') {
        // chip 允许取消选中回到默认值（tools-spec §0.2 preset-chip）
        const back = String(row.value) === String(opt.value)
        this.triggerEvent('change', { key: row.key, value: back ? this.defOf(row) : opt.value })
        return
      }
      this.triggerEvent('change', { key: row.key, value: opt.value })
    },
    onSelectChange(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      const opt = row.options[Number(e.detail.value)]
      if (opt) this.triggerEvent('change', { key: row.key, value: opt.value })
    },
    onColorTap(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      const hex = e.currentTarget.dataset.hex
      this.setData({ ['rows[' + i + '].value']: hex, ['rows[' + i + '].swatches']: row.swatches.map((s) => ({ hex: s.hex, on: s.hex === hex })) })
      this.triggerEvent('change', { key: row.key, value: hex })
    },
    onColorInput(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      const raw = String(e.detail.value || '').trim()
      const hex = /^#[0-9a-fA-F]{6}$/.test(raw) ? raw.toUpperCase() : row.value
      this.triggerEvent('change', { key: row.key, value: hex })
    },
    onTextarea(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      this.triggerEvent('change', { key: row.key, value: e.detail.value })
    },
    onPaste(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row || !wx.getClipboardData) return
      wx.getClipboardData({
        success: (res) => {
          const v = String((res && res.data) || '')
          this.setData({ ['rows[' + i + '].value']: v })
          this.triggerEvent('change', { key: row.key, value: v })
        },
        fail: () => {
          this.triggerEvent('error', { code: 'PERMISSION_DENIED', message: error.message('PERMISSION_DENIED', { scope: 'clipboard' }) })
        }
      })
    },
    onClear(e) {
      const i = this.indexOf(e)
      const row = this.data.rows[i]
      if (!row) return
      const v = this.defOf(row)
      this.setData({ ['rows[' + i + '].value']: '' })
      this.triggerEvent('change', { key: row.key, value: row.type === 'textarea' ? '' : v })
    },
    defOf(row) {
      const list = this.properties.schema || []
      const item = list.filter(function (x) {
        return x && x.key === row.key
      })[0]
      return item ? item.def : ''
    }
  }
})
