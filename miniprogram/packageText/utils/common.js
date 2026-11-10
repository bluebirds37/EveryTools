'use strict';
/**
 * packageText/utils/common.js
 * Shared glue for the 13 text tool pages: C6/C7 input validation helpers and
 * clipboard util. Everything else (store.params / track.track / error.message)
 * is called directly from pages per CONTRACT C5.
 */
const error = require('../../utils/error');

const MAX_INPUT_LEN = 1000000; // CONTRACT C7 gate for text tools

/** Validate a free-text input. Returns '' when OK, else a C6 worded message. */
function checkTextInput(value, name) {
  if (value === null || value === undefined || String(value) === '') {
    return name ? '请输入' + name : '请输入内容';
  }
  if (String(value).length > MAX_INPUT_LEN) {
    return '输入过长（超过 1,000,000 字符）';
  }
  return '';
}

/** Build a C5 error object { code, message } from a C6 message string. */
function paramError(message) {
  return { code: 'PARAM_INVALID', message: message };
}

/**
 * Validate an integer value with C6 range wording.
 * @returns { value:number } | { error:{code,message} }
 */
function checkInt(value, min, max, name) {
  const s = String(value === undefined || value === null ? '' : value).trim()
  if (s === '') return { error: paramError('请输入' + (name || '数值')) }
  const n = Number(s)
  if (!isFinite(n) || Math.floor(n) !== n) return { error: paramError('参数错误：' + (name || '数值') + ' 需为整数') }
  if (n < min || n > max) return { error: paramError('参数错误：' + (name || '数值') + ' 需在 ' + min + '–' + max + ' 之间') }
  return { value: n }
}

/** Copy text to clipboard with toast + tracking (result 复制出口). */
function copyText(text, toolId, track) {
  if (!text) {
    wx.showToast({ title: '暂无可复制内容', icon: 'none' })
    return
  }
  wx.setClipboardData({
    data: String(text),
    success() {
      wx.showToast({ title: '已复制', icon: 'success' })
      if (track) track.track('result_copy', { toolId: toolId })
    },
    fail() {
      wx.showToast({ title: '操作失败，请重试', icon: 'none' })
    },
  })
}

module.exports = {
  MAX_INPUT_LEN,
  checkTextInput,
  paramError,
  checkInt,
  copyText,
  errorMessage: error.message,
}
