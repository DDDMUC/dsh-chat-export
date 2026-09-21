import { describe, expect, it } from 'vitest'
import { buildTranscript } from '../src/transcript.js'
import { defaultOptions } from '../src/options.js'
import {
  escapeTableCell,
  fence,
  formatBytes,
  formatDuration,
  formatNumber,
  formatStamp,
  normalizeMessageBody,
  prettyJson,
  renderMarkdown,
} from '../src/markdown.js'
import {
  assistantMessage,
  header,
  image,
  injectedMessage,
  reasoning,
  resetClock,
  sampleSession,
  text,
  toolCall,
  toolCallEvent,
  toolResultEvent,
  turnEnd,
  turnStart,
  userMessage,
} from './fixtures/build.js'

/** Render a transcript built from the given events. */
function render(events, overrides = {}, context = {}) {
  const transcript = buildTranscript(header(), events, { ...defaultOptions(), ...overrides })
  return { transcript, markdown: renderMarkdown(transcript, context) }
}

describe('fence', () => {
  it('uses three backticks for ordinary content', () => {
    expect(fence('hello')).toBe('```\nhello\n```')
  })

  it('grows the fence past the longest run inside the body', () => {
    const body = '```\ninner\n```'
    const rendered = fence(body)
    expect(rendered.startsWith('````')).toBe(true)
    expect(rendered.endsWith('````')).toBe(true)
    expect(rendered).toContain(body)
  })

  it('labels the language', () => {
    expect(fence('x', 'json')).toBe('```json\nx\n```')
  })
})

describe('formatting helpers', () => {
  it('escapes pipes and newlines in a table cell', () => {
    expect(escapeTableCell('a|b\nc')).toBe('a\\|b<br>c')
  })

  it('formats durations across magnitudes', () => {
    expect(formatDuration(250)).toBe('250ms')
    expect(formatDuration(1500)).toBe('1.5s')
    expect(formatDuration(65_000)).toBe('1m 05s')
    expect(formatDuration(3_900_000)).toBe('1h 05m')
    expect(formatDuration(-1)).toBe('')
    expect(formatDuration(null)).toBe('')
  })

  it('never prints a rounded-up 60 in the smaller unit', () => {
    // 2519.6s used to render as "41m 60s": the remainder was rounded after the
    // split instead of before it.
    expect(formatDuration(2_519_600)).toBe('42m 00s')
    expect(formatDuration(3_599_600)).toBe('1h 00m')
    expect(formatDuration(3_599_000)).toBe('59m 59s')
    expect(formatDuration(59_600)).toBe('1m 00s')
  })

  it('groups digits', () => {
    expect(formatNumber(1234567)).toBe('1,234,567')
    expect(formatNumber(undefined)).toBe('0')
  })

  it('formats byte sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KiB')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MiB')
  })

  it('formats a stamp and a missing one distinctly', () => {
    expect(formatStamp(0)).toBe('--:--:--')
    expect(formatStamp(new Date(2026, 8, 21, 9, 5, 3).getTime())).toBe('2026-09-21 09:05:03')
  })

  it('pretty-prints JSON and passes malformed text through', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('not json')).toBe('not json')
  })
})

