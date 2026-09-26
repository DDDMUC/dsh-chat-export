import { describe, expect, it } from 'vitest'
import {
  buildTranscript,
  collectAttachmentsOf,
  foldSurface,
  readToolResultContent,
  truncateBody,
} from '../src/transcript.js'
import { defaultOptions } from '../src/options.js'
import {
  assistantMessage,
  event,
  header,
  image,
  injectedMessage,
  insertedMessage,
  reasoning,
  resetClock,
  sampleSession,
  spliced,
  stepEnd,
  stepStart,
  text,
  toolCall,
  toolCallEvent,
  toolResultEvent,
  turnEnd,
  turnStart,
  userMessage,
} from './fixtures/build.js'

/** Options with overrides applied. */
function options(overrides = {}) {
  return { ...defaultOptions(), ...overrides }
}

describe('foldSurface', () => {
  it('appends surface events in order', () => {
    const events = [userMessage(0, 'a', [text('hi')]), assistantMessage(1, [text('hello')])]
    expect(foldSurface(events).nodes).toEqual([0, 1])
    expect(foldSurface(events).shadowed.size).toBe(0)
  })

  it('replaces an inclusive window and records every shadowed seq', () => {
    const events = [
      userMessage(0, 'a', [text('one')]),
      assistantMessage(1, [text('two')]),
      userMessage(2, 'b', [text('three')]),
      event(3, 'system/message', { turn: 1, step: 1, message: { content: [text('summary')] } }, {
        surfaceOp: { op: 'replace', startSeq: 0, endSeq: 2 },
      }),
    ]
    const folded = foldSurface(events)
    expect(folded.nodes).toEqual([3])
    expect([...folded.shadowed].sort()).toEqual([0, 1, 2])
    expect(folded.replacements).toHaveLength(1)
  })

  it('skips a replacement whose anchors are gone instead of throwing', () => {
    const events = [
      userMessage(0, 'a', [text('one')]),
      event(1, 'system/message', { turn: 1, step: 1, message: { content: [text('s')] } }, {
        surfaceOp: { op: 'replace', startSeq: 90, endSeq: 99 },
      }),
    ]
    const folded = foldSurface(events)
    expect(folded.nodes).toEqual([0])
  })

  it('ignores surfaceOp null on a non-surface event', () => {
    const events = [event(0, 'agent/inbox/spliced', { inserted: [] }, { surfaceOp: null })]
    expect(foldSurface(events).nodes).toEqual([])
  })
})

describe('truncateBody', () => {
  it('keeps short bodies intact', () => {
    const result = truncateBody('a\nb', 100)
    expect(result.truncated).toBe(false)
    expect(result.totalLines).toBe(2)
  })

  it('cuts at a line boundary and reports the original size', () => {
    const body = Array.from({ length: 100 }, (_value, index) => `line ${index}`).join('\n')
    const result = truncateBody(body, 50)
    expect(result.truncated).toBe(true)
    expect(result.text.length).toBeLessThanOrEqual(50)
    expect(body.startsWith(result.text)).toBe(true)
    expect(result.totalLines).toBe(100)
    expect(result.totalChars).toBe(body.length)
  })

  it('disables truncation when the limit is zero', () => {
    const body = 'x'.repeat(10_000)
    expect(truncateBody(body, 0).truncated).toBe(false)
  })
})

describe('readToolResultContent', () => {
  it('joins nested text blocks and hoists images', () => {
    const result = readToolResultContent([
      { type: 'text', text: 'one' },
      { type: 'tool-result', content: [{ type: 'text', text: 'two' }, image('sha256:zz')] },
    ])
    expect(result.text).toBe('one\ntwo')
    expect(result.images).toHaveLength(1)
  })
})

