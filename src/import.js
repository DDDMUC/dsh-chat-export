// dsh-chat-export - turning a file back into a conversation.
//
// Two sources can become a session:
//
//   A. a `log` sidecar (this plugin's own export, or a raw session artifact):
//      the events are real DSH events, so they are replayed with only the
//      bookkeeping rewritten - identity, sequence numbers, and the payload
//      fields that name a machine or a parent session.
//   B. a Markdown transcript: only the conversation survives, so one
//      user/assistant pair becomes one minimal step. Tool calls, reasoning, and
//      images are gone; that is the cost of reading a rendered file.
//
// The planner is pure and the creator is the only part that touches services,
// so the hard rules (sequence contiguity, dropped types, remapped references)
// are unit-testable without a host.

import { randomUUID } from 'node:crypto'
import { SESSION_FORMAT_VERSION } from './log.js'

/**
 * Event types that name the machine, the parent, or a live process rather than
 * the conversation. Replaying them would either lie (a `cwd` from another
 * computer) or dangle (a seq reference into an event that was dropped).
 */
export const DROPPED_TYPES = new Set([
  'subagent/descriptor',
  'subagent/catalog',
  'agent/inbox/spliced',
  'command/run',
  'command/done',
  'request/header',
  'request/context',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  'assistant/attempt',
  'llm/retry',
  'llm/retry-started',
  'session/end-seed',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'compaction/prune',
])

/** An import failure the route reports as a refusal rather than a crash. */
export class ImportError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ImportError'
    this.code = code
    this.status = status
  }
}

/** A fresh session identity in the spelling the store uses. */
export function newSessionId() {
  return `session-${randomUUID()}`
}

/** Rewrite one seq reference through the old-to-new map, dropping dead ones. */
function remapSeq(value, mapping) {
  if (typeof value !== 'number') return undefined
  return mapping.get(value)
}

/** Rewrite every seq reference a surviving event carries. */
function remapReferences(event, mapping) {
  const data = event.data
  if (data === null || typeof data !== 'object') return

  if (event.type === 'session/title' && Array.isArray(data.messageSeqs)) {
    data.messageSeqs = data.messageSeqs.map((seq) => remapSeq(seq, mapping)).filter((seq) => seq !== undefined)
  }

  if (event.type === 'image/offload' && Array.isArray(data.targets)) {
    for (const target of data.targets) {
      if (target === null || typeof target !== 'object') continue
      if (typeof target.seq === 'number') {
        const next = remapSeq(target.seq, mapping)
        if (next === undefined) continue
        target.seq = next
      }
    }
  }

  const surfaceOp = event.surfaceOp
  if (surfaceOp !== null && typeof surfaceOp === 'object') {
    if (Array.isArray(surfaceOp.sourceEventSeqs)) {
      surfaceOp.sourceEventSeqs = surfaceOp.sourceEventSeqs.map((seq) => remapSeq(seq, mapping)).filter((seq) => seq !== undefined)
    }
    for (const key of ['startSeq', 'endSeq', 'seq']) {
      if (typeof surfaceOp[key] === 'number') {
        const next = remapSeq(surfaceOp[key], mapping)
        if (next === undefined) delete surfaceOp[key]
        else surfaceOp[key] = next
      }
    }
  }
}

/**
 * Plan the replay of a parsed sidecar as a new session.
 *
 * The host requires seed events to be contiguous from seq 0, so the surviving
 * events are renumbered by array position and every seq reference inside them
 * is rewritten to match. Events that name a machine or a live process are
 * dropped before that renumbering happens.
 *
 * @param parsed - the result of `parseLogArtifact`.
 * @param options - `{ id?, cwd?, title?, now? }`; `cwd` must be absolute.
 * @returns `{ header, events, warnings, dropped, title }`.
 */
