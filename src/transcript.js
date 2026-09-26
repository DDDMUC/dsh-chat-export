// dsh-chat-export - session events to a readable transcript model.
//
// This module is the whole correctness story of the plugin, and it is pure:
// it takes the session header plus the raw v3 event log and returns a plain
// object that both renderers consume. Nothing here touches a host service, the
// filesystem, or the network, so every rule below is unit-tested directly.
//
// Rules that were established by reading real logs rather than the type
// declarations, each of which silently loses content when ignored:
//
//   1. A session artifact is multi-frame Zstandard; only the host persistence
//      read or the `zstd` module here can see past the first frame.
//   2. `user/message` carries no `turn`/`step`, so turns come from `turn/start`.
//   3. `agent/inbox/spliced.data.inserted[]` can hold the ONLY copy of a user
//      message (6 such messages in the 9.6 MB reference session), so inserted
//      messages are merged by durable message id, not ignored.
//   4. Reasoning is a content block, not an event type.
//   5. Tool calls are recorded twice - inside the assistant message and as
//      `tool/call` events - so only one of them is rendered.

/**
 * The durable message id an event carries, whichever shape it uses.
 *
 * `user/message` keeps the message inline while `assistant/message` wraps it in
 * `message`, and the two spellings are the reason this is a function rather than
 * a property read.
 *
 * @param event - one raw session event.
 * @returns the message id, or undefined when the event carries none.
 */
export function durableMessageId(event) {
  const data = event?.data ?? {}
  if (event?.type === 'user/message') return typeof data.id === 'string' ? data.id : undefined
  if (event?.type === 'assistant/message') {
    const id = data.message?.id
    return typeof id === 'string' ? id : undefined
  }
  return undefined
}

/** Event types that participate in the model-visible surface. */
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/** Source kinds that mean "a human typed this". */
const HUMAN_SOURCE_KINDS = new Set(['user'])

/** Message roles accepted from `agent/inbox/spliced.inserted[]`. */
const SPLICED_ROLES = new Set(['user'])

/**
 * Replay the official surface operations of a complete log.
 *
 * Mirrors the host fold: `append` pushes the event onto the tail; a `replace`
 * swaps the inclusive window between its two surface nodes for the replacing
 * event. Replacements whose anchors are gone are skipped defensively.
 *
 * @param events - contiguous raw event log in seq order.
 * @returns `{ nodes, replacements, shadowed }` where `shadowed` is the set of
 *   seqs no longer in the current model surface.
 */
export function foldSurface(events) {
  const nodes = []
  const replacements = []
  const shadowed = new Set()
  for (const event of events) {
    const op = event.surfaceOp
    if (op === undefined) continue
    if (op === 'append') {
      nodes.push(event.seq)
      continue
    }
    if (op === null || typeof op !== 'object' || op.op !== 'replace') continue
    const startIdx = nodes.indexOf(op.startSeq)
    const endIdx = nodes.indexOf(op.endSeq)
    if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) continue
    const removed = nodes.slice(startIdx, endIdx + 1)
    for (const seq of removed) shadowed.add(seq)
    nodes.splice(startIdx, endIdx - startIdx + 1, event.seq)
    replacements.push({ seq: event.seq, startSeq: op.startSeq, endSeq: op.endSeq, shadowed: removed })
  }
  return { nodes, replacements, shadowed }
}

/** Narrow a message content value to an array. */
function contentOf(value) {
  return Array.isArray(value) ? value : []
}

/** Whether one content block is a tool-result carrier. */
function isToolResultBlock(block) {
  return block !== null && typeof block === 'object' && block.type === 'tool-result'
}

/**
 * Extract the text, error flag, and nested image references of a tool result.
 * @param content - the `content` array of one `tool-result` block.
 * @returns `{ text, images, isError }`.
 */
export function readToolResultContent(content) {
  const chunks = []
  const images = []
  const walk = (blocks) => {
    for (const block of contentOf(blocks)) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'text') chunks.push(String(block.text ?? ''))
      else if (block.type === 'image' && block.attachment) images.push(block.attachment)
      else if (block.type === 'file' && block.attachment) images.push(block.attachment)
      else if (Array.isArray(block.content)) walk(block.content)
    }
  }
  walk(content)
  return { text: chunks.join('\n'), images }
}

