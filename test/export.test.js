import { describe, expect, it } from 'vitest'
import { produceExport } from '../src/export.js'
import { defaultOptions } from '../src/options.js'

/** A header shaped like the ones the store serves. */
function sessionHeader(id, extra = {}) {
  return { type: 'session', version: '4', id, createdAt: '1000', cwd: '/tmp', isSeeded: 'true', ...extra }
}

/** One turn: a user message and the model's answer. */
function turnEvents(label) {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 1,
      time: 1001,
      data: { content: [{ type: 'text', text: label }], source: { kind: 'user' }, role: 'user', id: `u-${label}` },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: 2,
      time: 1002,
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `${label}的回答` }],
          source: { kind: 'model', provider: 'p', model: 'm' },
          id: `a-${label}`,
        },
        stream: [],
      },
      surfaceOp: 'append',
    },
    { type: 'turn/end', seq: 3, time: 1003, data: { turn: 1, reason: { kind: 'completed' } } },
  ]
}

/** One export of the parent, optionally carrying a subagent. */
async function exportWith(format, subagents) {
  return produceExport({
    header: sessionHeader('session-root'),
    events: turnEvents('主会话'),
    title: '主会话',
    subagents,
    options: { ...defaultOptions(), format, thinking: true },
  })
}

const child = {
  header: sessionHeader('session-child', { parentSession: 'session-root', origin: 'subagent' }),
  events: turnEvents('子任务'),
  title: '子任务',
  depth: 1,
}

describe('subagents in an export', () => {
  it('appends a Markdown appendix naming each child', async () => {
    const artifact = await exportWith('md', [child])
    const markdown = artifact.buffer.toString('utf8')
    expect(markdown).toContain('# 子会话（1）')
    expect(markdown).toContain('## 子任务')
    expect(markdown).toContain('session-child')
    expect(markdown).toContain('子任务的回答')
  })

  it('demotes the child headings so the parent keeps the only top level', async () => {
    const artifact = await exportWith('md', [child])
    const markdown = artifact.buffer.toString('utf8')
    // The child's own title was an H1; inside the appendix it is an H2.
    const appendix = markdown.slice(markdown.indexOf('# 子会话'))
    expect(appendix).not.toMatch(/^# 子任务$/mu)
  })

  it('indents a grandchild', async () => {
    const grandchild = {
      header: sessionHeader('session-grand', { parentSession: 'session-child', origin: 'subagent' }),
      events: turnEvents('孙任务'),
      title: '孙任务',
      depth: 2,
    }
    const markdown = (await exportWith('md', [child, grandchild])).buffer.toString('utf8')
    expect(markdown).toContain('## ↳ 孙任务')
  })

  it('adds a section to the HTML', async () => {
    const html = (await exportWith('html', [child])).buffer.toString('utf8')
    expect(html).toContain('<section class="subagent">')
    expect(html).toContain('子任务的回答')
    // The child must not bring its own document wrapper along.
    expect(html.match(/<!doctype html>/gu)).toHaveLength(1)
  })

  it('leaves the export untouched when there are no children', async () => {
    const markdown = (await exportWith('md', [])).buffer.toString('utf8')
    expect(markdown).not.toContain('子会话')
    const html = (await exportWith('html', [])).buffer.toString('utf8')
    expect(html).not.toContain('class="subagent"')
  })
})
