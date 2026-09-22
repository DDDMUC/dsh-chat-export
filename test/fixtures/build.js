// Fixture builders for the transcript tests.
//
// Events are built by hand rather than read from a real log so each test names
// exactly the shape it depends on. The rules these fixtures encode came from
// real logs; the two that matter most are that `user/message` carries no
// `turn`/`step`, and that `agent/inbox/spliced` can hold the only copy of a
// user message.

let clock = 1_760_000_000_000

/** Reset the shared clock so tests are deterministic. */
export function resetClock(start = 1_760_000_000_000) {
  clock = start
}

/** Next event timestamp. */
function tick(delta = 1000) {
  clock += delta
  return clock
}

/** One raw event envelope with a monotonic seq. */
export function event(seq, type, data, extra = {}) {
  return { type, seq, time: tick(), data, ...extra }
}

/** A session header row. */
export function header(overrides = {}) {
  return {
    type: 'session',
    version: 3,
    id: 'session-11111111-2222-3333-4444-555555555555',
    createdAt: 1_760_000_000_000,
    cwd: '/tmp/example',
    isSeeded: false,
    delegationDepth: 0,
    agentPreset: 'standard',
    ...overrides,
  }
}

/** A text content block. */
export function text(value) {
  return { type: 'text', text: value }
}

/** A reasoning content block. */
export function reasoning(value) {
  return { type: 'reasoning', text: value }
}

/** An image content block. */
export function image(attachmentId = 'sha256:aaaa', overrides = {}) {
  return {
    type: 'image',
    attachment: {
      attachmentId,
      mediaType: 'image/png',
      bytes: 2048,
      width: 640,
      height: 480,
      name: `${attachmentId.slice(7, 11)}.png`,
      ...overrides,
    },
  }
}

/** A tool-call content block. */
export function toolCall(id, name, args = '{}') {
  return { type: 'tool-call', id, name, arguments: args }
}

/** A `tool-result` content block. */
export function toolResult(callId, value, isError = false) {
  return { type: 'tool-result', toolCallId: callId, content: [text(value)], isError }
}

/** A user message event carrying a human prompt. */
export function userMessage(seq, id, content, source = { kind: 'user' }) {
  return event(seq, 'user/message', { id, role: 'user', content, source }, { surfaceOp: 'append' })
}

/** A user message event produced by a plugin or injected context. */
export function injectedMessage(seq, id, content, source = { kind: 'plugin', plugin: 'demo' }) {
  return event(seq, 'user/message', { id, role: 'user', content, source }, { surfaceOp: 'append' })
}

/** An assistant message event. */
export function assistantMessage(seq, content, options = {}) {
  return event(
    seq,
    'assistant/message',
    {
      turn: options.turn ?? 1,
      step: options.step ?? 1,
      message: {
        role: 'assistant',
        id: options.id ?? `assistant-${seq}`,
        content,
        source: { kind: 'model', provider: options.provider ?? 'deepseek-official', model: options.model ?? 'deepseek-chat' },
      },
      ...(options.usage === undefined ? {} : { usage: options.usage }),
      ...(options.interrupted === undefined ? {} : { interrupted: options.interrupted }),
    },
    { surfaceOp: 'append' },
  )
}

/** A system message event. */
export function systemMessage(seq, value, turn = 1, step = 1) {
  return event(seq, 'system/message', { turn, step, message: { role: 'system', content: [text(value)] } }, { surfaceOp: 'append' })
}

/** A `tool/call` event. */
export function toolCallEvent(seq, callId, name, args = '{}', turn = 1, step = 1) {
  return event(seq, 'tool/call', { turn, step, callId, name, arguments: args })
}

/** A `tool/result` event. */
export function toolResultEvent(seq, callId, value, options = {}) {
  return event(
    seq,
    'tool/result',
    {
      turn: options.turn ?? 1,
      step: options.step ?? 1,
      message: { role: 'user', id: `result-${seq}`, content: [toolResult(callId, value, options.isError ?? false)], source: { kind: 'tool', callId } },
      ...(options.error === undefined ? {} : { error: options.error }),
    },
    { surfaceOp: 'append', sourceEventSeqs: [seq - 1] },
  )
}

/** A `turn/start` event. */
export function turnStart(seq, turn) {
  return event(seq, 'turn/start', { turn })
}

/** A `turn/end` event. */
export function turnEnd(seq, turn, kind = 'completed') {
  return event(seq, 'turn/end', { turn, reason: { kind } })
}

/** A `step/start` event. */
export function stepStart(seq, turn, step) {
  return event(seq, 'step/start', { turn, step })
}

/** A `step/end` event. */
export function stepEnd(seq, turn, step) {
  return event(seq, 'step/end', { turn, step })
}

/** A `session/title` event. */
export function title(seq, value) {
  return event(seq, 'session/title', { title: value, messageSeqs: [1], source: { kind: 'fallback' } })
}

/** An `agent/inbox/spliced` event carrying inserted user messages. */
export function spliced(seq, messages) {
  return event(seq, 'agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: messages })
}

/** An inserted message payload (as it appears inside `agent/inbox/spliced`). */
export function insertedMessage(id, content, source = { kind: 'user' }) {
  return { id, role: 'user', content, source }
}

/**
 * A small but complete session that exercises every rule at once:
 * a turn with reasoning, a tool call and result, an image, an injected
 * message, a spliced-only message, and a compaction replacement.
 * @returns `{header, events}`.
 */
export function sampleSession() {
  resetClock()
  const imageRef = image('sha256:1111', { name: 'shot.png' })
  const events = [
    title(0, '示例会话'),
    turnStart(1, 1),
    stepStart(2, 1, 1),
    systemMessage(3, 'You are a coding agent.'),
    userMessage(4, 'msg-1', [text('帮我改一下这个函数')]),
    /** The spliced copy of `msg-1` proves de-duplication works. */
    spliced(5, [insertedMessage('msg-1', [text('帮我改一下这个函数')])]),
    stepEnd(6, 1, 1),
    turnEnd(7, 1, 'completed'),
    turnStart(8, 2),
    stepStart(9, 2, 1),
    assistantMessage(
      10,
      [reasoning('先看看代码。'), text('我先读文件。'), toolCall('call-1', 'read_file', '{"path":"a.js"}')],
      { turn: 2, step: 1, usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    ),
    toolCallEvent(11, 'call-1', 'read_file', '{"path":"a.js"}', 2, 1),
    toolResultEvent(12, 'call-1', 'export function a() {}', { turn: 2, step: 1 }),
    stepEnd(13, 2, 1),
    stepStart(14, 2, 2),
    assistantMessage(15, [text('改好了。'), imageRef], {
      turn: 2,
      step: 2,
      usage: { inputTokens: 200, outputTokens: 40, totalTokens: 240, cacheReadTokens: 50 },
    }),
    stepEnd(16, 2, 2),
    turnEnd(17, 2, 'completed'),
    turnStart(18, 3),
    stepStart(19, 3, 1),
    injectedMessage(20, 'inject-1', [text('<system-reminder>todo</system-reminder>')]),
    spliced(21, [insertedMessage('spliced-only', [text('只有 spliced 里有这条')])]),
    assistantMessage(22, [text('收到。')], { turn: 3, step: 1 }),
    stepEnd(23, 3, 1),
    turnEnd(24, 3, 'completed'),
  ]
  return { header: header(), events }
}
