import { describe, expect, it } from 'vitest'
import { buildLogArtifact, parseLogArtifact } from '../src/log.js'
import { runImport } from '../src/index.js'
import {
  DROPPED_TYPES,
  ImportError,
  createImportedSession,
  eventsFromMarkdown,
  newSessionId,
  planImport,
} from '../src/import.js'

const header = {
  type: 'session',
  version: '4',
  id: 'session-11111111-2222-3333-4444-555555555555',
  createdAt: '1791617627977',
  cwd: '/Users/someone/project',
  parentSession: 'session-99999999-9999-9999-9999-999999999999',
  origin: 'subagent',
  delegationDepth: '1',
  agentPreset: 'ptc',
  isSeeded: 'false',
}

const events = [
  { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } },
  { type: 'subagent/descriptor', seq: 1, time: 101, data: { depth: 1 } },
  { type: 'step/start', seq: 2, time: 102, data: { turn: 1, step: 1 } },
  { type: 'user/message', seq: 3, time: 103, data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
  { type: 'session/title', seq: 4, time: 104, data: { title: '示例', messageSeqs: [3], source: { kind: 'fallback' } } },
  { type: 'compaction/start', seq: 5, time: 105, data: { compactionId: 'c1', turn: 1 } },
  { type: 'step/end', seq: 6, time: 106, data: { turn: 1, step: 1 } },
  { type: 'turn/end', seq: 7, time: 107, data: { turn: 1, reason: { kind: 'completed' } } },
]

function parsedOf(rows, head = header) {
  return parseLogArtifact(buildLogArtifact({ header: head, events: rows, title: '示例' }))
}

describe('newSessionId', () => {
  it('uses the session- prefix the store expects', () => {
    expect(newSessionId()).toMatch(/^session-[0-9a-f-]{36}$/u)
  })
})

describe('planImport', () => {
  it('renumbers surviving events contiguously from zero', () => {
    const plan = planImport(parsedOf(events), { id: 'session-new', cwd: '/tmp', now: 1000 })
    expect(plan.events.map((event) => event.seq)).toEqual(plan.events.map((_, index) => index))
    expect(plan.events).toHaveLength(events.length - 2)
  })

  it('drops machine-local and live-process records', () => {
    const plan = planImport(parsedOf(events), { id: 'session-new', cwd: '/tmp', now: 1000 })
    const types = plan.events.map((event) => event.type)
    expect(types).not.toContain('subagent/descriptor')
    expect(types).not.toContain('compaction/start')
    expect(plan.dropped).toEqual(['subagent/descriptor', 'compaction/start'])
    expect(plan.warnings.join(' ')).toContain('已跳过机器相关记录')
  })

  it('rewrites seq references inside the surviving payloads', () => {
    const plan = planImport(parsedOf(events), { id: 'session-new', cwd: '/tmp', now: 1000 })
    const title = plan.events.find((event) => event.type === 'session/title')
    expect(title.data.messageSeqs).toEqual([2])
    expect(plan.events[2].type).toBe('user/message')
  })

  it('builds a header that does not claim a parent, an origin, or a preset', () => {
    const plan = planImport(parsedOf(events), { id: 'session-new', cwd: '/tmp/here', now: 1000 })
    expect(plan.header).toEqual({
      version: 4,
      id: 'session-new',
      createdAt: 1000,
      cwd: '/tmp/here',
      isSeeded: false,
    })
  })

  it('keeps the original title when the caller does not supply one', () => {
    const plan = planImport(parsedOf(events), { id: 'session-new', now: 1000 })
    expect(plan.title).toBe('示例')
  })

  it('refuses a relative working directory', () => {
    expect(() => planImport(parsedOf(events), { id: 'session-new', cwd: 'relative/dir' })).toThrow(ImportError)
  })

  it('refuses a log whose events are all machine-local', () => {
    const only = [{ type: 'subagent/descriptor', seq: 0, time: 1, data: {} }]
    expect(() => planImport(parsedOf(only), { id: 'session-new' })).toThrow(ImportError)
  })
})

const markdown = `# 一次对话

> 由 [dsh-chat-export](https://github.com/DDDMUC/dsh-chat-export) 从 DeepSeek Harness 会话导出

| 模型 | \`x\` |

---

## 回合 1 · 1.2s

### 用户

你好

### 助手 · \`x\`

你好，我是助手。

#### 这是内容里的四级标题

它应该留在正文里。

## 回合 2

### 用户

再来一句

### 助手

好的
`

describe('eventsFromMarkdown', () => {
  it('turns each turn into a start/step/end chain', () => {
    const built = eventsFromMarkdown(markdown, { now: 1000 })
    expect(built.turns).toBe(2)
    expect(built.messages).toBe(4)
    expect(built.title).toBe('一次对话')
    const types = built.events.map((event) => event.type)
    expect(types.filter((type) => type === 'turn/start')).toHaveLength(2)
    expect(types.filter((type) => type === 'turn/end')).toHaveLength(2)
    expect(types.filter((type) => type === 'user/message')).toHaveLength(2)
    expect(types.filter((type) => type === 'assistant/message')).toHaveLength(2)
    expect(built.events.at(-1).type).toBe('session/title')
  })

  it('keeps a demoted content heading inside the message body', () => {
    const built = eventsFromMarkdown(markdown, { now: 1000 })
    const first = built.events.find((event) => event.type === 'assistant/message')
    expect(first.data.message.content[0].text).toContain('#### 这是内容里的四级标题')
    expect(first.data.message.content[0].text).toContain('它应该留在正文里。')
  })

  it('numbers steps inside a turn and carries them on both message kinds', () => {
    const built = eventsFromMarkdown(markdown, { now: 1000 })
    const assistant = built.events.filter((event) => event.type === 'assistant/message')
    expect(assistant.map((event) => [event.data.turn, event.data.step])).toEqual([[1, 1], [2, 1]])
  })

  it('refuses a document with no recognizable messages', () => {
    expect(() => eventsFromMarkdown('# 只有标题\n\n没有消息。', { now: 1000 })).toThrow(ImportError)
  })
})

