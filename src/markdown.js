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
  // Round to whole seconds FIRST. Splitting an unrounded value and rounding the
  // remainder afterwards prints things like "41m 60s".
  const totalSeconds = Math.round(ms / 1000)
  if (totalSeconds < 60) return `${(ms / 1000).toFixed(1)}s`
  const seconds = totalSeconds % 60
  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${String(seconds).padStart(2, '0')}s`
  const minutes = totalMinutes % 60
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}h ${String(minutes).padStart(2, '0')}m`
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

/**
 * The header block: a quiet identity line, then a four-row fact table.
 *
 * Identifying a session needs its id and working directory; reading one needs
 * the model, the window, the size, and the cost. The first pair is a footnote
 * nobody scans twice, so it stays a single dim line; the second pair is a
 * table. Zero-valued usage fields are dropped rather than printed as zeroes.
 */
function renderMeta(transcript) {
  const { meta } = transcript
  const counts = meta.counts
  const lines = []

  const identity = []
  if (meta.sessionId !== '') identity.push(`\`${escapeTableCell(meta.sessionId)}\``)
  if (meta.cwd !== '') identity.push(`\`${escapeTableCell(meta.cwd)}\``)
  if (identity.length > 0) lines.push(identity.join(' · '), '')

  const rows = []
  if (meta.models.length > 0) {
    rows.push(['模型', meta.models.map((model) => `\`${escapeTableCell(model)}\``).join(' · ')])
  }
  if (meta.createdAt > 0) {
    const span = meta.updatedAt > meta.createdAt ? ` → ${formatStamp(meta.updatedAt)}（${formatDuration(meta.updatedAt - meta.createdAt)}）` : ''
    rows.push(['时间', `${formatStamp(meta.createdAt)}${span}`])
  }
  const size = [`${formatNumber(counts.turns)} 轮`, `${formatNumber(counts.steps)} 步`, `${formatNumber(counts.toolCalls)} 次工具调用`]
  if (counts.humanMessages > 0) size.splice(2, 0, `用户 ${formatNumber(counts.humanMessages)} 条`)
  if (counts.assistantMessages > 0) size.splice(3, 0, `助手 ${formatNumber(counts.assistantMessages)} 条`)
  if (counts.images > 0) size.push(`图片 ${formatNumber(counts.images)} 张`)
  if (meta.options.thinking && counts.reasoningBlocks > 0) size.push(`思考 ${formatNumber(counts.reasoningBlocks)} 段`)
  if (counts.injectedMessages > 0) size.push(`注入 ${formatNumber(counts.injectedMessages)} 条`)
  rows.push(['规模', size.join(' · ')])
  if (meta.options.usage && meta.usage.reportedSteps > 0) {
    const usage = meta.usage
    const parts = [`输入 ${formatNumber(usage.inputTokens)}`, `输出 ${formatNumber(usage.outputTokens)}`]
    if (usage.cacheReadTokens > 0) parts.push(`缓存读 ${formatNumber(usage.cacheReadTokens)}`)
    if (usage.cacheWriteTokens > 0) parts.push(`缓存写 ${formatNumber(usage.cacheWriteTokens)}`)
    if (usage.reasoningTokens > 0) parts.push(`推理 ${formatNumber(usage.reasoningTokens)}`)
    parts.push(`合计 ${formatNumber(usage.totalTokens)}`)
    rows.push(['用量', parts.join(' · ')])
  }
  if (meta.scope === 'surface') rows.push(['范围', '仅当前模型上下文'])

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
    return `> 图片：${name}${detail === '' ? '' : `（${detail}）`}`
  }
  const detail = describeAttachment(part.ref)
  return `![${name}](${source})${detail === '' ? '' : `\n\n_${name} · ${detail}_`}`
}

/**
 * Re-level and de-fang one message body before it enters the document.
 *
 * Two things go wrong when conversation text is dropped into a transcript as
 * raw Markdown:
 *
 *   * its headings collide with the transcript's own outline - a session that
 *     starts with `# 任务：...` otherwise renders as the document's title, and
 *     the reader loses the turn structure entirely;
 *   * a literal `<details>` in the conversation opens a real disclosure in
 *     every renderer that supports raw HTML, which silently swallows the rest
 *     of the message.
 *
 * So headings are shifted below the message level, and block-level HTML tags
 * are backslash-escaped. Both edits are invisible in the rendered output: an
 * escaped `\<details>` still displays as `<details>`.
 *
 * Code fences are left untouched - their contents are code, not markup.
 *
 * @param text - one message body.
 * @returns the body with headings demoted and block HTML neutralized.
 */