describe('renderMarkdown', () => {
  it('starts with the title and the export banner', () => {
    const { markdown } = render([turnStart(0, 1), userMessage(1, 'm', [text('hi')])], {}, {})
    expect(markdown.startsWith('# hi\n')).toBe(true)
    expect(markdown).toContain('dsh-chat-export')
  })

  it('falls back to a generic title for an untitled, empty session', () => {
    const { markdown } = render([])
    expect(markdown).toContain('# 会话记录')
  })

  it('includes a metadata table with session facts', () => {
    const { markdown } = render([], { usage: true })
    expect(markdown).toContain('| 会话 ID |')
    expect(markdown).toContain('| 工作目录 |')
    expect(markdown).toContain('| 规模 |')
  })

  it('numbers turns and keeps messages under them', () => {
    const { markdown } = render([
      turnStart(0, 1),
      userMessage(1, 'a', [text('第一个问题')]),
      assistantMessage(2, [text('第一个回答')]),
      turnEnd(3, 1),
      turnStart(4, 2),
      userMessage(5, 'b', [text('第二个问题')]),
    ])
    expect(markdown).toContain('## 回合 1')
    expect(markdown).toContain('## 回合 2')
    expect(markdown.indexOf('第一个问题')).toBeLessThan(markdown.indexOf('第一个回答'))
    expect(markdown.indexOf('第一个回答')).toBeLessThan(markdown.indexOf('第二个问题'))
  })

  it('shows a clock on every message when timestamps are on and none when off', () => {
    const events = [turnStart(0, 1), userMessage(1, 'm', [text('hi')]), assistantMessage(2, [text('yo')])]
    const on = render(events, { timestamps: true }).markdown
    const off = render(events, { timestamps: false }).markdown
    expect(on).toMatch(/### 🧑 用户 · \d{2}:\d{2}:\d{2}/u)
    expect(on).toMatch(/### 🤖 助手 · \d{2}:\d{2}:\d{2}/u)
    expect(off).not.toMatch(/### 🧑 用户 · \d/u)
  })

  it('folds reasoning into a details block only when enabled', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [reasoning('内心戏'), text('结论')])]
    expect(render(events, { thinking: false }).markdown).not.toContain('内心戏')
    const on = render(events, { thinking: true }).markdown
    expect(on).toContain('<details>')
    expect(on).toContain('内心戏')
    expect(on).toContain('💭 思考')
  })

  it('renders a tool call with pretty arguments and a folded result', () => {
    const events = [
      turnStart(0, 1),
      toolCallEvent(1, 'c1', 'read_file', '{"path":"a.js"}'),
      toolResultEvent(2, 'c1', 'line one\nline two'),
    ]
    const { markdown } = render(events, {})
    expect(markdown).toContain('🔧 工具调用 `read_file`')
    expect(markdown).toContain('```json')
    expect(markdown).toContain('"path": "a.js"')
    expect(markdown).toContain('📄 结果')
    expect(markdown).toContain('line one')
  })

  it('labels a failed tool result and its truncated size', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c1', 'bash'), toolResultEvent(2, 'c1', 'x'.repeat(9000), { isError: true })]
    const { markdown } = render(events, { toolResultLimit: 100 })
    expect(markdown).toContain('❌ 结果（出错')
    expect(markdown).toContain('已截断，共 9,000 字')
  })

  it('omits tool blocks when the option is off', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c1', 'bash'), toolResultEvent(2, 'c1', 'out')]
    const { markdown } = render(events, { tools: false })
    expect(markdown).not.toContain('🔧 工具调用')
    expect(markdown).not.toContain('out')
  })

  it('embeds an image as Markdown when a source is available', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [image('sha256:aa', { name: 'shot.png' })])]
    const { markdown } = render(events, {}, { imageSrc: () => 'data:image/png;base64,AAAA' })
    expect(markdown).toContain('![shot.png](data:image/png;base64,AAAA)')
    expect(markdown).toContain('640×480')
  })

  it('describes an image when no source is available', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [image('sha256:aa', { name: 'shot.png' })])]
    const { markdown } = render(events, {}, {})
    expect(markdown).toContain('🖼 图片：shot.png')
    expect(markdown).not.toContain('![')
  })

  it('never lets a body break out of its fence', () => {
    const hostile = '```\n}; rm -rf /\n```'
    const events = [turnStart(0, 1), toolCallEvent(1, 'c1', 'bash'), toolResultEvent(2, 'c1', hostile)]
    const { markdown } = render(events, {})
    const body = markdown.slice(markdown.indexOf('````'))
    expect(body.startsWith('````')).toBe(true)
  })

  it('marks injected messages and their producer', () => {
    const events = [turnStart(0, 1), injectedMessage(1, 'i', [text('reminder')], { kind: 'plugin', plugin: 'free-search' })]
    const { markdown } = render(events, { injected: true })
    expect(markdown).toContain('📥 注入内容')
    expect(markdown).toContain('plugin:free-search')
  })

  it('renders system prompts only when enabled', () => {
    const events = [
      turnStart(0, 1),
      { type: 'system/message', seq: 1, time: Date.now(), data: { turn: 1, step: 1, message: { content: [text('系统提示正文')] } }, surfaceOp: 'append' },
    ]
    expect(render(events, { system: false }).markdown).not.toContain('系统提示正文')
    expect(render(events, { system: true }).markdown).toContain('系统提示正文')
  })

  it('renders a note for an abnormal turn end', () => {
    const { markdown } = render([turnStart(0, 1), turnEnd(1, 1, 'interrupted')])
    expect(markdown).toContain('⚠️')
    expect(markdown).toContain('interrupted')
  })

  it('notes the scope when only the current surface was exported', () => {
    const { markdown } = render([turnStart(0, 1), userMessage(1, 'm', [text('hi')])], { scope: 'surface' })
    expect(markdown).toContain('仅当前模型上下文')
  })

  it('renders the whole sample session coherently', () => {
    const { header: sessionHeader, events } = sampleSession()
    const transcript = buildTranscript(sessionHeader, events, {
      ...defaultOptions(),
      thinking: true,
      injected: true,
      system: true,
    })
    const markdown = renderMarkdown(transcript, { imageSrc: () => 'assets/001-shot.png' })
    expect(markdown).toContain('# 示例会话')
    expect(markdown).toContain('## 回合 3')
    expect(markdown).toContain('🤖 助手')
    expect(markdown).toContain('assets/001-shot.png')
    expect(markdown).toContain('只有 spliced 里有这条')
    expect(markdown.endsWith('\n')).toBe(true)
    // No run of four or more newlines anywhere: Markdown renders those as
    // stray blank space and they usually mean a joining bug.
    expect(markdown).not.toMatch(/\n{4,}/u)
  })
})