/**
 * Shorten a long body at a line boundary so a transcript stays readable.
 * @param text - the full body.
 * @param limit - maximum characters to keep; `0` disables the limit.
 * @returns `{ text, truncated, totalChars, totalLines, keptLines }`.
 */
export function truncateBody(text, limit) {
  const value = String(text ?? '')
  const totalChars = value.length
  const totalLines = value === '' ? 0 : value.split('\n').length
  if (limit <= 0 || totalChars <= limit) {
    return { text: value, truncated: false, totalChars, totalLines, keptLines: totalLines }
  }
  const head = value.slice(0, limit)
  const cut = head.lastIndexOf('\n')
  const kept = cut > limit * 0.5 ? head.slice(0, cut) : head
  return {
    text: kept,
    truncated: true,
    totalChars,
    totalLines,
    keptLines: kept === '' ? 0 : kept.split('\n').length,
  }
}

/** Message id of one event, across the carriers that carry one. */
function messageIdOf(event) {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (event.type === 'user/message') return typeof data.id === 'string' ? data.id : undefined
  const message = data.message
  return message !== null && typeof message === 'object' && typeof message.id === 'string' ? message.id : undefined
}

/** Turn an attachment reference into a stable identity for de-duplication. */
export function attachmentKey(ref) {
  return `${String(ref.attachmentId)}\u0000${String(ref.name ?? '')}`
}

/**
 * Collect every attachment reference one event names.
 *
 * The scan mirrors the host's own archive walk so an export cannot miss an
 * image that the official ZIP would have included: direct `content`, a
 * `message.content`, spliced `inserted[]` messages, and completed blocks inside
 * a compacted `stream`.
 *
 * @param event - one raw session event.
 * @param into - `{ images: Map, files: Map }` accumulators.
 */
export function collectAttachments(event, into) {
  const walk = (blocks) => {
    for (const block of contentOf(blocks)) {
      if (block === null || typeof block !== 'object') continue
      if (block.type === 'image' && block.attachment) into.images.set(attachmentKey(block.attachment), block.attachment)
      else if (block.type === 'file' && block.attachment) into.files.set(attachmentKey(block.attachment), block.attachment)
      if (Array.isArray(block.content)) walk(block.content)
    }
  }
  const data = event.data
  if (data === null || typeof data !== 'object') return into
  walk(data.content)
  if (data.message !== null && typeof data.message === 'object') walk(data.message.content)
  if (Array.isArray(data.inserted)) for (const message of data.inserted) walk(message?.content)
  if (Array.isArray(data.stream)) {
    for (const record of data.stream) {
      if (record?.type === 'chunk' && record.chunk?.type === 'block-end') walk([record.chunk.block])
    }
  }
  return into
}

/** Collect every attachment reference across a whole log. */
export function collectAttachmentsOf(events) {
  const into = { images: new Map(), files: new Map() }
  for (const event of events) collectAttachments(event, into)
  return into
}

/** Convert one message content array into renderable parts. */
function partsOfContent(content, options, attachmentSink) {
  const parts = []
  for (const block of contentOf(content)) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text') {
      const text = String(block.text ?? '')
      if (text !== '') parts.push({ type: 'text', text })
      continue
    }
    if (block.type === 'reasoning') {
      if (!options.thinking) continue
      const text = String(block.text ?? '')
      if (text !== '') parts.push({ type: 'reasoning', text })
      continue
    }
    if (block.type === 'image' && block.attachment) {
      attachmentSink.images.set(attachmentKey(block.attachment), block.attachment)
      parts.push({ type: 'image', ref: block.attachment })
      continue
    }
    if (block.type === 'file' && block.attachment) {
      attachmentSink.files.set(attachmentKey(block.attachment), block.attachment)
      parts.push({ type: 'file', ref: block.attachment })
      continue
    }
    if (block.type === 'tool-result') {
      const nested = readToolResultContent(block.content)
      for (const ref of nested.images) {
        attachmentSink.images.set(attachmentKey(ref), ref)
        parts.push({ type: 'image', ref })
      }
      continue
    }
  }
  return parts
}

/** Whether one message source came from a human typing. */
function isHumanSource(source) {
  const kind = source !== null && typeof source === 'object' ? source.kind : undefined
  return kind === undefined || kind === null || HUMAN_SOURCE_KINDS.has(kind)
}

