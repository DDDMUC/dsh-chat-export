import { describe, expect, it } from 'vitest'
import { buildLogArtifact, parseLogArtifact } from '../src/log.js'
import { listWorkspaces, runCompose, runImport, runImportZip } from '../src/index.js'
import { buildZip } from '../src/zip.js'
import {
  DROPPED_TYPES,
  ImportError,
  createImportedSession,
  eventsFromDialogue,
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

  it('marks every synthesized message as an append-origin surface event', () => {
    const built = eventsFromMarkdown(markdown, { now: 1000 })
    const surfaces = built.events.filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
    expect(surfaces).toHaveLength(4)
    for (const event of surfaces) expect(event.surfaceOp).toBe('append')
  })

  it('refuses a document with no recognizable messages', () => {
    expect(() => eventsFromMarkdown('# 只有标题\n\n没有消息。', { now: 1000 })).toThrow(ImportError)
  })
})

describe('eventsFromMarkdown on a pasted user:/model: transcript', () => {
  /** The messages a built transcript carries, in order. */
  function bodies(built) {
    return built.events
      .filter((event) => event.type === 'user/message' || event.type === 'assistant/message')
      .map((event) =>
        event.type === 'user/message' ? event.data.content[0].text : event.data.message.content[0].text,
      )
  }

  it('reads labels on their own line', () => {
    const built = eventsFromMarkdown('user:\n你好\n\nmodel:\n你好，有什么可以帮你？\n\nuser:\n讲个笑话\n\nmodel:\n好的。', { now: 1000 })
    expect(built.turns).toBe(2)
    expect(built.messages).toBe(4)
    expect(bodies(built)).toEqual(['你好', '你好，有什么可以帮你？', '讲个笑话', '好的。'])
  })

  it('reads the inline `label: text` form', () => {
    const built = eventsFromMarkdown('user: 你好\nmodel: 在的', { now: 1000 })
    expect(bodies(built)).toEqual(['你好', '在的'])
  })

  it('accepts a full-width colon and bold labels', () => {
    const built = eventsFromMarkdown('**User：**你好\n**Assistant：**在的', { now: 1000 })
    expect(bodies(built)).toEqual(['你好', '在的'])
  })

  it('accepts the Chinese labels', () => {
    const built = eventsFromMarkdown('用户：你好\n模型：在的', { now: 1000 })
    expect(bodies(built)).toEqual(['你好', '在的'])
  })

  it('keeps a speaker label inside a code fence as body text', () => {
    const built = eventsFromMarkdown('user:\n这个文件里写了什么？\n\nmodel:\n```\nuser: root\nmodel: x\n```\n\n就这样。', { now: 1000 })
    expect(built.messages).toBe(2)
    expect(bodies(built)[1]).toContain('user: root')
    expect(bodies(built)[1]).toContain('就这样。')
  })

  it('still prefers the strict format when the file is one of ours', () => {
    const built = eventsFromMarkdown(markdown, { now: 1000 })
    expect(built.turns).toBe(2)
    expect(built.title).toBe('一次对话')
  })

  it('attaches a 思维 block to the next assistant message', () => {
    const built = eventsFromMarkdown('用户：你是谁\n思维：用户问身份，我用依芙的人设回答。\n助手：我是依芙。', { now: 1000 })
    const assistant = built.events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content).toEqual([
      { type: 'reasoning', text: '用户问身份，我用依芙的人设回答。' },
      { type: 'text', text: '我是依芙。' },
    ])
  })

  it('joins several 思维 lines into one reasoning block', () => {
    const built = eventsFromMarkdown('用户：问\n思维：第一步。\n思维：第二步。\n助手：答', { now: 1000 })
    const assistant = built.events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content[0]).toEqual({ type: 'reasoning', text: '第一步。\n第二步。' })
  })

  it('keeps continuation lines under the reasoning block', () => {
    const built = eventsFromMarkdown('用户：问\n思维：\n第一步。\n第二步。\n助手：答', { now: 1000 })
    const assistant = built.events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content[0].text).toBe('第一步。\n第二步。')
  })

  it('accepts the English thinking label', () => {
    const built = eventsFromMarkdown('user: q\nthinking: weighing options\nassistant: a', { now: 1000 })
    const assistant = built.events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content[0]).toEqual({ type: 'reasoning', text: 'weighing options' })
  })

  it('drops a reasoning block that no assistant message follows', () => {
    const built = eventsFromMarkdown('用户：问\n思维：悬空的想法。', { now: 1000 })
    expect(built.messages).toBe(1)
    expect(built.events.some((event) => event.type === 'assistant/message')).toBe(false)
  })

  it('leaves a message without reasoning as plain text', () => {
    const built = eventsFromMarkdown('用户：问\n助手：答', { now: 1000 })
    const assistant = built.events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content).toEqual([{ type: 'text', text: '答' }])
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
      if (name === 'workspaceRegistry') {
        return {
          create: async (path) => {
            calls.push(['registry.create', path])
            return { id: 'w1', path, attachSession: async (id) => calls.push(['attach', id]) }
          },
          list: () => [],
        }
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
      ['registry.create', '/tmp'],
      ['attach', 'session-new'],
    ])
    expect(result).toMatchObject({ sessionId: 'session-new', eventCount: 1, attached: true, workspace: '/tmp' })
  })

  it('falls back to an existing workspace when the recorded directory is gone', async () => {
    const calls = []
    const ctx = {
      get: (name) => {
        if (name === 'sessions') return { create: () => ({ header: { id: 'session-new' }, snapshotEvents: () => [] }) }
        if (name === 'sessionPersistence') return { create: async () => ({ append: async () => {}, close: async () => {} }) }
        if (name === 'workspaceRegistry') {
          return {
            create: async () => { throw new Error('no such directory') },
            list: () => [{ id: 'w9', path: '/Users/me/other', attachSession: async (id) => calls.push(id) }],
          }
        }
        return undefined
      },
    }
    const result = await createImportedSession(ctx, plan)
    expect(result).toMatchObject({ attached: true, workspace: '/Users/me/other' })
    expect(calls).toEqual(['session-new'])
  })

  it('says so when the host has no workspace registry at all', async () => {
    const ctx = {
      get: (name) => {
        if (name === 'sessions') return { create: () => ({ header: { id: 'session-new' }, snapshotEvents: () => [] }) }
        if (name === 'sessionPersistence') return { create: async () => ({ append: async () => {}, close: async () => {} }) }
        return undefined
      },
    }
    const result = await createImportedSession(ctx, plan)
    expect(result.attached).toBe(false)
    expect(result.warnings.join(' ')).toContain('workspaceRegistry')
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

describe('the protected system head', () => {
  /** The first event that occupies a surface node. */
  const firstSurface = (events) => events.find((event) => event.surfaceOp !== undefined)

  it('opens a Markdown import with an empty system message', () => {
    const built = eventsFromMarkdown('用户：问\n助手：答', { now: 1000 })
    const head = firstSurface(built.events)
    expect(head.type).toBe('system/message')
    expect(head.surfaceOp).toBe('append')
    expect(head.data.message).toMatchObject({ role: 'system', content: [], source: { kind: 'system-prompt' } })
  })

  it('opens a composed dialogue the same way', () => {
    const built = eventsFromDialogue([{ role: 'user', text: '问' }, { role: 'assistant', text: '答' }], { now: 1000 })
    const head = firstSurface(built.events)
    expect(head.type).toBe('system/message')
    expect(head.data.message.content).toEqual([])
  })

  it('does not put a user message on surface node 0', () => {
    // The store refuses to load a log whose first surface event is a user
    // message: "system/message requires a protected first surface head".
    const built = eventsFromMarkdown('用户：问\n助手：答', { now: 1000 })
    expect(built.events.find((event) => event.surfaceOp !== undefined).type).not.toBe('user/message')
  })

  it('emits exactly one head, on the first turn', () => {
    const built = eventsFromMarkdown('用户：一\n助手：二\n用户：三\n助手：四', { now: 1000 })
    expect(built.events.filter((event) => event.type === 'system/message')).toHaveLength(1)
  })
})

describe('eventsFromDialogue', () => {
  it('emits the same chain an import does', () => {
    const built = eventsFromDialogue(
      [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '在的', reasoning: '先打个招呼' },
      ],
      { now: 1000, title: '手写对话' },
    )
    expect(built.turns).toBe(1)
    expect(built.messages).toBe(2)
    expect(built.title).toBe('手写对话')
    const assistant = built.events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content).toEqual([
      { type: 'reasoning', text: '先打个招呼' },
      { type: 'text', text: '在的' },
    ])
  })

  it('refuses a draft with nothing in it', () => {
    expect(() => eventsFromDialogue([], { now: 1000 })).toThrow(ImportError)
  })

  it('opens one turn per user message', () => {
    const built = eventsFromDialogue(
      [
        { role: 'user', text: 'a' },
        { role: 'assistant', text: 'b' },
        { role: 'user', text: 'c' },
        { role: 'assistant', text: 'd' },
      ],
      { now: 1000 },
    )
    expect(built.turns).toBe(2)
  })

  it('never attaches reasoning to a user message', () => {
    const built = eventsFromDialogue([{ role: 'user', text: 'x', reasoning: '我不该有思维链' }], { now: 1000 })
    const user = built.events.find((event) => event.type === 'user/message')
    expect(user.data.content).toEqual([{ type: 'text', text: 'x' }])
  })

  it('calls an unnamed dialogue 新建的会话 rather than 导入的会话', () => {
    const built = eventsFromDialogue([{ role: 'user', text: 'x' }], { now: 1000 })
    expect(built.title).toBe('新建的会话')
  })
})