describe('normalizeMessageBody', () => {
  it('demotes headings below the message level', () => {
    expect(normalizeMessageBody('# 任务')).toBe('#### 任务')
    expect(normalizeMessageBody('## 背景')).toBe('##### 背景')
    expect(normalizeMessageBody('### 细节')).toBe('###### 细节')
    expect(normalizeMessageBody('###### 已是最深')).toBe('###### 已是最深')
  })

  it('leaves prose and lists alone', () => {
    const body = '普通文字\n\n- 项目一\n- 项目二\n\n> 引用'
    expect(normalizeMessageBody(body)).toBe(body)
  })

  it('does not touch a heading-looking line inside a fence', () => {
    const body = '```\n# 这是代码里的井号\n```'
    expect(normalizeMessageBody(body)).toBe(body)
  })

  it('does not touch HTML-looking lines inside a fence', () => {
    const body = '```html\n<details><summary>x</summary></details>\n```'
    expect(normalizeMessageBody(body)).toBe(body)
  })

  it('escapes block-level HTML in prose so it cannot open a disclosure', () => {
    expect(normalizeMessageBody('<details>\n<summary>偷来的折叠</summary>\n</details>')).toBe(
      '\\<details>\n\\<summary>偷来的折叠\\</summary>\n\\</details>',
    )
  })

  it('escapes only details and summary, not other tags', () => {
    expect(normalizeMessageBody('<system-reminder>x</system-reminder>')).toBe('<system-reminder>x</system-reminder>')
    expect(normalizeMessageBody('<div>ok</div>')).toBe('<div>ok</div>')
  })

  it('handles an empty body and a missing one', () => {
    expect(normalizeMessageBody('')).toBe('')
    expect(normalizeMessageBody(undefined)).toBe('')
  })
})
