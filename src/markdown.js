// dsh-chat-export - transcript model to Markdown.
//
// A pure renderer: the only external decision it needs is how an attachment
// reference becomes an image source, which the caller supplies as `imageSrc`
// (a `data:` URI for a self-contained file, or a relative `assets/...` path
// for a bundle). Model and user text is deliberately NOT escaped - it is the
// conversation itself - while the synthesized parts (headings, table cells)
// are.

/** A fenced code block whose fence is longer than any run inside the body. */
export function fence(body, language = '') {
  const text = String(body ?? '')
  let longest = 0
  for (const match of text.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length)
  const marker = '`'.repeat(Math.max(3, longest + 1))
  return `${marker}${language}\n${text}\n${marker}`
}

/** Escape the characters that would break a Markdown table cell. */
export function escapeTableCell(value) {
  return String(value ?? '')
    .replace(/\\/gu, '\\\\')
    .replace(/\|/gu, '\\|')
    .replace(/\r?\n/gu, '<br>')
}

/** `YYYY-MM-DD HH:mm:ss` in local time; `--:--:--` for a missing stamp. */
export function formatStamp(epochMs) {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs) || epochMs <= 0) return '--:--:--'
  const date = new Date(epochMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** `HH:mm:ss` in local time. */
export function formatClock(epochMs) {
  const full = formatStamp(epochMs)
  return full === '--:--:--' ? full : full.slice(11)
}

/** A compact duration such as `1.2s`, `3m 04s`, or `1h 06m`. */
export function formatDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds - minutes * 60)
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes - hours * 60).padStart(2, '0')}m`
}

/** Thousands-separated integer. */
export function formatNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return Math.round(number).toLocaleString('en-US')
}

/** Human-readable byte size. */
export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`
}

/** One-line attachment description used when images are not rendered inline. */
export function describeAttachment(ref) {
  const parts = []
  if (typeof ref.width === 'number' && typeof ref.height === 'number') parts.push(`${ref.width}×${ref.height}`)
  if (typeof ref.bytes === 'number') parts.push(formatBytes(ref.bytes))
  return parts.join(', ')
}

/** Display name for an attachment reference. */
export function attachmentName(ref) {
  if (typeof ref.name === 'string' && ref.name !== '') return ref.name
  const id = String(ref.attachmentId ?? 'attachment')
  return id.length > 24 ? `${id.slice(0, 21)}…` : id
}

/** The metadata table at the top of the transcript. */
function renderMeta(transcript) {
  const { meta } = transcript
  const lines = []
  const rows = []
  if (meta.sessionId !== '') rows.push(['会话 ID', `\`${escapeTableCell(meta.sessionId)}\``])
  if (meta.cwd !== '') rows.push(['工作目录', `\`${escapeTableCell(meta.cwd)}\``])
  if (meta.models.length > 0) {
    rows.push(['模型', meta.models.map((model) => `\`${escapeTableCell(model)}\``).join(' · ')])
  }
  if (meta.createdAt > 0) {
    const span = meta.updatedAt > meta.createdAt ? ` → ${formatStamp(meta.updatedAt)}（${formatDuration(meta.updatedAt - meta.createdAt)}）` : ''
    rows.push(['时间', `${formatStamp(meta.createdAt)}${span}`])
  }
  const counts = meta.counts
  rows.push([
    '规模',
    `${formatNumber(counts.turns)} 轮 · ${formatNumber(counts.steps)} 步 · 用户 ${formatNumber(counts.humanMessages)} 条 · 助手 ${formatNumber(counts.assistantMessages)} 条 · 工具调用 ${formatNumber(counts.toolCalls)} 次`,
  ])
  if (meta.options.thinking) rows.push(['思考块', `${formatNumber(counts.reasoningBlocks)} 段`])
  const extra = []
  if (counts.images > 0) extra.push(`图片 ${formatNumber(counts.images)} 张`)
  if (counts.files > 0) extra.push(`文件 ${formatNumber(counts.files)} 个`)
  if (counts.injectedMessages > 0) extra.push(`注入消息 ${formatNumber(counts.injectedMessages)} 条`)
  if (extra.length > 0) rows.push(['附件', extra.join(' · ')])
  if (meta.options.usage && meta.usage.reportedSteps > 0) {
    const usage = meta.usage
    const parts = [
      `输入 ${formatNumber(usage.inputTokens)}`,
      `输出 ${formatNumber(usage.outputTokens)}`,
      `缓存读 ${formatNumber(usage.cacheReadTokens)}`,
      `缓存写 ${formatNumber(usage.cacheWriteTokens)}`,
      `推理 ${formatNumber(usage.reasoningTokens)}`,
      `合计 ${formatNumber(usage.totalTokens)}`,
    ]
    rows.push(['用量', `${parts.join(' · ')}（${formatNumber(usage.reportedSteps)} 步上报）`])
  }
  if (meta.scope === 'surface') rows.push(['范围', '仅当前模型上下文（已被压缩/删除的历史不含在内）'])

  if (rows.length === 0) return lines
  lines.push('| 项 | 内容 |', '| --- | --- |')
  for (const [key, value] of rows) lines.push(`| ${key} | ${value} |`)
  return lines
}

/** Render one image part. */
function renderImage(part, context) {
  const source = context.imageSrc === undefined ? null : context.imageSrc(part.ref)
  const name = attachmentName(part.ref)
  if (source === null || source === undefined) {
    const detail = describeAttachment(part.ref)
    return `> 🖼 图片：${name}${detail === '' ? '' : `（${detail}）`}`
  }
  const detail = describeAttachment(part.ref)
  return `![${name}](${source})${detail === '' ? '' : `\n\n<sub>${name} · ${detail}</sub>`}`
}