export function planImport(parsed, options = {}) {
  const now = options.now ?? Date.now()
  const events = Array.isArray(parsed.events) ? parsed.events : []
  if (events.length === 0) throw new ImportError('no-events', '这份文件里没有会话事件')

  const dropped = new Map()
  const kept = []
  const mapping = new Map()

  for (const event of events) {
    const type = typeof event?.type === 'string' ? event.type : ''
    if (type === '' || DROPPED_TYPES.has(type)) {
      const key = type === '' ? '(无 type)' : type
      dropped.set(key, (dropped.get(key) ?? 0) + 1)
      continue
    }
    const seq = typeof event.seq === 'number' ? event.seq : undefined
    mapping.set(seq ?? -1, kept.length)
    kept.push(event)
  }

  if (kept.length === 0) throw new ImportError('all-dropped', '所有事件都属于机器相关或临时记录，没有可回灌的对话内容')

  const replayed = kept.map((event, index) => {
    const next = {
      type: event.type,
      seq: index,
      time: typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : now,
      data: event.data === undefined ? {} : structuredClone(event.data),
    }
    if (event.surfaceOp !== undefined) next.surfaceOp = structuredClone(event.surfaceOp)
    remapReferences(next, mapping)
    return next
  })

  const cwd = typeof options.cwd === 'string' && options.cwd !== '' ? options.cwd : undefined
  if (cwd !== undefined && !cwd.startsWith('/')) throw new ImportError('invalid-cwd', 'cwd 必须是绝对路径')

  const header = {
    version: SESSION_FORMAT_VERSION,
    id: typeof options.id === 'string' && options.id !== '' ? options.id : newSessionId(),
    createdAt: now,
    ...cwd === undefined ? {} : { cwd },
    // Deliberately absent: parentSession, origin, delegationDepth, agentPreset.
    // They either point at a session that does not exist here or name a preset
    // this profile may not compose, and the host refuses both.
    isSeeded: false,
  }

  const title = typeof options.title === 'string' && options.title !== '' ? options.title : parsed.title ?? ''
  const warnings = [...(parsed.warnings ?? [])]
  if (dropped.size > 0) {
    const summary = [...dropped].map(([type, count]) => `${type}×${count}`).join('、')
    warnings.push(`已跳过机器相关记录：${summary}`)
  }
  if (parsed.header?.id !== undefined) warnings.push(`原会话是 ${parsed.header.id}，导入后是 ${header.id}`)

  return { header, events: replayed, warnings, dropped: [...dropped.keys()], title }
}

/** Split Markdown into the header block and one entry per `## 回合` / `###` block. */
function readMarkdownBlocks(text) {
  const lines = String(text ?? '').split(/\r?\n/u)
  const turns = []
  let title = ''
  let current = null
  let block = null

  for (const line of lines) {
    const titleMatch = /^#\s+(.+)$/u.exec(line)
    if (titleMatch !== null && title === '' && turns.length === 0 && block === null) {
      title = titleMatch[1].trim()
      continue
    }
    const turnMatch = /^##\s+回合\s+(\d+)/u.exec(line)
    if (turnMatch !== null) {
      current = { index: Number(turnMatch[1]), blocks: [] }
      turns.push(current)
      block = null
      continue
    }
    const blockMatch = /^###\s+(.+)$/u.exec(line)
    if (blockMatch !== null) {
      if (current === null) {
        current = { index: turns.length + 1, blocks: [] }
        turns.push(current)
      }
      block = { label: blockMatch[1].trim(), lines: [] }
      current.blocks.push(block)
      continue
    }
    if (block !== null) block.lines.push(line)
  }

  for (const turn of turns) {
    for (const entry of turn.blocks) {
      entry.text = entry.lines.join('\n').replace(/^\n+/u, '').replace(/\s+$/u, '')
    }
  }
  return { title, turns }
}

/** Which speaker one `###` label belongs to. */
function speakerOf(label) {
  if (label.startsWith('用户')) return 'user'
  if (label.startsWith('注入内容')) return 'injected'
  if (label.startsWith('助手')) return 'assistant'
  return 'other'
}

/**
 * Synthesize a minimal event stream from a Markdown transcript.
 *
 * One user/assistant pair becomes one step; an assistant block with no user
 * before it still opens its own step, because the transcript genuinely has one.
 *
 * @param text - the Markdown document.
 * @param options - `{ now? }`.
 * @returns `{ events, title, warnings, turns, messages }`.
 */