describe('runCompose', () => {
  it('creates a real session and attaches it', async () => {
    const ctx = fakeCtx()
    const result = await runCompose(ctx, {
      messages: [
        { role: 'user', text: '你好' },
        { role: 'assistant', text: '在的' },
      ],
      title: '手写对话',
      cwd: '/tmp/notes',
    })
    expect(result.ok).toBe(true)
    expect(result.kind).toBe('compose')
    expect(result.title).toBe('手写对话')
    expect(result.messages).toBe(2)
    expect(ctx.calls.some(([name]) => name === 'attach')).toBe(true)
  })

  it('refuses an empty draft', async () => {
    await expect(runCompose(fakeCtx(), { messages: [] })).rejects.toThrow(ImportError)
  })

  it('skips a message whose body is blank', async () => {
    const result = await runCompose(fakeCtx(), {
      messages: [
        { role: 'user', text: 'x' },
        { role: 'assistant', text: '   ', reasoning: '只有思维' },
      ],
    })
    expect(result.messages).toBe(1)
  })

  it('strips reasoning a client sends on a user message', async () => {
    const base = fakeCtx()
    let seed = []
    const ctx = {
      get(name) {
        const service = base.get(name)
        if (name !== 'sessions') return service
        return {
          create: (id, options) => {
            seed = options.seed
            return service.create(id, options)
          },
        }
      },
    }
    await runCompose(ctx, { messages: [{ role: 'user', text: 'x', reasoning: '不该有' }] })
    const user = seed.find((event) => event.type === 'user/message')
    expect(user.data.content).toEqual([{ type: 'text', text: 'x' }])
  })

  it('defaults the title when none is given', async () => {
    const result = await runCompose(fakeCtx(), { messages: [{ role: 'user', text: 'x' }] })
    expect(result.title).toBe('新建的会话')
  })
})

