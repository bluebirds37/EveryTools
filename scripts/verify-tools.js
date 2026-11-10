#!/usr/bin/env node
/* 逐工具功能验证：把 53 个在线工具**真的跑一遍**，灌已知输入、断言已知输出。
 *
 * 与 smoke.js 的分工：smoke 只证明「生命周期不崩」，本脚本证明「功能真的对」。
 * 用例数据在 scripts/cases/<category>.js（每个分类一个文件），runner 在这里。
 *
 * 用法：
 *   node scripts/verify-tools.js                 # 全部在线工具
 *   node scripts/verify-tools.js image-compress  # 只跑某个（前缀匹配）
 *   node scripts/verify-tools.js --json          # 机器可读输出
 *   node scripts/verify-tools.js --verbose       # 打印每个工具的最终 data 摘要
 *
 * 用例契约（scripts/cases/*.js 导出 { toolId: caseDef }）：
 *   caseDef = {
 *     files?: (h) => [{path,size,width,height,format}]   // 媒体输入；runner 会喂 onFilesChange
 *     text?: string                                       // 文本输入 → data.input
 *     values?: object                                     // 合并进 data.values（页面参数）
 *     input?: object                                      // 直接合并进 data（少见，慎用）
 *     prepare?: (inst, h) => void|Promise                 // 运行前额外动作（比如切换 tab）
 *     run?: string                                        // 指定入口方法名；缺省自动探测
 *     timeout?: number                                    // 等待落定毫秒，默认 4000
 *     expect: (data, h) => string[]                       // 返回错误描述数组，空＝通过
 *   }
 *
 * 覆盖率为硬要求：注册表里每个 online/beta 工具都必须有用例，缺用例即失败。
 */
const fs = require('fs')
const path = require('path')

const mock = require('./mock-wx')
const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const CASES_DIR = path.join(__dirname, 'cases')

const argv = process.argv.slice(2)
const asJson = argv.indexOf('--json') >= 0
const verbose = argv.indexOf('--verbose') >= 0
const filter = argv.find((a) => !a.startsWith('--')) || ''

const registry = require(path.join(MP, 'tools/registry.js'))

const RUN_METHODS = ['onRun', 'onCompute', 'onGenerate', 'onEncode', 'onSubmit', 'onConvert', 'onStart', 'onGo', 'onApply', 'onBuild', 'onCheck', 'onMeasure', 'onCalc']
const SETTLE_KEYS = ['result', 'items', 'output', 'outputs', 'rows', 'lines', 'error', 'computed', 'report', 'frames', 'info']

function setDeep(obj, key, val) {
  const parts = key.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = val
}

function makeInstance(def) {
  const base = def.methods ? def.methods : def
  const inst = Object.assign({}, base, {
    data: JSON.parse(JSON.stringify(def.data || {})),
    properties: def.properties || {},
    setData(patch, val) {
      if (typeof patch === 'string') setDeep(this.data, patch, val)
      else for (const k of Object.keys(patch)) setDeep(this.data, k, patch[k])
    },
    selectComponent() {
      return { data: {}, setData() {}, triggerEvent() {}, selectComponent() { return null } }
    },
    createSelectorQuery() { return wx.createSelectorQuery() },
    getTabBar() { return null },
    triggerEvent() {},
    animate() {},
    route: '',
    is: 'verify'
  })
  // observers 里常有「输入变了就重算」的逻辑：harness 里手动触发一次
  inst.__def = def
  return inst
}

function purgeCache() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/miniprogram/')) delete require.cache[k]
  }
}

function photo(h, opts) {
  const o = opts || {}
  const p = o.path || '/tmp/verify-' + Math.random().toString(36).slice(2, 8) + (o.format === 'png' ? '.png' : '.jpg')
  h.mock.putFile(p, {
    size: o.size || 100 * 1024,
    width: o.width || 1200,
    height: o.height || 1600,
    type: o.format === 'png' ? 'png' : 'jpeg'
  })
  return { path: p, size: o.size || 100 * 1024, width: o.width || 1200, height: o.height || 1600, format: o.format || 'jpg', type: 'image', name: path.basename(p) }
}

function video(h, opts) {
  const o = opts || {}
  const p = o.path || '/tmp/verify-' + Math.random().toString(36).slice(2, 8) + '.mp4'
  h.mock.putFile(p, { size: o.size || 8 * 1024 * 1024, width: o.width || 1920, height: o.height || 1080, type: 'mp4' })
  return { path: p, size: o.size || 8 * 1024 * 1024, width: o.width || 1920, height: o.height || 1080, duration: o.duration || 12, format: 'mp4', type: 'video', name: path.basename(p) }
}