/** Render one message part list. */
function renderParts(parts, context) {
  const blocks = []
  for (const part of parts) {
    if (part.type === 'text') blocks.push(part.text)
    else if (part.type === 'reasoning') {
      const length = Array.from(part.text).length
      blocks.push(`<details>\n<summary>💭 思考（${formatNumber(length)} 字）</summary>\n\n${part.text}\n\n</details>`)
    } else if (part.type === 'image') blocks.push(renderImage(part, context))
    else if (part.type === 'file') {
      const source = context.imageSrc === undefined ? null : context.imageSrc(part.ref)
      const name = attachmentName(part.ref)
      blocks.push(source === null || source === undefined ? `> 📎 文件：${name}` : `📎 [${name}](${source})`)
    }
  }
  return blocks
}

/** Render one tool entry. */
function renderTool(entry, context) {
  const blocks = []
  const duration = formatDuration(entry.durationMs)
  const suffix = duration === '' ? '' : ` · ${duration}`
  blocks.push(`**🔧 工具调用 \`${entry.name}\`**${suffix}`)
  if (entry.arguments !== '') {
    const pretty = context.prettyJson === false ? entry.arguments : prettyJson(entry.arguments)
    blocks.push(fence(pretty, 'json'))
  }
  if (entry.result !== null) {
    const result = entry.result
    const manual = result.truncated ? `已截断，共 ${formatNumber(result.totalChars)} 字 / ${formatNumber(result.totalLines)} 行` : `${formatNumber(result.totalLines)} 行`
    const summary = result.isError ? `❌ 结果（出错 · ${manual}）` : `📄 结果（${manual}）`
    const body = result.text === '' ? '（无文本输出）' : result.text
    blocks.push(`<details>\n<summary>${summary}</summary>\n\n${fence(body, 'text')}\n\n</details>`)
    for (const ref of result.images ?? []) blocks.push(renderImage({ type: 'image', ref }, context))
  }
  return blocks
}

/** Pretty-print a JSON string, falling back to the raw text. */
export function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** Label for one assistant heading. */
function assistantLabel(entry, options) {
  const bits = ['🤖 助手']
  if (options.timestamps && entry.at > 0) bits.push(formatClock(entry.at))
  if (entry.model !== '') bits.push(`\`${entry.model}\``)
  if (entry.interrupted) bits.push('（被打断）')
  return bits.join(' · ')
}

/**
 * Render a transcript as Markdown.
 *
 * @param transcript - the model returned by `buildTranscript`.
 * @param context - `{ imageSrc?, prettyJson? }`; `imageSrc(ref)` returns a
 *   usable source string, or null to describe the image instead of embedding it.
 * @returns the Markdown document.
 */
export function renderMarkdown(transcript, context = {}) {
  const { meta } = transcript
  const out = []
  out.push(`# ${meta.title === '' ? '会话记录' : meta.title}`)
  out.push('')
  out.push(`> 由 [dsh-chat-export](https://github.com/DDDMUC/dsh-chat-export) 从 DeepSeek Harness 会话导出`)
  out.push('')
  out.push(...renderMeta(transcript))
  out.push('')
  out.push('---')

  for (const entry of transcript.entries) {
    if (entry.kind === 'turn') {
      const bits = [`## 回合 ${entry.index ?? '?'}`]
      if (entry.durationMs !== null) bits.push(`<sub>${formatDuration(entry.durationMs)}</sub>`)
      out.push('', bits.join(' '))
      continue
    }

    if (entry.kind === 'note') {
      const icon = entry.level === 'warn' ? '⚠️' : 'ℹ️'
      out.push('', `> ${icon} ${entry.text}${meta.options.timestamps && entry.at > 0 ? ` — ${formatClock(entry.at)}` : ''}`)
      continue
    }

    if (entry.kind === 'user') {
      const bits = [entry.human ? '🧑 用户' : '📥 注入内容']
      if (meta.options.timestamps && entry.at > 0) bits.push(formatClock(entry.at))
      if (!entry.human && entry.origin !== '') bits.push(`\`${entry.origin}\``)
      out.push('', `### ${bits.join(' · ')}`)
      out.push('', ...interleave(renderParts(entry.parts, context)))
      continue
    }

    if (entry.kind === 'assistant') {
      out.push('', `### ${assistantLabel(entry, meta.options)}`)
      const blocks = renderParts(entry.parts, context)
      if (blocks.length === 0) blocks.push('_（本条没有可显示的内容）_')
      out.push('', ...interleave(blocks))
      continue
    }

    if (entry.kind === 'tool') {
      if (!meta.options.tools) continue
      out.push('', ...interleave(renderTool(entry, context)))
      continue
    }

    if (entry.kind === 'system') {
      out.push('', '<details>', `<summary>⚙️ 系统提示（回合 ${entry.turn ?? '?'}）</summary>`, '', entry.text, '', '</details>')
    }
  }

  out.push('')
  return `${out.join('\n').replace(/\n{4,}/gu, '\n\n\n')}`
}

/** Join rendered blocks with the blank line Markdown needs between them. */
function interleave(blocks) {
  const out = []
  for (const block of blocks) {
    if (out.length > 0) out.push('')
    out.push(block)
  }
  return out
}
