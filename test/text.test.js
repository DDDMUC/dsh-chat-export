import { describe, expect, it } from 'vitest'
import { buildTranscript } from '../src/transcript.js'
import { defaultOptions } from '../src/options.js'
import { renderText } from '../src/text.js'
import {
  assistantMessage,
  header,
  image,
  injectedMessage,
  reasoning,
  resetClock,
  sampleSession,
  text,
  toolCallEvent,
  toolResultEvent,
  turnEnd,
  turnStart,
  userMessage,
} from './fixtures/build.js'

/** Render text for the given events. */
function render(events, overrides = {}) {
  const transcript = buildTranscript(header(), events, { ...defaultOptions(), ...overrides })
  return renderText(transcript)
}

describe('renderText', () => {
  it('carries no backtick code spans of its own', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c1', 'bash', '{"command":"ls"}'), toolResultEvent(2, 'c1', 'ok')]
    expect(render(events)).not.toContain('`')
  })

  it('is plain text: no Markdown markers of the transcript skeleton', () => {
    const events = [turnStart(0, 1), userMessage(1, 'm', [text('你好')]), assistantMessage(2, [text('你好呀')])]
    const body = render(events)
    expect(body).not.toContain('###')
    expect(body).not.toContain('**')
    expect(body).not.toContain('<details>')
    expect(body).not.toContain('```')
  })

  it('opens with the title under a rule', () => {
    const body = render([turnStart(0, 1), userMessage(1, 'm', [text('hi')])])
    expect(body).toMatch(/^hi\n={72}\n/u)
    expect(body).toMatch(/\n={72}\n/u)
    expect(body).toMatch(/\n-{72}\n/u)
  })

  it('carries the identity and fact lines', () => {
    const body = render([], {})
    expect(body).toContain('session-11111111-2222-3333-4444-555555555555')
    expect(body).toContain('/tmp/example')
    expect(body).toContain('时间')
    expect(body).toContain('规模')
  })

  it('drops zero-valued usage fields', () => {
    const events = [
      turnStart(0, 1),
      assistantMessage(1, [text('a')], { usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } }),
    ]
    const body = render(events, { usage: true })
    const line = body.split('\n').find((row) => row.startsWith('用量'))
    expect(line).toContain('输入 10')
    expect(line).not.toContain('缓存读')
    expect(line).not.toContain('缓存写')
  })

  it('labels turns, users, and assistants without any icon', () => {
    const events = [
      turnStart(0, 1),
      userMessage(1, 'a', [text('问题')]),
      assistantMessage(2, [text('回答')]),
      turnEnd(3, 1),
    ]
    const body = render(events)
    expect(body).toContain('回合 1')
    expect(body).toContain('用户 ·')
    expect(body).toContain('助手 ·')
    expect(body).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/u)
  })

  it('indents message bodies under their heading', () => {
    const body = render([turnStart(0, 1), userMessage(1, 'm', [text('第一行\n第二行')])])
    expect(body).toContain('用户 ·')
    expect(body).toContain('  第一行\n  第二行')
  })

  it('renders a tool call as one indented block with labelled arguments and result', () => {
    const events = [
      turnStart(0, 1),
      toolCallEvent(1, 'c1', 'bash', '{"command":"ls"}'),
      toolResultEvent(2, 'c1', 'file.txt'),
    ]
    const body = render(events)
    expect(body).toContain('[工具] bash')
    expect(body).toContain('参数  {')
    expect(body).toContain('"command": "ls"')
    expect(body).toContain('结果  file.txt')
  })

  it('marks a failed tool call in words, not with a symbol', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c1', 'bash'), toolResultEvent(2, 'c1', 'boom', { isError: true })]
    expect(render(events)).toContain('bash · 出错')
  })

  it('describes an image rather than inlining it', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [image('sha256:aa', { name: 'shot.png' })])]
    const body = render(events)
    expect(body).toContain('[图片] shot.png（640×480, 2.0 KiB）')
    expect(body).not.toContain('data:image')
  })

  it('keeps reasoning behind a labelled marker', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [reasoning('内心戏'), text('结论')])]
    const body = render(events, { thinking: true })
    expect(body).toContain('[思考 3 字]')
    expect(body).toContain('    内心戏')
    expect(render(events, { thinking: false })).not.toContain('内心戏')
  })

  it('notes an abnormal turn end', () => {
    expect(render([turnStart(0, 1), turnEnd(1, 1, 'interrupted')])).toContain('[注意] 回合 1 结束：interrupted')
  })

  it('omits tool blocks when the option is off', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c1', 'bash'), toolResultEvent(2, 'c1', 'out')]
    const body = render(events, { tools: false })
    expect(body).not.toContain('[工具]')
    expect(body).not.toContain('out')
  })

  it('reproduces message bodies verbatim, Markdown markers included', () => {
    // The conversation is quoted, not edited: a transcript that silently
    // rewrites what was said is worse than one with a few asterisks in it.
    const body = render([turnStart(0, 1), userMessage(1, 'm', [text('# 标题\n\n**加粗** 和 `代码`')])])
    expect(body).toContain('  # 标题')
    expect(body).toContain('  **加粗** 和 `代码`')
  })

  it('ends in exactly one newline and never leaves a run of blanks', () => {
    const { header: sessionHeader, events } = sampleSession()
    const transcript = buildTranscript(sessionHeader, events, { ...defaultOptions(), thinking: true, injected: true, system: true })
    const body = renderText(transcript)
    expect(body.endsWith('\n')).toBe(true)
    expect(body.endsWith('\n\n')).toBe(false)
    expect(body).not.toMatch(/\n{4,}/u)
  })

  it('renders the whole sample session without losing a message', () => {
    const { header: sessionHeader, events } = sampleSession()
    const transcript = buildTranscript(sessionHeader, events, { ...defaultOptions(), thinking: true, injected: true, system: true })
    const body = renderText(transcript)
    expect(body).toContain('只有 spliced 里有这条')
    expect(body).toContain('帮我改一下这个函数')
    expect(body).toContain('[图片] shot.png')
    expect(body).toContain('[工具] read_file')
    expect(body).toContain('改好了。')
  })

  it('produces only a header for an empty session', () => {
    const body = renderText(buildTranscript(undefined, [], defaultOptions()))
    expect(body).toContain('会话记录')
    expect(body).toContain('规模')
  })
})