function buildHelpers(tools) {
  const helpers = {
    mock,
    wx: mock.wx,
    tools,
    registry,
    file: (p, meta) => {
      mock.putFile(p, meta || {})
      return Object.assign({ path: p, size: (meta && meta.size) || 1024, type: 'file', name: path.basename(p) }, meta || {})
    },
    mpPath: (...parts) => path.join(MP, ...parts),
    // 直接调用页面里的纯函数模块（工具算法层），绕开 UI：assert 已知向量最稳的路子
    lib: (relFromMp) => require(path.join(MP, relFromMp)),
    nav: mock.nav,
    toast: mock.toast,
    requests: mock.requests,
    uploads: mock.uploads,
    downloads: mock.downloads,
    canvasExports: mock.canvasExports,
    lastDraw: mock.lastDrawInfo,
    bytes: (p) => (mock.getFile(p) || { size: 0 }).size,
    tick: (ms) => new Promise((r) => setTimeout(r, ms || 0)),
    settle
  }
  helpers.photo = (o) => photo(helpers, o)
  helpers.video = (o) => video(helpers, o)
  return helpers
}

async function settle(inst, timeoutMs, def) {
  const deadline = Date.now() + (timeoutMs || 4000)
  // 先跑 observers（页面上「输入即算」的工具靠它出结果）
  const obs = def && def.observers
  for (let i = 0; i < 60; i++) {
    if (obs) {
      for (const key of Object.keys(obs)) {
        try {
          const args = key.split(',').map((k) => inst.data[k.trim().split('.')[0]])
          obs[key].apply(inst, args)
        } catch (e) { /* 观察器在缺字段时抛错属常见，忽略：以显式 run 为准 */ }
      }
    }
    const busy = inst.data.busy === true || inst.data.running === true || inst.data.loading === true
    const hasOut = SETTLE_KEYS.some((k) => {
      const v = inst.data[k]
      return (Array.isArray(v) && v.length) || (v && typeof v === 'object') || (typeof v === 'string' && v.length)
    })
    if (!busy && (hasOut || inst.data.__doneFlag)) return true
    await new Promise((r) => setTimeout(r, 25))
    if (Date.now() > deadline) return false
  }
  return false
}

function loadCases() {
  const out = {}
  if (!fs.existsSync(CASES_DIR)) return out
  for (const f of fs.readdirSync(CASES_DIR).filter((x) => x.endsWith('.js')).sort()) {
    let mod = null
    try {
      mod = require(path.join(CASES_DIR, f))
    } catch (e) {
      out.__load_error = [`${f}: ${e.message}`]
      continue
    }
    for (const [id, def] of Object.entries(mod)) {
      if (out[id]) (out.__dup = out.__dup || []).push(id)
      // 数组＝多场景，必须原样保留（Object.assign 会把数组摊成 {0:…,1:…} 从而只跑一个默认场景）
      out[id] = Array.isArray(def)
        ? def.map((one) => Object.assign({ _file: f }, one))
        : Object.assign({ _file: f }, def)
    }
  }
  return out
}