export function normalizeMessageBody(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let fence = null
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence === null && marker !== null) {
      fence = marker[1][0].repeat(marker[1].length)
      out.push(line)
      continue
    }
    if (fence !== null) {
      if (line.trimStart().startsWith(fence)) fence = null
      out.push(line)
      continue
    }
    const heading = /^(#{1,6})(\s+.*)$/u.exec(line)
    if (heading !== null) {
      const level = Math.min(6, heading[1].length + 3)
      out.push(`${'#'.repeat(level)}${heading[2]}`)
      continue
    }
    out.push(line.replace(/<(\/?)(details|summary)\b/giu, '\\<$1$2'))
  }
  return out.join('\n')
}

/** Render one message part list. */
function renderParts(parts, context) {
  const blocks = []
  for (const part of parts) {
    if (part.type === 'text') blocks.push(normalizeMessageBody(part.text))
    else if (part.type === 'reasoning') {
      const length = Array.from(part.text).length
      blocks.push(`<details>\n<summary>思考（${formatNumber(length)} 字）</summary>\n\n${normalizeMessageBody(part.text)}\n\n</details>`)
    } else if (part.type === 'image') blocks.push(renderImage(part, context))
    else if (part.type === 'file') {
      const source = context.imageSrc === undefined ? null : context.imageSrc(part.ref)
      const name = attachmentName(part.ref)
      blocks.push(source === null || source === undefined ? `> 文件：${name}` : `[${name}](${source})`)
    }
  }
  return blocks
}

/** The one-line label for a tool entry, used as its disclosure summary. */
export function toolSummary(entry) {
  const bits = [`\`${entry.name}\``]
  if (entry.result !== null && entry.result.isError) bits.push('· 出错')
  const duration = formatDuration(entry.durationMs)
  if (duration !== '') bits.push(`· ${duration}`)
  const result = entry.result
  if (result !== null) {
    if (result.truncated) bits.push(`· 结果已截断（共 ${formatNumber(result.totalChars)} 字）`)
    else bits.push(`· 结果 ${formatNumber(result.totalLines)} 行`)
  }
  return bits.join(' ')
}

/**
 * Render one tool entry as a single collapsed line.
 *
 * Arguments and result both live inside the disclosure: a coding session is
 * hundreds of tool calls, and printing each one's JSON inline turns a
 * transcript into a log. Collapsed, the conversation reads as a conversation
 * and any call can still be opened in full.
 */
function renderTool(entry, context) {
  const inner = []
  if (entry.arguments !== '') {
    const pretty = context.prettyJson === false ? entry.arguments : prettyJson(entry.arguments)
    inner.push('**参数**', '', fence(pretty, 'json'))
  }
  if (entry.result !== null) {
    if (inner.length > 0) inner.push('')
    const body = entry.result.text === '' ? '（无文本输出）' : entry.result.text
    inner.push('**结果**', '', fence(body, 'text'))
  }

  const blocks = []
  if (inner.length === 0) blocks.push(`**${toolSummary(entry)}**`)
  else blocks.push(`<details>\n<summary>${toolSummary(entry)}</summary>\n\n${inner.join('\n')}\n\n</details>`)
  for (const ref of entry.result?.images ?? []) blocks.push(renderImage({ type: 'image', ref }, context))
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
  const bits = ['助手']
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
      if (entry.durationMs !== null) bits.push('·', formatDuration(entry.durationMs))
      out.push('', bits.join(' '))
      continue
    }

    if (entry.kind === 'note') {
      out.push('', `> ${entry.text}${meta.options.timestamps && entry.at > 0 ? ` — ${formatClock(entry.at)}` : ''}`)
      continue
    }

    if (entry.kind === 'user') {
      const bits = [entry.human ? '用户' : '注入内容']
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
      out.push('', '<details>', `<summary>系统提示（回合 ${entry.turn ?? '?'}）</summary>`, '', normalizeMessageBody(entry.text), '', '</details>')
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
