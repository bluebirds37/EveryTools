#!/usr/bin/env node
/* Headless 冒烟测试：在 mock wx 下加载每个页面/组件并跑生命周期，捕获真实崩溃。
   用法：node scripts/smoke.js [关键词过滤] */
const fs = require('fs')
const path = require('path')
const mock = require('./mock-wx')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const filter = process.argv[2] || ''

function walk(dir, out) {
  out = out || []
  if (!fs.existsSync(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

function setDeep(obj, key, val) {
  const parts = key.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]]
  }
  cur[parts[parts.length - 1]] = val
}

function makeInstance(def, initialData) {
  const inst = Object.assign({}, def.methods ? def.methods : def, {
    data: Object.assign({}, initialData || (def.data || {})),
    setData(patch, val) {
      if (typeof patch === 'string') setDeep(this.data, patch, val)
      else for (const k of Object.keys(patch)) setDeep(this.data, k, patch[k])
    },
    selectComponent() { return { setData() {}, triggerEvent() {}, selectComponent() { return null } } },
    createSelectorQuery() { return wx.createSelectorQuery() },
    getTabBar() { return null },
    animate() {},
    route: '',
    is: 'mock',
    triggerEvent() {},
    createSelectorQueryStub: null
  })
  return inst
}

const registryPath = path.join(MP, 'tools/registry.js')
let registry = null
try {
  registry = require(registryPath)
} catch (e) {
  console.log('!! registry 加载失败：' + e.message)
}

const results = { ok: 0, fail: 0, skipped: 0, failures: [] }

function runFile(file, isComponent) {
  const rel = path.relative(ROOT, file)
  if (filter && rel.indexOf(filter) < 0) { results.skipped++; return }
  if (/mock-wx|verify\.js|smoke\.js|gen-page-meta/.test(rel)) return
  let inst
  try {
    delete require.cache[require.resolve(file)]
    global.__lastPage = null
    global.__lastComponent = null
    require(file)
    const def = isComponent ? global.__lastComponent : global.__lastPage
    if (!def) { results.skipped++; return }
    inst = makeInstance(def, isComponent ? def.properties && {} : null)
  } catch (e) {
    fail(rel, '加载', e)
    return
  }

  const jobs = []
  if (!isComponent) {
    const pagePath = rel.replace('miniprogram/', '').replace(/\.js$/, '')
    let query = {}
    if (registry) {
      const tool = registry.all().find((t) => '/' + pagePath === t.entry)
      if (tool) query = { toolId: tool.id }
    }
    jobs.push(['onLoad', () => inst.onLoad(Object.assign({ toolId: '' }, query))])
    jobs.push(['onShow', () => inst.onShow && inst.onShow()])
    jobs.push(['onReady', () => inst.onReady && inst.onReady()])
    jobs.push(['onPullDownRefresh', () => inst.onPullDownRefresh && inst.onPullDownRefresh()])
    jobs.push(['onShareAppMessage', () => inst.onShareAppMessage && inst.onShareAppMessage({ from: 'menu' })])
    jobs.push(['onUnload', () => inst.onUnload && inst.onUnload()])
  } else {
    jobs.push(['created', () => inst.created && inst.created()])
    jobs.push(['attached', () => inst.attached && inst.attached()])
    jobs.push(['ready', () => inst.ready && inst.ready()])
    jobs.push(['showed', () => inst.show && inst.show()])
  }

  for (const [name, fn] of jobs) {
    try {
      const r = fn()
      if (r && typeof r.then === 'function') r.catch((e) => fail(rel, name + ' (async)', e))
    } catch (e) {
      fail(rel, name, e)
    }
  }
  results.ok++
}

function fail(rel, stage, e) {
  results.fail++
  results.failures.push(rel + ' @' + stage + ' → ' + (e && e.message ? e.message.split('\n')[0] : String(e)))
}

const files = walk(MP)
for (const f of files) {
  if (/app\.js$/.test(f)) continue
  const isComponent = /\/(components)\/[^/]+\/index\.js$/.test(f) || /custom-tab-bar\/index\.js$/.test(f)
  const isPage = /\/pages\/[^/]+(\/index)?\.js$/.test(f)
  if (!isComponent && !isPage) continue
  runFile(f, isComponent)
}

// 给异步链一点时间
setTimeout(() => {
  console.log('=== 冒烟结果 ===')
  console.log('通过 ' + results.ok + ' / 失败 ' + results.fail + ' / 跳过 ' + results.skipped)
  if (registry) console.log('在线工具 ' + registry.online().length)
  if (results.failures.length) {
    console.log('\n失败明细：')
    for (const f of results.failures) console.log(' - ' + f)
    process.exit(1)
  }
  console.log('无崩溃。')
}, 1500)