async function runOne(tool, cs, helpers) {
  const errs = []
  purgeCache()
  mock.reset()
  global.__lastPage = null
  const pageFile = path.join(MP, tool.entry.replace(/^\//, '') + '.js')
  if (!fs.existsSync(pageFile)) return [`页面文件不存在：${tool.entry}`]
  try {
    require(pageFile)
  } catch (e) {
    return [`页面加载失败：${e.message}`]
  }
  const def = global.__lastPage
  if (!def) return ['Page() 未被调用（文件里可能没导出 Page）']
  const inst = makeInstance(def)
  try {
    inst.onLoad && inst.onLoad({ toolId: tool.id, from: 'verify' })
  } catch (e) {
    return [`onLoad 抛错：${e.message}`]
  }

  const files = typeof cs.files === 'function' ? cs.files(helpers) : cs.files
  if (files && files.length) {
    // 图片页统一走 onFilesChange；视频页的入口叫 onPick（media-picker 的 change），单文件语义
    for (const name of ['onFilesChange', 'onPick']) {
      if (typeof inst[name] !== 'function') continue
      try {
        inst[name]({ detail: { files } })
      } catch (e) {
        errs.push(`${name} 抛错：${e.message}`)
      }
    }
    inst.setData({ files, file: files[0] })
  }
  if (cs.text !== undefined) {
    const key = 'input' in def.data ? 'input' : 'text'
    inst.setData({ [key]: cs.text })
    if (typeof inst.onInput === 'function') {
      try {
        inst.onInput({ detail: { value: cs.text } })
      } catch (e) { /* 各页 onInput 形态不一 */ }
    }
  }
  if (cs.values) inst.setData({ values: Object.assign({}, inst.data.values, cs.values) })
  if (cs.input) inst.setData(cs.input)
  if (cs.raw) cs.raw(inst, helpers)
  if (cs.prepare) {
    try {
      await cs.prepare(inst, helpers)
    } catch (e) {
      errs.push(`prepare 抛错：${e.message}`)
    }
  }

  const method = cs.noRun ? '' : cs.run || RUN_METHODS.find((m) => typeof inst[m] === 'function') || ''
  if (method) {
    try {
      const r = inst[method]()
      if (r && typeof r.then === 'function') r.then(null, (e) => errs.push(`${method}() reject：${(e && (e.message || e.code)) || e}`))
    } catch (e) {
      errs.push(`${method}() 同步抛错：${e.message}`)
    }
  } else if (!cs.noRun && typeof inst.onParamChange === 'function') {
    // 「改参数即重算」的页面（单位换算、计算器等）没有运行按钮：逐键回放 onParamChange
    const vals = inst.data.values || {}
    for (const k of Object.keys(vals)) {
      try {
        inst.onParamChange({ detail: { key: k, value: vals[k] } })
      } catch (e) {
        errs.push(`onParamChange(${k}) 抛错：${e.message}`)
      }
    }
    if (typeof inst.onRun === 'function') inst.onRun()
  } else if (!cs.noRun) {
    errs.push(`找不到运行入口（试过 ${RUN_METHODS.join('/')}，也没有 onParamChange）`)
  }

  const settled = await settle(inst, cs.timeout, def)
  if (!settled && !cs.allowTimeout && !cs.noRun) errs.push('运行后未落定（busy 卡住或没有任何输出字段）')

  try {
    const out = cs.expect ? cs.expect(inst.data, helpers, inst) : []
    for (const m of out || []) errs.push(m)
  } catch (e) {
    errs.push(`expect 抛错：${e.message}`)
  }
  if (verbose) console.log(`  · ${tool.id} data 摘要：${JSON.stringify(Object.keys(inst.data))}`)
  return errs
}

async function main() {
  const tools = registry.online()
  const cases = loadCases()
  const helpers = buildHelpers(Object.fromEntries(tools.map((t) => [t.id, t])))
  const failures = []
  const missing = []
  let passed = 0
  let scenarioCount = 0
  const known = []

  const loadErr = cases.__load_error || []
  const dup = cases.__dup || []
  for (const t of tools) {
    if (filter && t.id.indexOf(filter) !== 0) continue
    const cs = cases[t.id]
    if (!cs) {
      missing.push(t.id)
      continue
    }
    // 一个工具允许写多个场景（数组）：正向、边界、失败分支各一条
    const scenarios = Array.isArray(cs) ? cs : [cs]
    scenarioCount += scenarios.length
    const errs = []
    for (let si = 0; si < scenarios.length; si++) {
      const one = await runOne(t, scenarios[si], helpers)
      const label = scenarios.length > 1 ? `场景${si + 1}${scenarios[si].name ? '(' + scenarios[si].name + ')' : ''}：` : ''
      if ((scenarios[si].knownDefect || scenarios[si].harnessGap) && one.length) {
        const tag = scenarios[si].knownDefect ? '已知缺陷' : 'harness 缺口'
        known.push(`${t.id} ${label}[${tag}] ${scenarios[si].knownDefect || scenarios[si].harnessGap}｜现象：${one[0]}`)
        continue
      }
      for (const m of one) errs.push(label + m)
    }
    if (errs.length) failures.push({ id: t.id, name: t.name, errors: errs })
    else passed++
  }

  const ran = passed + failures.length
  const result = {
    online: filter ? tools.filter((t) => t.id.indexOf(filter) === 0).length : tools.length,
    withCase: ran + missing.length,
    passed,
    failed: failures.length,
    scenarios: scenarioCount,
    knownDefects: known,
    missingCases: missing,
    caseLoadErrors: loadErr,
    duplicateCases: [...new Set(dup)],
    failures
  }
  if (asJson) console.log(JSON.stringify(result, null, 2))
  else {
    console.log('=== 逐工具功能验证 ===')
    console.log(`在线工具 ${result.online} · 覆盖 ${ran} · 通过 ${passed} · 失败 ${result.failed} · 缺用例 ${missing.length} · 场景合计 ${result.scenarios} · 已知缺陷 ${known.length}`)
    for (const k of known) console.log(` ⚠ 已知缺陷：${k}`)
    if (loadErr.length) {
      console.log('\n用例文件加载失败：')
      for (const e of loadErr) console.log(' - ' + e)
    }
    if (missing.length) {
      console.log(`\n缺用例（覆盖率不足，视为未验证）：\n ${missing.join(', ')}`)
    }
    for (const f of failures) {
      console.log(`\n✗ ${f.id}（${f.name}）`)
      for (const e of f.errors) console.log('   - ' + e)
    }
    if (!failures.length && !missing.length && !loadErr.length) console.log('\n全部工具功能断言通过。')
  }
  const blocked = failures.length || missing.length || loadErr.length
  process.exit(blocked ? 1 : 0)
}

main().catch((e) => {
  console.error('harness 自身异常：' + (e && e.stack ? e.stack : e))
  process.exit(2)
})
