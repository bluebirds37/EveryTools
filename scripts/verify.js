#!/usr/bin/env node
/* 集成校验：路径/语法/清单一致性。用法 node scripts/verify.js */
const fs = require('fs')
const path = require('path')
const cp = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const MP = path.join(ROOT, 'miniprogram')
const problems = []
const notes = []
let checkedFiles = 0

const read = (p) => fs.readFileSync(p, 'utf8')
const exists = (p) => fs.existsSync(p)
const rel = (p) => path.relative(ROOT, p)

function walk(dir, out) {
  out = out || []
  if (!exists(dir)) return out
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    const st = fs.statSync(p)
    if (st.isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

const appJson = JSON.parse(read(path.join(MP, 'app.json')))

function declaredPages() {
  const list = (appJson.pages || []).slice()
  for (const sp of appJson.subPackages || []) {
    for (const p of sp.pages || []) list.push(sp.root + '/' + p)
  }
  return list
}

const pages = declaredPages()

// 1. 页面四件套
for (const p of pages) {
  const base = path.join(MP, p)
  const dir = base
  const variants = [base, dir]
  const found = variants.find((v) => exists(v + '.js')) || base
  for (const ext of ['.js', '.wxml', '.wxss', '.json']) {
    if (!exists(found + ext)) problems.push('缺页面文件: ' + rel(found + ext))
  }
  if (exists(found + '.json')) {
    try { JSON.parse(read(found + '.json')) } catch (e) { problems.push('JSON 解析失败: ' + rel(found + '.json') + ' ' + e.message) }
  }
}

// 2. tabBar 页必须在 pages 中
for (const item of (appJson.tabBar && appJson.tabBar.list) || []) {
  if (pages.indexOf(item.pagePath) < 0) problems.push('tabBar 页面未注册: ' + item.pagePath)
}
if (appJson.tabBar && appJson.tabBar.custom && !exists(path.join(MP, 'custom-tab-bar/index.js'))) {
  problems.push('tabBar.custom=true 但缺少 custom-tab-bar/index.js')
}

// 3. 全部 js/wxss/json/wxml 文件检查
const allFiles = walk(MP)
for (const f of allFiles) {
  if (f.endsWith('.js')) {
    checkedFiles++
    const r = cp.spawnSync('node', ['--check', f], { encoding: 'utf8' })
    if (r.status !== 0) problems.push('语法错误: ' + rel(f) + ' :: ' + (r.stderr || '').split('\n')[0])
  }
  if (f.endsWith('.json') && !f.endsWith('project.config.json')) {
    try { JSON.parse(read(f)) } catch (e) { problems.push('JSON 解析失败: ' + rel(f) + ' ' + e.message) }
  }
}

// 4. 组件引用路径存在
const compRe = /"([^"']*\/components\/[^"]+|\/components\/[^"]+)"\s*:\s*"\/components\/([^"]+)\/index"/g
for (const f of allFiles.filter((x) => x.endsWith('.json'))) {
  const txt = read(f)
  const m = txt.match(/"usingComponents"\s*:\s*{[\s\S]*?}/g) || []
  for (const block of m) {
    const refs = block.match(/"\/?components\/[^"]+"/g) || []
    for (const raw of refs) {
      const ref = raw.replace(/"/g, '')
      const target = path.join(MP, ref.replace(/^\//, '') + '.js')
      if (!exists(target)) problems.push('组件不存在: ' + rel(f) + ' -> ' + ref)
    }
  }
}

// 5. registry 与页面路径一致性
const defsDir = path.join(MP, 'tools/defs')
if (!exists(defsDir)) {
  problems.push('缺少 tools/defs 目录')
} else {
  let tools = []
  try {
    tools = require(path.join(MP, 'tools/index.js'))
  } catch (e) {
    problems.push('require tools/index.js 失败: ' + e.message)
  }
  const ids = new Set()
  const CATS = ['image', 'video', 'qr', 'text', 'calc', 'life', 'dev']
  const ICONS_KEY = 'icons'
  for (const t of tools) {
    if (ids.has(t.id)) problems.push('工具 id 重复: ' + t.id)
    ids.add(t.id)
    if (CATS.indexOf(t.category) < 0) problems.push('非法分类: ' + t.id + ' ' + t.category)
    if (!['online', 'beta', 'offline'].includes(t.status)) problems.push('非法 status: ' + t.id)
    if (!['client', 'server', 'hybrid'].includes(t.engine)) problems.push('非法 engine: ' + t.id)
    for (const k of ['fr', 'name', 'desc', 'icon', 'entry', 'version']) {
      if (!t[k]) problems.push('字段缺失 ' + k + ': ' + t.id)
    }
    if (!Array.isArray(t.keywords) || t.keywords.length < 3) problems.push('keywords 不足 3 个: ' + t.id)
    if (t.status !== 'offline') {
      const relEntry = t.entry.replace(/^\//, '')
      if (pages.indexOf(relEntry) < 0) problems.push('online 工具页面未注册于 app.json: ' + t.id + ' -> ' + t.entry)
      if (!exists(path.join(MP, relEntry + '.js'))) problems.push('online 工具页面文件不存在: ' + t.id)
    }
  }
  notes.push('工具条目 ' + tools.length + '，online ' + tools.filter((t) => t.status === 'online').length +
    '，beta ' + tools.filter((t) => t.status === 'beta').length +
    '，offline ' + tools.filter((t) => t.status === 'offline').length)
  const frs = new Set(tools.map((t) => t.fr))
  notes.push('FR 覆盖 ' + frs.size + ' 条')
  if (tools.length && tools.length !== 92) notes.push('注意：清单条数为 ' + tools.length + '（文档规划 92）')

  // 反向：已注册但未出现在清单里的分包页面
  const entries = new Set(tools.map((t) => t.entry.replace(/^\//, '')))
  for (const p of pages) {
    if (!p.startsWith('package') && !p.startsWith('skills')) continue
    if (!entries.has(p)) notes.push('页面存在但清单未登记: ' + p)
  }
}

// 6. AI skill 一致性
const skillDir = path.join(MP, 'skills/toolbox-skill')
if (exists(skillDir)) {
  try {
    const mcp = JSON.parse(read(path.join(skillDir, 'mcp.json')))
    const names = (mcp.apis || []).map((a) => a.name)
    notes.push('mcp.json 接口 ' + names.length + ' 个')
    for (const a of mcp.apis || []) {
      const ui = a._meta && a._meta.ui
      if (ui && ui.pagePath) {
        const rp = ui.pagePath.replace(/^\//, '')
        if (pages.indexOf(rp) < 0) problems.push('AI pagePath 未注册: ' + a.name + ' -> ' + ui.pagePath)
      }
    }
  } catch (e) { problems.push('mcp.json 解析失败: ' + e.message) }
} else {
  notes.push('（skills/toolbox-skill 尚未生成）')
}

// 7. 相对 require 目标必须存在（跨批次集成最容易断的地方）
const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g
for (const f of allFiles.filter((x) => x.endsWith('.js'))) {
  const txt = read(f)
  let m
  requireRe.lastIndex = 0
  while ((m = requireRe.exec(txt))) {
    const spec = m[1]
    if (!spec.startsWith('.') && !spec.startsWith('/')) continue
    const target = spec.startsWith('/')
      ? path.join(MP, spec.slice(1))
      : path.resolve(path.dirname(f), spec)
    if (exists(target) || exists(target + '.js') || exists(path.join(target, 'index.js'))) continue
    problems.push('require 目标不存在: ' + rel(f) + ' -> ' + spec)
  }
}

// 8. 工具页必须使用 tool-shell 外壳并声明 usingComponents
for (const p of pages) {
  if (!p.startsWith('package')) continue
  const jf = path.join(MP, p + '.json')
  if (!exists(jf)) continue
  let cfg = null
  try { cfg = JSON.parse(read(jf)) } catch (e) { continue }
  const uc = (cfg.usingComponents || {})
  const hasShell = Object.keys(uc).some((k) => /tool-shell/.test(k))
  if (!hasShell) problems.push('工具页缺少 tool-shell: ' + p)
  const wxml = path.join(MP, p + '.wxml')
  if (exists(wxml) && !/<tool-shell/.test(read(wxml))) problems.push('wxml 未渲染 tool-shell: ' + p)
}

// 9. 禁用项扫描
const banned = [
  [/\bTODO\b/, '残留 TODO'],
  [/getPhoneNumber/, '禁止使用 getPhoneNumber'],
  [/getUserProfile/, '禁止使用 wx.getUserProfile'],
  [/\beval\s*\(/, '禁止 eval'],
  [/new Function\s*\(/, '禁止 new Function']
]
for (const f of allFiles.filter((x) => x.endsWith('.js') || x.endsWith('.wxml'))) {
  const txt = read(f)
  for (const [re, msg] of banned) {
    if (re.test(txt)) problems.push(msg + ': ' + rel(f))
  }
}

// 后端开关（GET /tools/flags）必须真正门控工具可见性：禁用后列表与入口同时消失
;(function checkToolFlags() {
  require('./mock-wx')
  const store = require('../miniprogram/utils/store')
  const registry = require('../miniprogram/tools/registry')
  const sample = registry.online()[0]
  if (!sample) { problems.push('registry 无在线工具，无法验证 tool_flags 门控'); return }
  const before = registry.byCategory(sample.category).length
  store.set('tool_flags', JSON.parse(JSON.stringify({ [sample.id]: { enabled: false } })))
  const after = registry.byCategory(sample.category).length
  const gated = !registry.isOnline(sample.id) && registry.entryPath(sample.id) === null
  store.set('tool_flags', {})
  if (after !== before - 1 || !gated) {
    problems.push('tool_flags 门控失效：禁用 ' + sample.id + ' 后分类计数 ' + before + '→' + after + '，入口可达=' + !gated)
  } else {
    notes.push('tool_flags 门控：禁用 ' + sample.id + ' → 分类 ' + sample.category + ' 由 ' + before + ' 减为 ' + after + '，entryPath 置空')
  }
})()

console.log('=== 校验结果 ===')
console.log('检查 JS 文件：' + checkedFiles + ' 个；注册页面：' + pages.length + ' 个')
for (const n of notes) console.log('· ' + n)
if (problems.length) {
  console.log('\n!!! 问题 ' + problems.length + ' 项:')
  for (const p of problems) console.log(' - ' + p)
  process.exit(1)
}
console.log('\n通过：无阻塞问题')