function fakeCtx() {
  const calls = []
  const session = {
    header: { version: 4, id: 'session-new', createdAt: 1, isSeeded: false },
    snapshotEvents: () => [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
  }
  return {
    calls,
    get(name) {
      if (name === 'sessions') {
        return {
          create: (id, options) => {
            calls.push(['sessions.create', id, options.seed.length])
            return session
          },
        }
      }
      if (name === 'sessionPersistence') {
        return {
          create: async (sessionHeader) => {
            calls.push(['persistence.create', sessionHeader.id])
            return {
              append: async (rows) => calls.push(['append', rows.length]),
              close: async () => calls.push(['close']),
            }
          },
        }
      }
      if (name === 'workspace') {
        return { attachSession: async (id) => calls.push(['attach', id]) }
      }
      return undefined
    },
  }
}

describe('createImportedSession', () => {
  const plan = {
    header: { version: 4, id: 'session-new', createdAt: 1, cwd: '/tmp', isSeeded: false },
    events: [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }],
    warnings: ['一条提示'],
  }

  it('seeds the session, writes it through a handle, then attaches it', async () => {
    const ctx = fakeCtx()
    const result = await createImportedSession(ctx, plan)
    expect(ctx.calls).toEqual([
      ['sessions.create', 'session-new', 1],
      ['persistence.create', 'session-new'],
      ['append', 1],
      ['close'],
      ['attach', 'session-new'],
    ])
    expect(result).toMatchObject({ sessionId: 'session-new', eventCount: 1, attached: true })
  })

  it('skips the workspace attach when asked to', async () => {
    const ctx = fakeCtx()
    const result = await createImportedSession(ctx, plan, { attach: false })
    expect(result.attached).toBe(false)
    expect(ctx.calls.some(([name]) => name === 'attach')).toBe(false)
  })

  it('refuses when the host has no persistence service', async () => {
    const ctx = { get: (name) => (name === 'sessions' ? { create: () => ({ header: {}, snapshotEvents: () => [] }) } : undefined) }
    await expect(createImportedSession(ctx, plan)).rejects.toThrow(ImportError)
  })

  it('reports a rejected seed as a refusal, not a crash', async () => {
    const ctx = {
      get: (name) => {
        if (name === 'sessions') return { create: () => { throw new Error('seed event at index 0 has seq 9') } }
        if (name === 'sessionPersistence') return { create: async () => ({ append: async () => {}, close: async () => {} }) }
        return undefined
      },
    }
    await expect(createImportedSession(ctx, plan)).rejects.toThrow(/宿主拒绝了这份事件流/u)
  })
})

describe('export then import', () => {  it('reproduces the same conversation', () => {
    const original = parsedOf(events)
    const plan = planImport(original, { id: 'session-copy', cwd: '/tmp', now: 1000 })
    const again = parseLogArtifact(buildLogArtifact({ header: plan.header, events: plan.events }))
    const second = planImport(again, { id: 'session-copy-2', cwd: '/tmp', now: 1000 })
    expect(second.events).toEqual(plan.events)
  })

  it('drops every type on the denylist from a real-shaped log', () => {
    const rows = [...DROPPED_TYPES].map((type, index) => ({ type, seq: index, time: 1, data: {} }))
    rows.push({ type: 'turn/start', seq: rows.length, time: 1, data: { turn: 1 } })
    const plan = planImport(parsedOf(rows, {}), { id: 'session-new', now: 1000 })
    expect(plan.events.map((event) => event.type)).toEqual(['turn/start'])
  })
})

describe('runImport', () => {
  const text = buildLogArtifact({ header, events, title: '示例' })

  it('plans without touching any service on a dry run', async () => {
    const ctx = { get: () => { throw new Error('no service should be resolved on a dry run') } }
    const result = await runImport(ctx, { text, dryRun: true })
    expect(result.dryRun).toBe(true)
    expect(result.kind).toBe('log')
    expect(result.eventCount).toBe(events.length - 2)
    expect(result.sessionId).toMatch(/^session-/u)
  })

  it('keeps the recorded working directory and says so', async () => {
    const ctx = { get: () => undefined }
    const result = await runImport(ctx, { text, dryRun: true })
    expect(result.warnings.join(' ')).toContain('/Users/someone/project')
  })

  it('lets an explicit cwd win over the recorded one', async () => {
    const ctx = { get: () => undefined }
    const result = await runImport(ctx, { text, cwd: '/tmp/elsewhere', dryRun: true })
    expect(result.warnings.join(' ')).not.toContain('/Users/someone/project')
  })

  it('detects Markdown from the extension and reports turns', async () => {
    const ctx = { get: () => undefined }
    const result = await runImport(ctx, { text: markdown, path: 'notes.md', dryRun: true })
    expect(result.kind).toBe('markdown')
    expect(result.eventCount).toBeGreaterThan(0)
    expect(result.title).toBe('一次对话')
  })

  it('refuses an empty payload', async () => {
    await expect(runImport({ get: () => undefined }, { text: '  ' })).rejects.toThrow(ImportError)
  })
})