/** A short human label for one injected message's producer. */
function originOf(source) {
  if (source === null || typeof source !== 'object') return ''
  const kind = String(source.kind ?? '')
  const detail = source.plugin ?? source.form ?? source.rpcId
  return detail === undefined ? kind : `${kind}:${String(detail)}`
}

/** `provider/model` for one assistant message, or an empty string. */
function modelOf(message) {
  const source = message !== null && typeof message === 'object' ? message.source : undefined
  if (source === null || typeof source !== 'object') return ''
  const provider = source.provider === undefined ? '' : String(source.provider)
  const model = source.model === undefined ? '' : String(source.model)
  if (provider === '' && model === '') return ''
  return provider === '' ? model : `${provider}/${model}`
}

/**
 * Build the readable transcript model for one session.
 *
 * @param header - the session header (`{id, createdAt, cwd, ...}`), or `undefined`.
 * @param events - the complete raw event log in seq order.
 * @param options - resolved export options (see `defaultOptions`).
 * @param attachmentSink - optional accumulator that receives every referenced
 *   attachment, used by the host half to know which bytes to load.
 * @returns the transcript model consumed by the Markdown and HTML renderers.
 */
export function buildTranscript(header, events, options, attachmentSink = { images: new Map(), files: new Map() }) {
  const log = Array.isArray(events) ? events : []
  const surface = options.scope === 'surface' ? foldSurface(log) : undefined

  const droppedBySurface = (event) => surface !== undefined && SURFACE_TYPES.has(event.type) && surface.shadowed.has(event.seq)

  // Ids of messages a surface replacement removed. The durable message id is the
  // join key between a `user/message` event and the inbox's spliced copy of the
  // same message, and only the event carries a surface op - so without this set
  // a compacted-away prompt comes straight back in through the spliced record.
  const shadowedMessageIds = new Set()
  if (surface !== undefined) {
    for (const event of log) {
      if (!surface.shadowed.has(event.seq)) continue
      const id = durableMessageId(event)
      if (id !== undefined) shadowedMessageIds.add(id)
    }
  }

  const callIdsDeclared = new Set()
  for (const event of log) {
    if (event.type === 'tool/call' && typeof event.data?.callId === 'string') callIdsDeclared.add(event.data.callId)
  }

  const entries = []
  const toolsByCallId = new Map()
  const seenMessageIds = new Set()
  const seenAttachmentKeys = new Set()

  const counts = {
    turns: 0,
    steps: 0,
    userMessages: 0,
    humanMessages: 0,
    injectedMessages: 0,
    /** Assistant rows actually rendered; see `assistantSteps` for the raw count. */
    assistantMessages: 0,
    /** Every assistant step in the log, including steps with nothing to render. */
    assistantSteps: 0,
    toolCalls: 0,
    reasoningBlocks: 0,
    images: 0,
    files: 0,
    systems: 0,
    notes: 0,
  }
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    reportedSteps: 0,
  }
  const models = []
  const engines = new Set()

  let title = ''
  let updatedAt = header !== undefined && typeof header.createdAt === 'number' ? header.createdAt : 0
  let currentTurn = null
  let turnEntry = null
  let retriesInTurn = 0
  const stepStarts = new Map()

  const note = (event, text, level = 'info') => {
    counts.notes += 1
    entries.push({ kind: 'note', at: Number(event.time ?? 0), seq: event.seq, text, level })
  }

  const noteAttachment = (part) => {
    if (part.type === 'image' || part.type === 'file') {
      const key = attachmentKey(part.ref)
      if (seenAttachmentKeys.has(key)) return
      seenAttachmentKeys.add(key)
      if (part.type === 'image') counts.images += 1
      else counts.files += 1
    }
  }

  const pushUserEntry = (event, message, human) => {
    if (options.userInput === false) return
    const id = typeof message.id === 'string' ? message.id : undefined
    if (id !== undefined) {
      // Surface mode drops what the model can no longer see, whichever route
      // the message arrives by.
      if (shadowedMessageIds.has(id)) return
      if (seenMessageIds.has(id)) return
      seenMessageIds.add(id)
    }
    const source = message.source
    const parts = partsOfContent(message.content, options, attachmentSink)
    if (parts.length === 0) return
    counts.userMessages += 1
    if (human) counts.humanMessages += 1
    else counts.injectedMessages += 1
    for (const part of parts) noteAttachment(part)
    entries.push({
      kind: 'user',
      at: Number(event.time ?? 0),
      seq: event.seq,
      id,
      human,
      sourceKind: source !== null && typeof source === 'object' ? String(source.kind ?? 'user') : 'user',
      origin: human ? '' : originOf(source),
      turn: currentTurn,
      parts,
    })
  }

  /** Inbox messages waiting for the boundary their `target` names. */
  let pendingInserted = []

  /**
   * Release queued inbox messages at the boundary they belong to.
   *
   * The entry keeps the moment the message was written but adopts the boundary's
   * seq, which is what keeps the final seq sort from lifting it back above the
   * heading it opens.
   *
   * @param boundarySeq - seq of the releasing `turn/start` or `step/start`.
   * @param onlyTarget - when set, release just this target; otherwise release all.
   */
  const flushInserted = (boundarySeq, onlyTarget) => {
    if (pendingInserted.length === 0) return
    const remaining = []
    for (const item of pendingInserted) {
      if (onlyTarget !== undefined && item.target !== onlyTarget) {
        remaining.push(item)
        continue
      }
      pushUserEntry({ seq: boundarySeq, time: item.at }, item.message, item.human)
    }
    pendingInserted = remaining
  }

  for (const event of log) {
    const time = Number(event.time ?? 0)
    if (time > updatedAt) updatedAt = time
    const data = event.data

    if (event.type === 'turn/start') {
      currentTurn = typeof data?.turn === 'number' ? data.turn : null
      counts.turns += 1
      turnEntry = {
        kind: 'turn',
        index: currentTurn,
        at: time,
        // `seq` keeps the whole entry list sortable by one key; `startSeq` and
        // `endSeq` are the turn's real window in the log.
        seq: event.seq,
        startSeq: event.seq,
        endSeq: null,
        durationMs: null,
        reason: null,
      }
      entries.push(turnEntry)
      flushInserted(event.seq)
      continue
    }

    if (event.type === 'turn/end') {
      const reason = data?.reason !== null && typeof data?.reason === 'object' ? String(data.reason.kind ?? '') : ''
      if (retriesInTurn > 0) {
        note(event, `本回合模型请求重试 ${retriesInTurn} 次`, 'warn')
        retriesInTurn = 0
      }
      if (turnEntry !== null && turnEntry.endSeq === null) {
        turnEntry.endSeq = event.seq
        turnEntry.durationMs = time - turnEntry.at
        turnEntry.reason = reason
      }
      if (reason !== '' && reason !== 'completed') note(event, `回合 ${currentTurn ?? '?'} 结束：${reason}`, 'warn')
      continue
    }

    if (event.type === 'step/start') {
      counts.steps += 1
      stepStarts.set(`${data?.turn}:${data?.step}`, time)
      flushInserted(event.seq, 'next-step')
      continue
    }

    if (event.type === 'session/title') {
      if (typeof data?.title === 'string' && data.title !== '') title = data.title
      continue
    }

    if (event.type === 'user/message') {
      if (droppedBySurface(event)) continue
      const human = isHumanSource(data?.source)
      if (!human && options.injected !== true) continue
      pushUserEntry(event, data ?? {}, human)
      continue
    }

    if (event.type === 'agent/inbox/spliced') {
      // Inserted messages are the inbox's own record of a user turn. Most also
      // land as their own `user/message` event, but not all of them do, so the
      // durable message id is the de-duplication key rather than the event.
      //
      // They are also recorded BEFORE the boundary they belong to (`target`
      // names the next turn or the next step), so they are queued here and
      // released at that boundary; emitting them at their own seq would put a
      // prompt above the turn heading it opens.
      for (const message of Array.isArray(data?.inserted) ? data.inserted : []) {
        if (message === null || typeof message !== 'object') continue
        if (!SPLICED_ROLES.has(String(message.role ?? ''))) continue
        const human = isHumanSource(message.source)
        if (!human && options.injected !== true) continue
        pendingInserted.push({ message, human, at: time, target: String(data?.target ?? '') })
      }
      continue
    }

    if (event.type === 'assistant/message') {
      if (droppedBySurface(event)) continue
      if (options.modelOutput === false) continue
      const message = data?.message ?? {}
      const parts = partsOfContent(message.content, options, attachmentSink)
      const messageUsage = data?.usage
      if (messageUsage !== null && typeof messageUsage === 'object') {
        usage.inputTokens += Number(messageUsage.inputTokens ?? 0)
        usage.outputTokens += Number(messageUsage.outputTokens ?? 0)
        usage.cacheReadTokens += Number(messageUsage.cacheReadTokens ?? 0)
        usage.cacheWriteTokens += Number(messageUsage.cacheWriteTokens ?? 0)
        usage.reasoningTokens += Number(messageUsage.reasoningTokens ?? 0)
        usage.totalTokens += Number(
          messageUsage.totalTokens ??
            Number(messageUsage.inputTokens ?? 0) +
              Number(messageUsage.outputTokens ?? 0) +
              Number(messageUsage.cacheReadTokens ?? 0) +
              Number(messageUsage.cacheWriteTokens ?? 0),
        )
        usage.reportedSteps += 1
      }
      const model = modelOf(message)
      if (model !== '' && !engines.has(model)) {
        engines.add(model)
        models.push(model)
      }
      for (const part of parts) {
        if (part.type === 'image' || part.type === 'file') noteAttachment(part)
        if (part.type === 'reasoning') counts.reasoningBlocks += 1
      }
      counts.assistantSteps += 1
      // A step that produced only reasoning or only tool calls has nothing to
      // say in a transcript that excludes those parts. Keeping the heading
      // would produce a wall of empty "assistant" sections (974 of them in the
      // reference session), so such a step is dropped and the tool block that
      // follows stands on its own.
      if (parts.length === 0) continue
      counts.assistantMessages += 1
      const stepKey = `${data?.turn}:${data?.step}`
      const stepStart = stepStarts.get(stepKey)
      entries.push({
        kind: 'assistant',
        at: time,
        seq: event.seq,
        turn: typeof data?.turn === 'number' ? data.turn : currentTurn,
        step: typeof data?.step === 'number' ? data.step : null,
        model,
        usage: messageUsage ?? null,
        interrupted: data?.interrupted === true,
        latencyMs: stepStart === undefined ? null : time - stepStart,
        parts,
      })
      continue
    }

    if (event.type === 'tool/call') {
      const callId = String(data?.callId ?? '')
      counts.toolCalls += 1
      const entry = {
        kind: 'tool',
        at: time,
        seq: event.seq,
        callId,
        name: String(data?.name ?? 'tool'),
        arguments: String(data?.arguments ?? ''),
        turn: typeof data?.turn === 'number' ? data.turn : currentTurn,
        step: typeof data?.step === 'number' ? data.step : null,
        result: null,
        durationMs: null,
        synthetic: false,
      }
      toolsByCallId.set(callId, entry)
      entries.push(entry)
      continue
    }

    if (event.type === 'tool/result') {
      if (droppedBySurface(event)) continue
      const message = data?.message ?? {}
      const callId = String(message?.source?.callId ?? '')
      let entry = toolsByCallId.get(callId)
      if (entry === undefined) {
        // A result without a recorded call still belongs in the transcript;
        // dropping it would hide real work the model can still see.
        entry = {
          kind: 'tool',
          at: time,
          seq: event.seq,
          callId,
          name: 'tool',
          arguments: '',
          turn: typeof data?.turn === 'number' ? data.turn : currentTurn,
          step: typeof data?.step === 'number' ? data.step : null,
          result: null,
          durationMs: null,
          synthetic: true,
        }
        toolsByCallId.set(callId, entry)
        entries.push(entry)
      }
      const blocks = contentOf(message.content).filter(isToolResultBlock)
      const bodies = blocks.map((block) => readToolResultContent(block.content))
      const joined = bodies.map((body) => body.text).filter((text) => text !== '').join('\n')
      const images = bodies.flatMap((body) => body.images)
      const shortened = truncateBody(joined, options.toolResultLimit)
      for (const ref of images) {
        attachmentSink.images.set(attachmentKey(ref), ref)
        const key = attachmentKey(ref)
        if (!seenAttachmentKeys.has(key)) {
          seenAttachmentKeys.add(key)
          counts.images += 1
        }
      }
      const failure = data?.error
      entry.result = {
        text: shortened.text,
        truncated: shortened.truncated,
        totalChars: shortened.totalChars,
        totalLines: shortened.totalLines,
        isError: blocks.some((block) => block.isError === true) || (failure !== null && failure !== undefined),
        errorName: failure !== null && typeof failure === 'object' ? String(failure.name ?? '') : '',
        images,
      }
      entry.durationMs = time - entry.at
      continue
    }

    if (event.type === 'system/message') {
      if (!options.system) continue
      if (droppedBySurface(event)) continue
      const message = data?.message ?? {}
      const parts = partsOfContent(message.content, options, attachmentSink)
      const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      if (text === '') continue
      counts.systems += 1
      entries.push({
        kind: 'system',
        at: time,
        seq: event.seq,
        turn: typeof data?.turn === 'number' ? data.turn : currentTurn,
        step: typeof data?.step === 'number' ? data.step : null,
        text,
      })
      continue
    }

    if (event.type === 'compaction/start') {
      note(event, '上下文压缩开始', 'info')
      continue
    }
    if (event.type === 'compaction/summary') {
      note(event, '上下文压缩：生成了摘要', 'info')
      continue
    }
    if (event.type === 'compaction/end') {
      note(event, '上下文压缩结束', 'info')
      continue
    }
    if (event.type === 'compaction/prune') {
      note(event, '压缩裁剪了一部分工具结果', 'info')
      continue
    }
    if (event.type === 'llm/retry') {
      // Counted, not printed: a flaky provider turns one bad minute into
      // dozens of identical lines. The turn gets a single summary instead.
      retriesInTurn += 1
      continue
    }
    if (event.type === 'model/selection' && typeof data?.model === 'string') {
      const model = data.provider === undefined ? data.model : `${data.provider}/${data.model}`
      if (!engines.has(model)) {
        engines.add(model)
        models.push(model)
      }
      continue
    }
  }

  // Anything still queued belongs to a boundary the log never reached (the
  // session simply ended); it is still part of the conversation.
  if (pendingInserted.length > 0) {
    const lastSeq = log.length > 0 ? log[log.length - 1].seq : 0
    flushInserted(lastSeq)
  }

  // A tool-call content block whose own `tool/call` event never landed is still
  // real work; render it so the transcript never silently drops a call.
  for (const event of log) {
    if (event.type !== 'assistant/message') continue
    if (droppedBySurface(event)) continue
    const content = contentOf(event.data?.message?.content)
    for (const block of content) {
      if (block?.type !== 'tool-call') continue
      const callId = String(block.id ?? '')
      if (callId === '' || toolsByCallId.has(callId)) continue
      const entry = {
        kind: 'tool',
        at: Number(event.time ?? 0),
        seq: event.seq,
        callId,
        name: String(block.name ?? 'tool'),
        arguments: String(block.arguments ?? ''),
        turn: typeof event.data?.turn === 'number' ? event.data.turn : currentTurn,
        step: typeof event.data?.step === 'number' ? event.data.step : null,
        result: null,
        durationMs: null,
        synthetic: true,
      }
      toolsByCallId.set(callId, entry)
      counts.toolCalls += 1
      entries.push(entry)
    }
  }

  // Order by seq only. Array#sort is stable, so entries that deliberately share
  // a seq (a turn heading and the inbox message it opens, or an assistant step
  // and a tool call recovered from its content) keep insertion order instead of
  // being reordered by their timestamps.
  entries.sort((left, right) => left.seq - right.seq)

  if (title === '') {
    const firstHuman = entries.find((entry) => entry.kind === 'user' && entry.human)
    if (firstHuman !== undefined) {
      const text = firstHuman.parts.find((part) => part.type === 'text')
      if (text !== undefined) title = text.text.split('\n')[0].slice(0, 80)
    }
  }

  return {
    meta: {
      sessionId: header !== undefined && typeof header.id === 'string' ? header.id : '',
      title,
      cwd: header !== undefined && typeof header.cwd === 'string' ? header.cwd : '',
      version: header !== undefined && typeof header.version === 'number' ? header.version : 3,
      agentPreset: header !== undefined && typeof header.agentPreset === 'string' ? header.agentPreset : '',
      createdAt: header !== undefined && typeof header.createdAt === 'number' ? header.createdAt : 0,
      updatedAt,
      models,
      usage,
      counts,
      scope: options.scope,
      options,
    },
    entries,
  }
}

/** Count the entries of one kind. */
export function countEntries(transcript, kind) {
  return transcript.entries.filter((entry) => entry.kind === kind).length
}
