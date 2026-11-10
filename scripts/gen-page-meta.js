#!/usr/bin/env node
/* 由 tools/registry 生成 miniprogram/page-meta.json（FR-AI-10）：node scripts/gen-page-meta.js */
const path = require('path')
const fs = require('fs')
const MP = path.resolve(__dirname, '..', 'miniprogram')
const registry = require(path.join(MP, 'tools/registry.js'))

const appJson = JSON.parse(fs.readFileSync(path.join(MP, 'app.json'), 'utf8'))
const pages = []
for (const p of appJson.pages || []) pages.push(p)
for (const sp of appJson.subPackages || []) {
  for (const p of sp.pages || []) pages.push(sp.root + '/' + p)
}

const entries = [
  { path: 'pages/home/home', name: '工具箱首页', description: '浏览与搜索全部工具，进入图片、视频、条码、文本、换算等常用工具' },
  { path: 'pages/category/category', name: '工具分类', description: '按分类查看全部可用工具' },
  { path: 'pages/search/search', name: '搜索工具', description: '按关键词查找工具箱内的具体工具' },
  { path: 'pages/mine/mine', name: '我的', description: '查看收藏、最近使用的工具与设置' },
  { path: 'pages/tool-detail/tool-detail', name: '工具详情', description: '查看单个工具的说明、限制与使用入口' }
]

for (const t of registry.online()) {
  const rel = t.entry.replace(/^\//, '')
  if (pages.indexOf(rel) < 0) continue
  entries.push({ path: rel, name: t.name, description: t.desc + '（' + t.fr + '）' })
}

const out = { pages: entries.filter((e, i, arr) => arr.findIndex((x) => x.path === e.path) === i) }
fs.writeFileSync(path.join(MP, 'page-meta.json'), JSON.stringify(out, null, 2) + '\n')
console.log('page-meta.json 已生成，页面数 ' + out.pages.length + '（在线工具 ' + registry.online().length + '）')
