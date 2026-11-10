// formatJson —— JSON 格式化（FR-AI-03：对话内直接返回结果，不出卡、不 handoff；同源 FR-TXT-01）
// 真实计算走 utils/calc.js（与主包 packageText 同源逻辑的 skill 内独立副本）。
const { formatJson: calcFormat } = require('../utils/calc.js')

const MAX_INLINE = 4000 // 对话内直接展示的最大字符数，超出截断并给页面出口

async function formatJson({ content, indent, sortKeys, mode } = {}) {
  try {
    const text = typeof content === 'string' ? content : String(content == null ? '' : content)
    if (!text.trim()) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: '缺少待格式化的 JSON 文本。禁止替用户编造 JSON 内容。正确出口：请用户把要格式化的文本发出来（或粘贴到对话），再携 content 调用本接口。'
        }]
      }
    }

    const opts = {
      indent: indent === 4 || indent === '4' ? 4 : (indent === 'tab' ? 'tab' : 2),
      sortKeys: sortKeys === true || sortKeys === 'true',
      mode: mode === 'minify' || mode === 'validate' ? mode : 'pretty'
    }
    const res = calcFormat(text, opts)

    if (!res.ok) {
      const loc = res.error.line + ':' + res.error.col
      const snippetBlock = res.error.snippet ? '\n' + res.error.snippet : ''
      return {
        isError: true,
        content: [{
          type: 'text',
          text: `JSON 解析失败（第 ${loc} 行:列）。${res.error.message}${snippetBlock}\n请把出错位置转告用户并请其核对原文后重试。禁止替用户猜测补全符号、删改内容后再次调用本接口；若用户坚持要完整校验/树视图，引导其在小程序 JSON 格式化页处理。`
        }],
        structuredContent: { valid: false, error: { line: res.error.line, col: res.error.col, message: res.error.message } }
      }
    }

    if (opts.mode === 'validate') {
      return {
        isError: false,
        content: [{
          type: 'text',
          text: `JSON 校验通过（根类型 ${res.stats.rootType}，共 ${res.stats.inputLength} 字符）。请用一句话把结论告诉用户，可顺带询问是否需要美化或压缩。`
        }],
        structuredContent: { valid: true, rootType: res.stats.rootType, inputLength: res.stats.inputLength }
      }
    }

    const out = res.formatted
    const truncated = out.length > MAX_INLINE
    const shown = truncated ? out.slice(0, MAX_INLINE) : out

    return {
      isError: false,
      content: [{
        type: 'text',
        text: `JSON ${opts.mode === 'minify' ? '压缩' : '格式化'}完成（${res.stats.inputLength} → ${res.stats.outputLength} 字符）。结果如下${truncated ? '（较长，已截断，完整结果可在小程序 JSON 格式化页复制）' : ''}：\n${shown}`
      }],
      structuredContent: {
        valid: true,
        mode: opts.mode,
        outputLength: res.stats.outputLength,
        inputLength: res.stats.inputLength,
        truncated,
        formatted: truncated ? out.slice(0, 500) + '…' : out
      },
      _meta: { fullOutput: out }
    }
  } catch (err) {
    console.error('[formatJson] error', err)
    return {
      isError: true,
      content: [{ type: 'text', text: `JSON 处理失败：${err.message || '未知错误'}。请引导用户改用小程序 JSON 格式化页。` }]
    }
  }
}

module.exports = formatJson
