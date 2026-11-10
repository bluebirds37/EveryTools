/**
 * utils/env.js —— 运行环境与后端基址（CONTRACT C3）
 *
 * 契约：module.exports = { BASE_URL, VERSION, TIMEOUT, isDev() }
 * BASE_URL 默认本地地址，可被 Storage 键 'api_base' 覆盖（开发/灰度切换用）。
 * 所有请求路径前缀 '/api/v1' 由 apiBase()/url() 统一拼接，业务层只写 '/auth/silent' 这类相对路径。
 */

const STORAGE_KEY = 'api_base'
const API_PREFIX = '/api/v1'
const DEFAULT_BASE_URL = 'http://127.0.0.1:8080'

function readStorage(key) {
  try {
    return typeof wx !== 'undefined' && wx.getStorageSync ? wx.getStorageSync(key) : ''
  } catch (e) {
    return ''
  }
}

/** 去掉尾部斜杠，保证 BASE_URL + '/api/v1/auth/silent' 不出现 '//' */
function normalizeBase(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  return s.indexOf('://') < 0 ? s : s.replace(/\/+$/, '')
}

/** 是否配置了自定义基址（开发机上指向本地服务） */
function hasOverride() {
  return !!normalizeBase(readStorage(STORAGE_KEY))
}

/** 宿主基址（不含 /api/v1）：Storage 覆盖优先，否则默认值 */
function hostBase() {
  return normalizeBase(readStorage(STORAGE_KEY)) || DEFAULT_BASE_URL
}

/** 带版本前缀的 API 根地址 */
function apiBase() {
  return hostBase() + API_PREFIX
}

/** 拼出完整请求地址；已是绝对地址时原样返回（便于 mock / CDN 直链） */
function url(path) {
  const p = String(path || '')
  if (/^https?:\/\//i.test(p)) return p
  return apiBase() + (p.charAt(0) === '/' ? p : '/' + p)
}

/** 当前小程序运行版本：'develop' | 'trial' | 'release' | ''（取不到） */
function envVersion() {
  try {
    if (typeof wx !== 'undefined' && wx.getAccountInfoSync) {
      const info = wx.getAccountInfoSync()
      return (info && info.miniProgram && info.miniProgram.envVersion) || ''
    }
  } catch (e) {
    /* 非小程序环境（单测 / node）忽略 */
  }
  return ''
}

/** 非正式版本视为开发环境：只影响日志详细度，不影响功能 */
function isDev() {
  const v = envVersion()
  if (v) return v !== 'release'
  if (typeof wx === 'undefined') return true
  return hasOverride()
}

module.exports = {
  DEFAULT_BASE_URL,
  API_PREFIX,
  STORAGE_KEY,
  VERSION: '1.0.0',
  TIMEOUT: 15000,
  // BASE_URL 用 getter：每次读取都尊重 Storage 覆盖（开发者改地址后无需重启）
  get BASE_URL() {
    return hostBase()
  },
  isDev,
  hostBase,
  apiBase,
  url,
  envVersion
}