describe('listWorkspaces', () => {
  it('returns the workspaces the registry knows, by title, dropping entries without a path', () => {
    const ctx = {
      get: () => ({
        list: () => [
          { id: 'w1', path: '/tmp/a', title: 'Default Project' },
          { id: 'w2', path: '/tmp/b' },
          { id: 'w3', title: '没有路径' },
        ],
      }),
    }
    expect(listWorkspaces(ctx)).toEqual({
      ok: true,
      workspaces: [
        { id: 'w1', path: '/tmp/a', title: 'Default Project' },
        // A record with no title falls back to its directory.
        { id: 'w2', path: '/tmp/b', title: '/tmp/b' },
      ],
    })
  })

  it('returns an empty list when the host has no registry', () => {
    expect(listWorkspaces({ get: () => undefined })).toEqual({ ok: true, workspaces: [] })
  })
})

describe('a DeepSeek chat export', () => {
  /** One conversation file for the archive. */
  const conversation = (id, title) => ({
    id,
    title,
    current_message_id: 2,
    inserted_at: '2026-01-01T00:00:00Z',
    messages: [
      { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-01-01T00:00:00Z', fragments: [{ type: 'REQUEST', content: `问 ${title}` }] },
      { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-01-01T00:00:01Z', fragments: [{ type: 'RESPONSE', content: `答 ${title}` }] },
    ],
  })

  const archive = () =>
    buildZip([
      { path: 'manifest.json', data: Buffer.from('{"export_format_version":3}') },
      {
        path: 'chat_session_index.json',
        data: Buffer.from(
          JSON.stringify([
            { id: 'old', updated_at: '2026-01-01T00:00:00Z' },
            { id: 'new', updated_at: '2026-03-01T00:00:00Z' },
          ]),
        ),
      },
      { path: 'chat_sessions/old.json', data: Buffer.from(JSON.stringify(conversation('old', '旧会话'))) },
      { path: 'chat_sessions/new.json', data: Buffer.from(JSON.stringify(conversation('new', '新会话'))) },
    ])

  it('is routed away from the session-log reader', async () => {
    const result = await runImportZip(fakeCtx(), { zip: archive(), dryRun: true })
    expect(result.kind).toBe('deepseek')
  })

  it('imports the most recently updated conversation', async () => {
    const result = await runImportZip(fakeCtx(), { zip: archive(), dryRun: true })
    expect(result.title).toBe('新会话')
    expect(result.sourceId).toBe('new')
    expect(result.messages ?? result.eventCount).toBeGreaterThan(0)
  })

  it('says how many other conversations the archive holds', async () => {
    const result = await runImportZip(fakeCtx(), { zip: archive(), dryRun: true })
    expect(result.available).toBe(2)
    expect(result.warnings.join('')).toContain('2 个会话')
  })

  it('takes an explicitly named conversation', async () => {
    const result = await runImportZip(fakeCtx(), { zip: archive(), dryRun: true, sessionId: 'old' })
    expect(result.title).toBe('旧会话')
  })

  it('imports a batch when a limit is given', async () => {
    const result = await runImportZip(fakeCtx(), { zip: archive(), dryRun: true, limit: 2 })
    expect(result.imported.map((entry) => entry.title)).toEqual(['新会话', '旧会话'])
  })

  it('reports a conversation that is not in the archive', async () => {
    await expect(runImportZip(fakeCtx(), { zip: archive(), dryRun: true, sessionId: 'nope' })).rejects.toThrow(/没有会话/u)
  })

  it('writes a real session when it is not a dry run', async () => {
    const ctx = fakeCtx()
    // The fake registry only has the workspace `create` makes, so the import
    // has to be told where to put the session.
    const result = await runImportZip(ctx, { zip: archive(), cwd: '/tmp/notes' })
    expect(result.ok).toBe(true)
    expect(ctx.calls.some(([name]) => name === 'sessions.create')).toBe(true)
    expect(ctx.calls.some(([name]) => name === 'attach')).toBe(true)
  })
})
