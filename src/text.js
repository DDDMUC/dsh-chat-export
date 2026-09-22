// dsh-chat-export - transcript model to plain text.
//
// Markdown and HTML both delegate structure to a renderer: headings, fences,
// and disclosures do the work, and the reader's viewer decides how they look.
// A `.txt` has none of that, so this module carries the structure itself with
// the only tools plain text has - rules, indentation, and blank lines.
//
// Message bodies are reproduced verbatim, Markdown markers and all. Stripping
// them would mean rewriting the conversation, and a transcript that silently
// edits what was said is worse than one with a few asterisks in it.

import {
  describeAttachment,
  formatClock,
  formatDuration,
  formatNumber,
  formatStamp,
  prettyJson,
  toolSummary,
} from './markdown.js'

/** Rule widths kept short enough to survive an 80-column terminal. */
const WIDE_RULE = '='.repeat(72)
const THIN_RULE = '-'.repeat(72)

/** One indentation step inside a message. */
const INDENT = '  '

/** One `label  value` line in the header block. */
function metaLine(label, value) {
  return `${label}  ${value}`
}

/** `name（640×480, 2.0 KiB）` for one attachment reference. */
function describeAttachmentRef(ref) {
  const name = ref.name === undefined || ref.name === '' ? String(ref.attachmentId ?? '附件') : String(ref.name)
  const detail = describeAttachment(ref)
  return detail === '' ? name : `${name}（${detail}）`
}

/** The header block: title, identity, and the fact lines. */
function renderHeader(transcript) {
  const { meta } = transcript
  const counts = meta.counts
  const lines = [meta.title === '' ? '会话记录' : meta.title, WIDE_RULE, '']

  if (meta.sessionId !== '') lines.push(meta.sessionId)
  if (meta.cwd !== '') lines.push(meta.cwd)
  if (meta.sessionId !== '' || meta.cwd !== '') lines.push('')

  if (meta.models.length > 0) lines.push(metaLine('模型', meta.models.join(' · ')))
  if (meta.createdAt > 0) {
    const span =
      meta.updatedAt > meta.createdAt
        ? ` → ${formatStamp(meta.updatedAt)}（${formatDuration(meta.updatedAt - meta.createdAt)}）`
        : ''
    lines.push(metaLine('时间', `${formatStamp(meta.createdAt)}${span}`))
  }
  const size = [`${formatNumber(counts.turns)} 轮`, `${formatNumber(counts.steps)} 步`, `${formatNumber(counts.toolCalls)} 次工具调用`]
  if (counts.humanMessages > 0) size.splice(2, 0, `用户 ${formatNumber(counts.humanMessages)} 条`)
  if (counts.assistantMessages > 0) size.splice(3, 0, `助手 ${formatNumber(counts.assistantMessages)} 条`)
  if (counts.images > 0) size.push(`图片 ${formatNumber(counts.images)} 张`)
  if (meta.options.thinking && counts.reasoningBlocks > 0) size.push(`思考 ${formatNumber(counts.reasoningBlocks)} 段`)
  if (counts.injectedMessages > 0) size.push(`注入 ${formatNumber(counts.injectedMessages)} 条`)
  lines.push(metaLine('规模', size.join(' · ')))

  if (meta.options.usage && meta.usage.reportedSteps > 0) {
    const usage = meta.usage
    const parts = [`输入 ${formatNumber(usage.inputTokens)}`, `输出 ${formatNumber(usage.outputTokens)}`]
    if (usage.cacheReadTokens > 0) parts.push(`缓存读 ${formatNumber(usage.cacheReadTokens)}`)
    if (usage.cacheWriteTokens > 0) parts.push(`缓存写 ${formatNumber(usage.cacheWriteTokens)}`)
    if (usage.reasoningTokens > 0) parts.push(`推理 ${formatNumber(usage.reasoningTokens)}`)
    parts.push(`合计 ${formatNumber(usage.totalTokens)}`)
    lines.push(metaLine('用量', parts.join(' · ')))
  }
  if (meta.scope === 'surface') lines.push(metaLine('范围', '仅当前模型上下文'))

  lines.push('', '由 dsh-chat-export 从 DeepSeek Harness 会话导出', THIN_RULE, '')
  return lines
}