describe('buildTranscript', () => {
  it('merges a spliced copy of the same message instead of duplicating it', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      userMessage(1, 'msg-1', [text('hi')]),
      spliced(2, [insertedMessage('msg-1', [text('hi')])]),
    ]
    const transcript = buildTranscript(header(), events, options({ injected: true }))
    const users = transcript.entries.filter((entry) => entry.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0].id).toBe('msg-1')
  })

  it('keeps a message that exists only inside a spliced event', () => {
    resetClock()
    const events = [turnStart(0, 1), spliced(1, [insertedMessage('only-here', [text('spliced only')])])]
    const transcript = buildTranscript(header(), events, options())
    const users = transcript.entries.filter((entry) => entry.kind === 'user')
    expect(users).toHaveLength(1)
    expect(users[0].parts[0].text).toBe('spliced only')
  })

  it('pairs a tool call with its result by callId and measures its duration', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      assistantMessage(2, [toolCall('call-1', 'bash', '{"command":"ls"}')]),
      toolCallEvent(3, 'call-1', 'bash', '{"command":"ls"}'),
      toolResultEvent(4, 'call-1', 'file.txt'),
    ]
    const transcript = buildTranscript(header(), events, options())
    const tools = transcript.entries.filter((entry) => entry.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].name).toBe('bash')
    expect(tools[0].result.text).toBe('file.txt')
    expect(tools[0].durationMs).toBeGreaterThan(0)
    expect(transcript.meta.counts.toolCalls).toBe(1)
  })

  it('does not double-count a tool call that also appears as a content block', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      assistantMessage(1, [toolCall('call-1', 'bash')]),
      toolCallEvent(2, 'call-1', 'bash'),
      toolResultEvent(3, 'call-1', 'ok'),
    ]
    const transcript = buildTranscript(header(), events, options())
    expect(transcript.meta.counts.toolCalls).toBe(1)
    expect(transcript.entries.filter((entry) => entry.kind === 'tool')).toHaveLength(1)
  })

  it('records a tool call whose own event never landed', () => {
    resetClock()
    const events = [turnStart(0, 1), assistantMessage(1, [toolCall('call-orphan', 'bash')])]
    const transcript = buildTranscript(header(), events, options())
    const tools = transcript.entries.filter((entry) => entry.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].synthetic).toBe(true)
  })

  it('records a result whose call event never landed', () => {
    resetClock()
    const events = [turnStart(0, 1), toolResultEvent(1, 'call-orphan', 'dangling')]
    const transcript = buildTranscript(header(), events, options())
    const tools = transcript.entries.filter((entry) => entry.kind === 'tool')
    expect(tools).toHaveLength(1)
    expect(tools[0].result.text).toBe('dangling')
  })

  it('gates reasoning blocks behind the thinking option', () => {
    resetClock()
    const events = [turnStart(0, 1), assistantMessage(1, [reasoning('hmm'), text('answer')])]
    const off = buildTranscript(header(), events, options({ thinking: false }))
    const on = buildTranscript(header(), events, options({ thinking: true }))
    expect(off.entries.find((entry) => entry.kind === 'assistant').parts.map((part) => part.type)).toEqual(['text'])
    expect(on.entries.find((entry) => entry.kind === 'assistant').parts.map((part) => part.type)).toEqual(['reasoning', 'text'])
    expect(on.meta.counts.reasoningBlocks).toBe(1)
  })

  it('drops tool entries when tools are disabled', () => {
    resetClock()
    const events = [turnStart(0, 1), toolCallEvent(1, 'call-1', 'bash'), toolResultEvent(2, 'call-1', 'ok')]
    const transcript = buildTranscript(header(), events, options({ tools: false }))
    expect(transcript.entries.filter((entry) => entry.kind === 'tool')).toHaveLength(1)
    expect(transcript.meta.options.tools).toBe(false)
  })

  it('hides injected messages unless asked, and labels their origin', () => {
    resetClock()
    const events = [turnStart(0, 1), injectedMessage(1, 'inj', [text('reminder')])]
    expect(buildTranscript(header(), events, options()).entries.filter((entry) => entry.kind === 'user')).toHaveLength(0)
    const shown = buildTranscript(header(), events, options({ injected: true }))
    const user = shown.entries.find((entry) => entry.kind === 'user')
    expect(user.human).toBe(false)
    expect(user.origin).toBe('plugin:demo')
    expect(shown.meta.counts.injectedMessages).toBe(1)
  })

  it('includes system messages by default and drops them when asked', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      event(1, 'system/message', { turn: 1, step: 1, message: { content: [text('prompt')] } }, { surfaceOp: 'append' }),
    ]
    const hasSystem = (transcript) => transcript.entries.some((entry) => entry.kind === 'system')
    expect(hasSystem(buildTranscript(header(), events, options()))).toBe(true)
    expect(hasSystem(buildTranscript(header(), events, options({ system: false })))).toBe(false)
  })

  it('sums usage across assistant messages', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      assistantMessage(1, [text('a')], { usage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 } }),
      assistantMessage(2, [text('b')], { usage: { inputTokens: 20, outputTokens: 2, cacheReadTokens: 5 } }),
    ]
    const transcript = buildTranscript(header(), events, options())
    expect(transcript.meta.usage.inputTokens).toBe(30)
    expect(transcript.meta.usage.outputTokens).toBe(3)
    expect(transcript.meta.usage.cacheReadTokens).toBe(5)
    // Token counts are disjoint, so a message that reports no `totalTokens`
    // contributes input + output + cache reads + cache writes.
    expect(transcript.meta.usage.totalTokens).toBe(11 + (20 + 2 + 5))
    expect(transcript.meta.usage.reportedSteps).toBe(2)
  })

  it('collects distinct models in first-use order', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      assistantMessage(1, [text('a')], { provider: 'p1', model: 'm1' }),
      assistantMessage(2, [text('b')], { provider: 'p2', model: 'm2' }),
      assistantMessage(3, [text('c')], { provider: 'p1', model: 'm1' }),
    ]
    expect(buildTranscript(header(), events, options()).meta.models).toEqual(['p1/m1', 'p2/m2'])
  })

  it('uses the last session title and falls back to the first human prompt', () => {
    resetClock()
    const titled = buildTranscript(header(), [event(0, 'session/title', { title: '第一次' }), event(1, 'session/title', { title: '第二次' })], options())
    expect(titled.meta.title).toBe('第二次')
    const untitled = buildTranscript(header(), [turnStart(0, 1), userMessage(1, 'm', [text('第一行\n第二行')])], options())
    expect(untitled.meta.title).toBe('第一行')
  })

  it('nests every message inside its turn, taken from turn/start', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      userMessage(1, 'a', [text('q1')]),
      assistantMessage(2, [text('a1')], { turn: 1 }),
      turnEnd(3, 1),
      turnStart(4, 2),
      userMessage(5, 'b', [text('q2')]),
      assistantMessage(6, [text('a2')], { turn: 2 }),
    ]
    const transcript = buildTranscript(header(), events, options())
    const users = transcript.entries.filter((entry) => entry.kind === 'user')
    expect(users.map((entry) => entry.turn)).toEqual([1, 2])
    expect(transcript.meta.counts.turns).toBe(2)
  })

  it('notes an abnormal turn end', () => {
    resetClock()
    const events = [turnStart(0, 1), turnEnd(1, 1, 'max-tokens')]
    const notes = buildTranscript(header(), events, options()).entries.filter((entry) => entry.kind === 'note')
    expect(notes).toHaveLength(1)
    expect(notes[0].text).toContain('max-tokens')
    expect(notes[0].level).toBe('warn')
  })

  it('uses only the current surface when scope is surface', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      userMessage(1, 'a', [text('原始提问')]),
      assistantMessage(2, [text('原始回答')]),
      userMessage(3, 'summary', [text('压缩后的摘要')], { kind: 'plugin', plugin: 'compaction' }),
      turnStart(4, 2),
      assistantMessage(5, [text('压缩后继续')]),
    ]
    events[3].surfaceOp = { op: 'replace', startSeq: 1, endSeq: 2 }
    const full = buildTranscript(header(), events, options({ scope: 'full', injected: true }))
    const surface = buildTranscript(header(), events, options({ scope: 'surface', injected: true }))
    const textsOf = (transcript) =>
      transcript.entries
        .filter((entry) => entry.kind === 'user' || entry.kind === 'assistant')
        .flatMap((entry) => entry.parts.map((part) => part.text))
    expect(textsOf(full)).toContain('原始提问')
    expect(textsOf(surface)).not.toContain('原始提问')
    expect(textsOf(surface)).toContain('压缩后的摘要')
    expect(textsOf(surface)).toContain('压缩后继续')
  })

  it('keeps a compacted prompt out of the surface even when the inbox still carries it', () => {
    resetClock()
    // The inbox records a prompt before the boundary it belongs to, and the
    // prompt then lands as its own `user/message`. Compaction shadows the
    // event, but the spliced record carries no surface op of its own - so
    // without an id-level check the prompt comes straight back.
    const events = [
      turnStart(0, 1),
      spliced(1, [insertedMessage('a', [text('原始提问')])]),
      userMessage(2, 'a', [text('原始提问')]),
      assistantMessage(3, [text('原始回答')]),
      userMessage(4, 'summary', [text('压缩后的摘要')], { kind: 'plugin', plugin: 'compaction' }),
      turnStart(5, 2),
      assistantMessage(6, [text('压缩后继续')]),
    ]
    // Both anchors must be surface nodes: the spliced record at seq 1 carries no
    // surface op, so a window starting there would be skipped defensively.
    events[4].surfaceOp = { op: 'replace', startSeq: 2, endSeq: 3 }
    const textsOf = (transcript) =>
      transcript.entries
        .filter((entry) => entry.kind === 'user' || entry.kind === 'assistant')
        .flatMap((entry) => entry.parts.map((part) => part.text))
    const full = buildTranscript(header(), events, options({ scope: 'full', injected: true }))
    const surface = buildTranscript(header(), events, options({ scope: 'surface', injected: true }))
    expect(textsOf(full)).toContain('原始提问')
    expect(textsOf(surface)).not.toContain('原始提问')
    expect(textsOf(surface)).toContain('压缩后的摘要')
    expect(textsOf(surface)).toContain('压缩后继续')
  })

  it('still surfaces a spliced prompt that compaction left alone', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      spliced(1, [insertedMessage('a', [text('保留的提问')])]),
      userMessage(2, 'a', [text('保留的提问')]),
      turnStart(3, 2),
      assistantMessage(4, [text('回答')]),
    ]
    const surface = buildTranscript(header(), events, options({ scope: 'surface' }))
    const texts = surface.entries.filter((entry) => entry.kind === 'user').flatMap((entry) => entry.parts.map((part) => part.text))
    expect(texts).toContain('保留的提问')
  })

  it('counts every distinct attachment once and reports its reference', () => {
    resetClock()
    const shared = image('sha256:same', { name: 'same.png' })
    const events = [
      turnStart(0, 1),
      userMessage(1, 'a', [shared]),
      assistantMessage(2, [shared, image('sha256:other', { name: 'other.png' })]),
    ]
    const transcript = buildTranscript(header(), events, options())
    expect(transcript.meta.counts.images).toBe(2)
    const sink = { images: new Map(), files: new Map() }
    buildTranscript(header(), events, options(), sink)
    expect(sink.images.size).toBe(2)
  })

  it('truncates a huge tool result and keeps the sizes', () => {
    resetClock()
    const body = 'x'.repeat(50_000)
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'bash'), toolResultEvent(2, 'c', body)]
    const transcript = buildTranscript(header(), events, options({ toolResultLimit: 100 }))
    const tool = transcript.entries.find((entry) => entry.kind === 'tool')
    expect(tool.result.truncated).toBe(true)
    expect(tool.result.totalChars).toBe(50_000)
    expect(tool.result.text.length).toBeLessThanOrEqual(100)
  })

  it('marks a failed tool result', () => {
    resetClock()
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'bash'), toolResultEvent(2, 'c', 'boom', { isError: true })]
    const tool = buildTranscript(header(), events, options()).entries.find((entry) => entry.kind === 'tool')
    expect(tool.result.isError).toBe(true)
  })

  it('sorts entries by seq even when a pass appends late', () => {
    resetClock()
    const events = [turnStart(0, 1), assistantMessage(1, [toolCall('orphan', 'bash')]), assistantMessage(5, [text('later')])]
    const transcript = buildTranscript(header(), events, options())
    const seqs = transcript.entries.map((entry) => entry.seq)
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs)
  })

  it('places a next-turn inbox message after the turn heading it opens', () => {
    resetClock()
    const events = [
      event(0, 'agent/inbox/spliced', { target: 'next-turn', inserted: [insertedMessage('queued', [text('排队中的提问')])] }),
      turnStart(1, 1),
      stepStart(2, 1, 1),
    ]
    const transcript = buildTranscript(header(), events, options())
    const kinds = transcript.entries.map((entry) => entry.kind)
    expect(kinds.indexOf('turn')).toBeLessThan(kinds.indexOf('user'))
    const user = transcript.entries.find((entry) => entry.kind === 'user')
    expect(user.parts[0].text).toBe('排队中的提问')
    expect(user.seq).toBe(1)
  })

  it('places a next-step inbox message after the step it belongs to', () => {
    resetClock()
    const events = [
      turnStart(0, 1),
      stepStart(1, 1, 1),
      event(2, 'agent/inbox/spliced', { target: 'next-step', inserted: [insertedMessage('s', [text('下一步注入')])] }),
      stepStart(3, 1, 2),
    ]
    const transcript = buildTranscript(header(), events, options({ injected: true }))
    const user = transcript.entries.find((entry) => entry.kind === 'user')
    expect(user.seq).toBe(3)
  })

  it('still emits a queued inbox message when its boundary never arrives', () => {
    resetClock()
    const events = [turnStart(0, 1), event(1, 'agent/inbox/spliced', { target: 'next-turn', inserted: [insertedMessage('tail', [text('收尾')])] })]
    const transcript = buildTranscript(header(), events, options({ injected: true }))
    expect(transcript.entries.filter((entry) => entry.kind === 'user')).toHaveLength(1)
  })

  it('never reports an assistant step with nothing to show', () => {
    resetClock()
    const events = [turnStart(0, 1), assistantMessage(1, [reasoning('只有思考')]), assistantMessage(2, [text('有正文')])]
    const transcript = buildTranscript(header(), events, options({ thinking: false }))
    const assistants = transcript.entries.filter((entry) => entry.kind === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0].parts[0].text).toBe('有正文')
    // Only rendered rows are counted as messages; every step is still counted.
    expect(transcript.meta.counts.assistantMessages).toBe(1)
    expect(transcript.meta.counts.assistantSteps).toBe(2)
  })

  it('produces no user entry for a message with no renderable parts', () => {
    resetClock()
    const events = [turnStart(0, 1), userMessage(1, 'empty', [])]
    expect(buildTranscript(header(), events, options()).entries.filter((entry) => entry.kind === 'user')).toHaveLength(0)
  })

  it('handles an empty log and a missing header', () => {
    const transcript = buildTranscript(undefined, [], options())
    expect(transcript.entries).toEqual([])
    expect(transcript.meta.sessionId).toBe('')
    expect(transcript.meta.title).toBe('')
  })

  it('walks the whole sample session without losing a message', () => {
    const { header: sessionHeader, events } = sampleSession()
    const transcript = buildTranscript(sessionHeader, events, options({ thinking: true, injected: true, system: true }))
    const users = transcript.entries.filter((entry) => entry.kind === 'user')
    // msg-1 (also spliced), inject-1, and the spliced-only message.
    expect(users).toHaveLength(3)
    expect(users.map((entry) => entry.id).sort()).toEqual(['inject-1', 'msg-1', 'spliced-only'])
    expect(transcript.meta.title).toBe('示例会话')
    expect(transcript.meta.counts.turns).toBe(3)
    expect(transcript.meta.counts.toolCalls).toBe(1)
    expect(transcript.meta.counts.reasoningBlocks).toBe(1)
    expect(transcript.meta.counts.images).toBe(1)
    expect(transcript.meta.counts.systems).toBe(1)
  })
})

describe('collectAttachmentsOf', () => {
  it('finds attachments in direct content, messages, and spliced inserts', () => {
    const events = [
      event(0, 'tool/result', { message: { content: [image('sha256:a')] } }),
      spliced(1, [insertedMessage('m', [image('sha256:b')])]),
      event(2, 'assistant/message', { message: { content: [image('sha256:c')] } }),
    ]
    const found = collectAttachmentsOf(events)
    expect([...found.images.keys()].length).toBe(3)
  })

  it('finds an attachment inside a compacted stream block', () => {
    const events = [
      event(0, 'assistant/attempt', {
        stream: [{ type: 'chunk', chunk: { type: 'block-end', block: image('sha256:stream') } }],
      }),
    ]
    expect(collectAttachmentsOf(events).images.size).toBe(1)
  })

  it('de-duplicates the same attachment referenced twice', () => {
    const events = [event(0, 'user/message', { content: [image('sha256:s')] }), event(1, 'user/message', { content: [image('sha256:s')] })]
    expect(collectAttachmentsOf(events).images.size).toBe(1)
  })
})