export function eventsFromMarkdown(text, options = {}) {
  const now = options.now ?? Date.now()
  const { title, turns } = readMarkdownBlocks(text)
  const events = []
  const warnings = []
  let messages = 0
  let turnNumber = 0

  const push = (type, data) => {
    events.push({ type, seq: events.length, time: now, data })
  }
  const userEvent = (body) => {
    push('user/message', {
      content: [{ type: 'text', text: body }],
      source: { kind: 'user' },
      role: 'user',
      id: randomUUID(),
    })
    messages += 1
  }
  const assistantEvent = (turn, step, body) => {
    push('assistant/message', {
      turn,
      step,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: body }],
        source: { kind: 'model', provider: 'dsh-chat-export', model: 'imported' },
        id: randomUUID(),
      },
      stream: [],
    })
    messages += 1
  }

  for (const turn of turns) {
    const steps = []
    let pending = []
    for (const entry of turn.blocks) {
      const speaker = speakerOf(entry.label)
      if (entry.text === '') continue
      if (speaker === 'injected') continue
      if (speaker === 'other') {
        warnings.push(`跳过无法归类的小节：「${entry.label}」`)
        continue
      }
      if (speaker === 'user') {
        pending.push(entry.text)
        continue
      }
      steps.push({ users: pending, assistant: entry.text })
      pending = []
    }
    if (pending.length > 0) steps.push({ users: pending, assistant: null })
    if (steps.length === 0) continue

    turnNumber += 1
    push('turn/start', { turn: turnNumber })
    steps.forEach((step, index) => {
      const stepNumber = index + 1
      push('step/start', { turn: turnNumber, step: stepNumber })
      for (const body of step.users) userEvent(body)
      if (step.assistant !== null) assistantEvent(turnNumber, stepNumber, step.assistant)
      push('step/end', { turn: turnNumber, step: stepNumber })
    })
    push('turn/end', { turn: turnNumber, reason: { kind: 'completed' } })
  }

  if (messages === 0) throw new ImportError('no-messages', '这份 Markdown 里没有识别出任何用户或助手消息')

  const firstUser = events.find((event) => event.type === 'user/message')
  push('session/title', {
    title: title === '' ? '导入的会话' : title,
    messageSeqs: firstUser === undefined ? [] : [firstUser.seq],
    source: { kind: 'fallback' },
  })

  return { events, title: title === '' ? '导入的会话' : title, warnings, turns: turnNumber, messages }
}

/**
 * Create a real session from a plan.
 *
 * The three calls mirror the agent factory's own creation path: seed the
 * session through the store (which validates every event), take the durable
 * write handle, and append the seed. Without the handle the session would exist
 * only in memory and vanish with the process.
 *
 * @param ctx - host context.
 * @param plan - the result of `planImport` or `eventsFromMarkdown`.
 * @param options - `{ signal?, attach? }`; `attach` defaults to true.
 * @returns `{ sessionId, eventCount, attached, warnings }`.
 */
export async function createImportedSession(ctx, plan, options = {}) {
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  if (sessions === undefined || typeof sessions.create !== 'function') {
    throw new ImportError('no-sessions', '宿主没有挂载 sessions 服务，无法新建会话', 503)
  }
  if (persistence === undefined || typeof persistence.create !== 'function') {
    throw new ImportError('no-persistence', '宿主没有挂载 sessionPersistence 服务，导入的会话无法落盘', 503)
  }

  const { header, events } = plan
  let session
  try {
    session = sessions.create(header.id, {
      seed: events,
      meta: {
        createdAt: header.createdAt,
        ...header.cwd === undefined ? {} : { cwd: header.cwd },
      },
    })
  } catch (error) {
    throw new ImportError('rejected', `宿主拒绝了这份事件流：${error instanceof Error ? error.message : String(error)}`, 422)
  }

  const handle = await persistence.create(session.header, { inheritedEventCount: 0 })
  try {
    await handle.append(session.snapshotEvents())
  } finally {
    await handle.close()
  }

  let attached = false
  const workspace = ctx.get('workspace')
  if (options.attach !== false && workspace !== undefined && typeof workspace.attachSession === 'function') {
    await workspace.attachSession(header.id)
    attached = true
  }

  return { sessionId: header.id, eventCount: events.length, attached, warnings: plan.warnings ?? [] }
}