/** Indent every line of a block by one or more steps. */
function indentBlock(text, steps = 1) {
  const prefix = INDENT.repeat(steps)
  return String(text ?? '')
    .split('\n')
    .map((line) => (line === '' ? '' : prefix + line))
    .join('\n')
}

/** A `label  first line` line with the rest of the body hanging under it. */
function labelled(label, body) {
  const lines = String(body ?? '').split('\n')
  const pad = ' '.repeat(label.length + 2)
  const head = `${INDENT.repeat(2)}${label}  ${lines[0] ?? ''}`
  const rest = lines.slice(1).map((line) => (line === '' ? '' : `${INDENT.repeat(2)}${pad}${line}`))
  return [head, ...rest].join('\n')
}

/** The tool summary with the code-span markers removed. */
function plainToolSummary(entry) {
  return toolSummary(entry).replace(/`/gu, '')
}

/** One tool entry as an indented block. */
function renderTool(entry) {
  const lines = [`${INDENT}[工具] ${plainToolSummary(entry)}`]
  if (entry.arguments !== '') lines.push(labelled('参数', prettyJson(entry.arguments)))
  if (entry.result !== null) {
    lines.push(labelled('结果', entry.result.text === '' ? '（无文本输出）' : entry.result.text))
    for (const ref of entry.result.images ?? []) lines.push(`${INDENT.repeat(2)}[图片] ${describeAttachmentRef(ref)}`)
  }
  return lines.join('\n')
}

/** The indented blocks of one message's parts. */
function renderParts(parts) {
  const blocks = []
  for (const part of parts) {
    if (part.type === 'text') blocks.push(indentBlock(part.text))
    else if (part.type === 'reasoning') {
      const length = Array.from(part.text).length
      blocks.push(`${INDENT}[思考 ${formatNumber(length)} 字]\n${indentBlock(part.text, 2)}`)
    } else if (part.type === 'image') blocks.push(`${INDENT}[图片] ${describeAttachmentRef(part.ref)}`)
    else if (part.type === 'file') blocks.push(`${INDENT}[文件] ${describeAttachmentRef(part.ref)}`)
  }
  return blocks
}

/** A labelled message heading. */
function messageHeading(bits) {
  return bits.join(' ')
}

/**
 * Render a transcript as plain text.
 *
 * @param transcript - the model returned by `buildTranscript`.
 * @returns the text document, ending in exactly one newline.
 */
export function renderText(transcript) {
  const { meta } = transcript
  const out = renderHeader(transcript)

  const pushMessage = (heading, parts) => {
    out.push(heading)
    const blocks = renderParts(parts)
    if (blocks.length === 0) blocks.push(`${INDENT}（本条没有可显示的内容）`)
    for (const block of blocks) {
      out.push(block, '')
    }
  }

  for (const entry of transcript.entries) {
    if (entry.kind === 'turn') {
      const head = [`回合 ${entry.index ?? '?'}`]
      if (entry.durationMs !== null) head.push('·', formatDuration(entry.durationMs))
      out.push(head.join(' '), '')
      continue
    }

    if (entry.kind === 'note') {
      out.push(`${INDENT}[注意] ${entry.text}`, '')
      continue
    }

    if (entry.kind === 'user') {
      const bits = [entry.human ? '用户' : '注入内容']
      if (meta.options.timestamps && entry.at > 0) bits.push('·', formatClock(entry.at))
      if (!entry.human && entry.origin !== '') bits.push(`· ${entry.origin}`)
      pushMessage(messageHeading(bits), entry.parts)
      continue
    }

    if (entry.kind === 'assistant') {
      const bits = ['助手']
      if (meta.options.timestamps && entry.at > 0) bits.push('·', formatClock(entry.at))
      if (entry.model !== '') bits.push(`· ${entry.model}`)
      if (entry.interrupted) bits.push('· 被打断')
      pushMessage(messageHeading(bits), entry.parts)
      continue
    }

    if (entry.kind === 'tool') {
      if (!meta.options.tools) continue
      out.push(renderTool(entry), '')
      continue
    }

    if (entry.kind === 'system') {
      out.push(`${INDENT}[系统提示] 回合 ${entry.turn ?? '?'}`, indentBlock(entry.text, 2), '')
    }
  }

  return `${out.join('\n').replace(/\n{4,}/gu, '\n\n\n').trimEnd()}\n`
}
