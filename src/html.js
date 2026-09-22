// dsh-chat-export - transcript model to one self-contained HTML document.
//
// The output is a single file with inline CSS and no external requests, so it
// can be opened from disk, mailed around, or printed straight to PDF. A light
// Markdown subset is rendered here (fences, headings, lists, tables, quotes,
// inline code, bold, italic, links) because conversation text is Markdown and
// a wall of pre-wrapped plain text is exactly what makes an export unreadable.
//
// Every piece of conversation text goes through `escapeHtml` before any markup
// is added, so a session that contains HTML cannot inject it into the export.

/** Escape the five characters that matter in HTML text and attributes. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&#39;')
}

/** Inline spans inside one line of prose. */
function renderInline(text) {
  let out = escapeHtml(text)
  out = out.replace(/`([^`]+)`/gu, (_match, code) => `<code>${code}</code>`)
  out = out.replace(/\*\*([^*]+)\*\*/gu, '<strong>$1</strong>')
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*/gu, '$1<em>$2</em>')
  out = out.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/gu,
    (_match, label, href) => `<a href="${href}" rel="noreferrer noopener" target="_blank">${label}</a>`,
  )
  out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/gu, '$1<a href="$2" rel="noreferrer noopener" target="_blank">$2</a>')
  return out
}

/** One fenced code block. */
function renderFence(body, language) {
  const cls = language === '' ? 'code' : `code language-${escapeHtml(language)}`
  return `<pre class="${cls}"><code>${escapeHtml(body)}</code></pre>`
}

/** A pipe table, when the block looks like one. */
function renderTable(lines) {
  const rows = lines.map((line) =>
    line
      .replace(/^\s*\|/u, '')
      .replace(/\|\s*$/u, '')
      .split('|')
      .map((cell) => cell.trim()),
  )
  const aligns = rows[1].map((cell) => (/^:?-{2,}:?$/u.test(cell) ? 'ok' : null))
  if (aligns.some((value) => value === null)) return null
  const head = rows[0]
  const body = rows.slice(2)
  const parts = ['<table><thead><tr>']
  for (const cell of head) parts.push(`<th>${renderInline(cell)}</th>`)
  parts.push('</tr></thead><tbody>')
  for (const row of body) {
    parts.push('<tr>')
    for (let index = 0; index < head.length; index += 1) parts.push(`<td>${renderInline(row[index] ?? '')}</td>`)
    parts.push('</tr>')
  }
  parts.push('</tbody></table>')
  return parts.join('')
}

/**
 * Render a Markdown subset to HTML.
 * @param text - conversation text.
 * @returns safe HTML.
 */
export function renderMarkdownBody(text) {
  const lines = String(text ?? '').split('\n')
  const out = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]

    const fenceMatch = /^\s*(`{3,}|~{3,})\s*([\w+-]*)\s*$/u.exec(line)
    if (fenceMatch !== null) {
      const marker = fenceMatch[1][0].repeat(fenceMatch[1].length)
      const body = []
      index += 1
      while (index < lines.length && !lines[index].trimStart().startsWith(marker)) {
        body.push(lines[index])
        index += 1
      }
      index += 1
      out.push(renderFence(body.join('\n'), fenceMatch[2]))
      continue
    }

    if (line.trim() === '') {
      index += 1
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/u.exec(line)
    if (heading !== null) {
      const level = Math.min(6, heading[1].length + 3)
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`)
      index += 1
      continue
    }

    if (/^\s*\|.*\|\s*$/u.test(line) && index + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/u.test(lines[index + 1])) {
      const block = []
      while (index < lines.length && /^\s*\|.*\|\s*$/u.test(lines[index])) {
        block.push(lines[index])
        index += 1
      }
      const table = block.length >= 2 ? renderTable(block) : null
      out.push(table ?? `<p>${block.map((row) => renderInline(row)).join('<br>')}</p>`)
      continue
    }

    if (/^\s*>\s?/u.test(line)) {
      const block = []
      while (index < lines.length && /^\s*>\s?/u.test(lines[index])) {
        block.push(lines[index].replace(/^\s*>\s?/u, ''))
        index += 1
      }
      out.push(`<blockquote>${renderMarkdownBody(block.join('\n'))}</blockquote>`)
      continue
    }

    if (/^\s*([-*+]|\d+[.)])\s+/u.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/u.test(line)
      const items = []
      while (index < lines.length && /^\s*([-*+]|\d+[.)])\s+/u.test(lines[index])) {
        items.push(lines[index].replace(/^\s*([-*+]|\d+[.)])\s+/u, ''))
        index += 1
      }
      const tag = ordered ? 'ol' : 'ul'
      out.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join('')}</${tag}>`)
      continue
    }

    const paragraph = []
    while (
      index < lines.length &&
      lines[index].trim() !== '' &&
      !/^\s*(`{3,}|~{3,})/u.test(lines[index]) &&
      !/^(#{1,6})\s+/u.test(lines[index]) &&
      !/^\s*>\s?/u.test(lines[index]) &&
      !/^\s*([-*+]|\d+[.)])\s+/u.test(lines[index])
    ) {
      paragraph.push(lines[index])
      index += 1
    }
    out.push(`<p>${paragraph.map((row) => renderInline(row)).join('<br>')}</p>`)
  }
  return out.join('\n')
}

/** The document stylesheet: DSH-flavoured tokens with usable fallbacks. */
const STYLE = `
:root{--bg:#ffffff;--fg:#1b1c1e;--dim:#8a8f98;--line:#e6e7ea;--soft:#f6f7f9;--accent:#4d6bfe;--user:#eef2ff;--tool:#fafafa;--warn:#d54941;--mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#17181a;--fg:#e8e9ea;--dim:#8a8f98;--line:#2c2e31;--soft:#1f2124;--user:#1e2333;--tool:#1c1e20}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:15px;line-height:1.7;-webkit-text-size-adjust:100%}
.wrap{max-width:900px;margin:0 auto;padding:40px 24px 80px}
h1{font-size:26px;line-height:1.35;margin:0 0 6px}
h2{font-size:19px;margin:44px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--line)}
h3{font-size:15px;margin:22px 0 8px;color:var(--dim);font-weight:600}
h3 .badge{font-weight:400}
.sub{color:var(--dim);font-size:13px;margin:0 0 22px}
table.meta{width:100%;border-collapse:collapse;font-size:13px;margin:0 0 26px;background:var(--soft);border-radius:10px;overflow:hidden}
table.meta th,table.meta td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line);vertical-align:top}
table.meta th{width:88px;color:var(--dim);font-weight:500;white-space:nowrap}
table.meta tr:last-child th,table.meta tr:last-child td{border-bottom:none}
.msg{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin:12px 0}
.msg.user{background:var(--user);border-color:transparent}
.msg.injected{background:var(--soft);border-style:dashed}
.msg.assistant{background:transparent}
.msg.system{background:var(--soft);font-size:14px}
.msg>:first-child{margin-top:0}.msg>:last-child{margin-bottom:0}
.tool{border:1px solid var(--line);border-radius:10px;margin:10px 0;overflow:hidden;background:var(--tool)}
.tool>summary{cursor:pointer;padding:9px 14px;font-size:13px;font-family:var(--mono);display:flex;gap:8px;align-items:center;list-style:none}
.tool>summary::-webkit-details-marker{display:none}
.tool>summary::before{content:"▸";color:var(--dim);transition:transform .12s}
.tool[open]>summary::before{transform:rotate(90deg)}
.tool.err>summary{color:var(--warn)}
.tool .body{padding:0 14px 12px}
details.think{border-left:3px solid var(--line);margin:10px 0;padding-left:12px}
details.think>summary{cursor:pointer;color:var(--dim);font-size:13px;list-style:none}
details.think>summary::-webkit-details-marker{display:none}
details.think .inner{color:var(--dim);font-size:14px;white-space:pre-wrap;margin-top:8px}
pre.code{background:var(--soft);border:1px solid var(--line);border-radius:8px;padding:12px;overflow:auto;font-family:var(--mono);font-size:12.5px;line-height:1.55;margin:10px 0}
code{font-family:var(--mono);font-size:.92em;background:var(--soft);padding:.12em .38em;border-radius:4px}
pre.code code{background:none;padding:0;font-size:inherit}
blockquote{margin:10px 0;padding:2px 0 2px 14px;border-left:3px solid var(--line);color:var(--dim)}
img{max-width:100%;border-radius:8px;border:1px solid var(--line);display:block;margin:10px 0}
figure{margin:12px 0}figcaption{color:var(--dim);font-size:12px;margin-top:4px}
a{color:var(--accent)}
table:not(.meta){border-collapse:collapse;font-size:13.5px;margin:10px 0;width:100%}
table:not(.meta) th,table:not(.meta) td{border:1px solid var(--line);padding:6px 10px;text-align:left}
table:not(.meta) th{background:var(--soft)}
.note{color:var(--dim);font-size:13px;margin:14px 0;padding-left:12px;border-left:2px solid var(--line)}
.note.warn{color:var(--warn)}
.bar{position:sticky;top:0;z-index:5;display:flex;gap:10px;align-items:center;padding:10px 24px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.bar .grow{flex:1}
.bar button{font:inherit;font-size:13px;padding:5px 14px;border-radius:16px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer}
.bar button:hover{background:var(--soft)}
footer{margin-top:56px;padding-top:16px;border-top:1px solid var(--line);color:var(--dim);font-size:12px}
@media print{@page{margin:14mm}
:root{--bg:#fff;--fg:#000;--soft:#f4f4f4;--line:#ccc;--dim:#555;--user:#f4f4f4}
.bar{display:none}
.wrap{max-width:none;padding:0}
h2{break-before:page;break-after:avoid}
h3{break-after:avoid}
.msg,.tool,pre.code,img,table{break-inside:avoid}
.tool>summary::before,details.think>summary{content:""}
details{display:block}
details:not([open])>*:not(summary){display:block}
a{color:inherit;text-decoration:none}
}
`

/** Render one image part. */
function imageHtml(ref, context) {
  const source = context.imageSrc === undefined ? null : context.imageSrc(ref)
  const name = ref.name === undefined || ref.name === '' ? String(ref.attachmentId ?? '图片') : String(ref.name)
  if (source === null || source === undefined) {
    return `<p class="note">图片：${escapeHtml(name)}（未内嵌）</p>`
  }
  const meta = []
  if (typeof ref.width === 'number' && typeof ref.height === 'number') meta.push(`${ref.width}×${ref.height}`)
  if (typeof ref.bytes === 'number') meta.push(`${Math.round(ref.bytes / 1024)} KiB`)
  return `<figure><img src="${escapeHtml(source)}" alt="${escapeHtml(name)}" loading="lazy">${
    meta.length === 0 ? '' : `<figcaption>${escapeHtml(name)} · ${escapeHtml(meta.join(' · '))}</figcaption>`
  }</figure>`
}

/** Render a message's parts. */
function partsHtml(parts, context, openThinking) {
  const out = []
  for (const part of parts) {
    if (part.type === 'text') out.push(`<div class="md">${renderMarkdownBody(part.text)}</div>`)
    else if (part.type === 'reasoning') {
      const length = Array.from(part.text).length
      out.push(
        `<details class="think"${openThinking ? ' open' : ''}><summary>思考（${length} 字）</summary><div class="inner">${escapeHtml(
          part.text,
        )}</div></details>`,
      )
    } else if (part.type === 'image') out.push(imageHtml(part.ref, context))
    else if (part.type === 'file') {
      const source = context.imageSrc === undefined ? null : context.imageSrc(part.ref)
      const name = String(part.ref.name ?? part.ref.attachmentId ?? '文件')
      out.push(
        source === null || source === undefined
          ? `<p class="note">文件：${escapeHtml(name)}</p>`
          : `<p><a href="${escapeHtml(source)}" download>${escapeHtml(name)}</a></p>`,
      )
    }
  }
  return out.join('\n')
}

/** Render one tool entry. */
function toolHtml(entry, context, openTools) {
  const duration = entry.durationMs === null ? '' : ` · ${Math.max(0, entry.durationMs)}ms`
  const failed = entry.result !== null && entry.result.isError
  const out = [`<details class="tool${failed ? ' err' : ''}"${openTools ? ' open' : ''}>`]
  const tail =
    entry.result === null
      ? ''
      : entry.result.truncated
        ? ` · 结果已截断（共 ${entry.result.totalChars.toLocaleString('en-US')} 字）`
        : ` · 结果 ${entry.result.totalLines.toLocaleString('en-US')} 行`
  out.push(`<summary><code>${escapeHtml(entry.name)}</code>${failed ? ' · 出错' : ''}${escapeHtml(duration)}${escapeHtml(tail)}</summary><div class="body">`)
  if (entry.arguments !== '') {
    out.push(`<div class="md">${renderMarkdownBody('```json\n' + prettyJson(entry.arguments) + '\n```')}</div>`)
  }
  if (entry.result !== null) {
    out.push(`<div class="md">${renderMarkdownBody('```text\n' + entry.result.text + '\n```')}</div>`)
    for (const ref of entry.result.images ?? []) out.push(imageHtml(ref, context))
  }
  out.push('</div></details>')
  return out.join('')
}

/** Imported lazily to keep this module's public surface about HTML. */
function prettyJson(text) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

/** Format a stamp for display. */
function stamp(epochMs) {
  if (typeof epochMs !== 'number' || epochMs <= 0) return ''
  const date = new Date(epochMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(
    date.getSeconds(),
  )}`
}

/** The metadata table. */
function metaHtml(transcript) {
  const { meta } = transcript
  const rows = []
  if (meta.sessionId !== '') rows.push(['会话 ID', `<code>${escapeHtml(meta.sessionId)}</code>`])
  if (meta.cwd !== '') rows.push(['工作目录', `<code>${escapeHtml(meta.cwd)}</code>`])
  if (meta.models.length > 0) rows.push(['模型', meta.models.map((model) => `<code>${escapeHtml(model)}</code>`).join(' · ')])
  if (meta.createdAt > 0) {
    const span = meta.updatedAt > meta.createdAt ? ` → ${stamp(meta.updatedAt)}` : ''
    rows.push(['时间', `${stamp(meta.createdAt)}${span}`])
  }
  const counts = meta.counts
  rows.push([
    '规模',
    `${counts.turns} 轮 · ${counts.steps} 步 · 用户 ${counts.humanMessages} 条 · 助手 ${counts.assistantMessages} 条 · 工具调用 ${counts.toolCalls} 次`,
  ])
  if (meta.options.usage && meta.usage.reportedSteps > 0) {
    const usage = meta.usage
    rows.push([
      '用量',
      `输入 ${usage.inputTokens.toLocaleString('en-US')} · 输出 ${usage.outputTokens.toLocaleString('en-US')} · 缓存读 ${usage.cacheReadTokens.toLocaleString(
        'en-US',
      )} · 缓存写 ${usage.cacheWriteTokens.toLocaleString('en-US')} · 推理 ${usage.reasoningTokens.toLocaleString('en-US')} · 合计 ${usage.totalTokens.toLocaleString(
        'en-US',
      )}`,
    ])
  }
  if (meta.scope === 'surface') rows.push(['范围', '仅当前模型上下文'])
  return `<table class="meta">${rows.map(([key, value]) => `<tr><th>${key}</th><td>${value}</td></tr>`).join('')}</table>`
}

/**
 * Render a transcript as one self-contained HTML document.
 *
 * @param transcript - the model returned by `buildTranscript`.
 * @param context - `{ imageSrc?, openThinking?, openTools?, title? }`.
 * @returns the complete HTML document.
 */
export function renderHtml(transcript, context = {}) {
  const { meta } = transcript
  const title = context.title ?? (meta.title === '' ? '会话记录' : meta.title)
  const parts = []
  parts.push('<!doctype html>')
  parts.push('<html lang="zh-CN"><head><meta charset="utf-8">')
  parts.push('<meta name="viewport" content="width=device-width,initial-scale=1">')
  parts.push(`<title>${escapeHtml(title)}</title>`)
  parts.push(`<style>${STYLE}</style>`)
  parts.push('</head><body>')
  parts.push('<div class="bar"><strong style="font-size:13px">会话文字稿</strong><span class="grow"></span>')
  parts.push('<button type="button" onclick="for(const d of document.querySelectorAll(\'details\'))d.open=true">展开全部</button>')
  parts.push('<button type="button" onclick="for(const d of document.querySelectorAll(\'details\'))d.open=false">折叠全部</button>')
  parts.push('<button type="button" onclick="window.print()">打印 / 另存为 PDF</button>')
  parts.push('</div>')
  parts.push('<div class="wrap">')
  parts.push(`<h1>${escapeHtml(title)}</h1>`)
  parts.push(`<p class="sub">由 dsh-chat-export 从 DeepSeek Harness 会话导出</p>`)
  parts.push(metaHtml(transcript))

  let openTurn = false
  for (const entry of transcript.entries) {
    if (entry.kind === 'turn') {
      if (openTurn) parts.push('</section>')
      parts.push(`<section class="turn"><h2>回合 ${entry.index ?? '?'}</h2>`)
      openTurn = true
      continue
    }
    if (entry.kind === 'note') {
      parts.push(`<p class="note${entry.level === 'warn' ? ' warn' : ''}">${escapeHtml(entry.text)}</p>`)
      continue
    }
    if (entry.kind === 'user') {
      const label = entry.human ? '用户' : `注入内容${entry.origin === '' ? '' : ` · ${entry.origin}`}`
      const when = meta.options.timestamps ? ` · ${stamp(entry.at)}` : ''
      parts.push(`<h3>${escapeHtml(label)}${when}</h3>`)
      parts.push(`<div class="msg ${entry.human ? 'user' : 'injected'}">${partsHtml(entry.parts, context, context.openThinking === true)}</div>`)
      continue
    }
    if (entry.kind === 'assistant') {
      const bits = ['助手']
      if (meta.options.timestamps) bits.push(stamp(entry.at))
      if (entry.model !== '') bits.push(entry.model)
      if (entry.interrupted) bits.push('被打断')
      parts.push(`<h3>${escapeHtml(bits.join(' · '))}</h3>`)
      parts.push(`<div class="msg assistant">${partsHtml(entry.parts, context, context.openThinking === true)}</div>`)
      continue
    }
    if (entry.kind === 'tool') {
      if (!meta.options.tools) continue
      parts.push(toolHtml(entry, context, context.openTools === true))
      continue
    }
    if (entry.kind === 'system') {
      parts.push(`<div class="msg system"><h3>系统提示（回合 ${entry.turn ?? '?'}）</h3><div class="md">${renderMarkdownBody(entry.text)}</div></div>`)
    }
  }
  if (openTurn) parts.push('</section>')

  parts.push('<footer>由 dsh-chat-export 生成 · 内容来自本机会话日志，未经模型改写</footer>')
  parts.push('</div></body></html>')
  return parts.join('\n')
}
