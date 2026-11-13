// dsh-chat-export - read a DeepSeek chat export (`deepseek_data-*.zip`).
//
// The archive is the one chat.deepseek.com hands out:
//
//   manifest.json              { export_format_version: 3 }
//   chat_session_index.json    [{ id, inserted_at, updated_at, ... }]
//   chat_sessions/{id}.json    { id, title, current_message_id, messages: [...] }
//
// A message is a node in a tree (`parent_id`), and `current_message_id` names
// the branch the website was showing. Fragments inside a message carry the
// actual content: the question, the answer, the thinking, the searches, the
// pages it opened.
//
// The mapping follows the official importer's semantics: one turn per question,
// a finished reply becomes one or more steps, a reply withdrawn by content
// filtering leaves with its question, and an unfinished reply ends its turn
// with an error instead of entering the history.

import { createHash } from 'node:crypto'

/** Image types the DeepSeek export can carry, by extension. */
const IMAGE_TYPES = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
])

/** The media type of an exported file, or undefined when it is not an image. */
export function mediaTypeOf(name) {
  const match = /\.([a-z0-9]+)$/iu.exec(String(name ?? ''))
  return match === null ? undefined : IMAGE_TYPES.get(match[1].toLowerCase())
}

/** The leaf of an exported file name, without control characters. */
export function fileDisplayName(name) {
  const text = String(name ?? '')
  const leaf = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/gu, '').trim()
  return clean.length === 0 ? 'file' : clean
}

/**
 * A reference for a file whose bytes are not stored: a non-image, or an image
 * the attachment store refused. The id is deterministic in the export's file
 * id, so re-importing the same archive yields the same reference.
 */
export function syntheticFileRef(file) {
  const digest = createHash('sha256').update(`deepseek-chat-export:${String(file?.id ?? '')}`).digest('hex')
  return {
    attachmentId: `sha256:${digest}`,
    name: fileDisplayName(file?.file_name),
    bytes: typeof file?.file_size === 'number' ? file.file_size : 0,
  }
}

/**
 * Every `FILE` entry of the branch that would be imported, so the host can
 * store its images before conversion runs.
 *
 * @param file - one conversation file.
 * @returns `[{ id, name, size, mediaType, exportPath, isImage }]`.
 */
export function fileEntriesOf(file) {
  const out = []
  for (const message of selectBranch(file)) {
    for (const fragment of message.fragments ?? []) {
      if (fragment?.type !== 'FILE') continue
      for (const entry of Array.isArray(fragment.files) ? fragment.files : []) {
        const name = fileDisplayName(entry?.file_name)
        const mediaType = entry?.is_image === true ? mediaTypeOf(name) : undefined
        out.push({
          id: String(entry?.id ?? ''),
          name,
          size: typeof entry?.file_size === 'number' ? entry.file_size : 0,
          mediaType,
          exportPath: typeof entry?.export_path === 'string' ? entry.export_path : undefined,
          isImage: mediaType !== undefined,
        })
      }
    }
  }
  return out
}

/** The only `manifest.json` version this reader understands. */
export const DEEPSEEK_EXPORT_VERSION = 3

/** Recorded on every assistant message this reader produces. */
const MODEL_SOURCE = { kind: 'model', provider: 'deepseek-chat-export', model: 'deepseek-chat-export' }

/** Statuses that end a reply unfinished, mapped to a stable code. */
const UNFINISHED = new Map([
  ['FAILED', 'DEEPSEEK_EXPORT_FAILED'],
  ['TIMEOUT', 'DEEPSEEK_EXPORT_TIMEOUT'],
  ['CONTEXT_LENGTH_EXCEEDED', 'DEEPSEEK_EXPORT_CONTEXT_LENGTH_EXCEEDED'],
  ['INCOMPLETE', 'DEEPSEEK_EXPORT_INCOMPLETE'],
  ['WIP', 'DEEPSEEK_EXPORT_WIP'],
])

/** Whether a ZIP is a DeepSeek export rather than one of this plugin's bundles. */
export function looksLikeDeepseekExport(entries) {
  const manifest = entries.get('manifest.json')
  if (manifest === undefined) return false
  try {
    return typeof JSON.parse(manifest.toString('utf8'))?.export_format_version === 'number'
  } catch {
    return false
  }
}

/** Parse an export timestamp into epoch milliseconds. */
function timeOf(value) {
  const time = Date.parse(String(value ?? ''))
  return Number.isSafeInteger(time) && time >= 0 ? time : undefined
}

/**
 * Read the archive's index and conversation files.
 *
 * @param entries - `Map<name, Buffer>` from `readZip`.
 * @returns `{ version, index, sessions }` where `sessions` maps id to file.
 * @throws when the manifest is missing or the version is not 3.
 */
export function readDeepseekExport(entries) {
  const manifestText = entries.get('manifest.json')
  if (manifestText === undefined) throw new Error('missing-manifest')
  let version
  try {
    version = JSON.parse(manifestText.toString('utf8'))?.export_format_version
  } catch {
    throw new Error('unreadable-archive')
  }
  if (version !== DEEPSEEK_EXPORT_VERSION) throw new Error(`unsupported-version:${String(version)}`)

  const indexText = entries.get('chat_session_index.json')
  if (indexText === undefined) throw new Error('missing-index')
  let index
  try {
    index = JSON.parse(indexText.toString('utf8'))
  } catch {
    throw new Error('missing-index')
  }
  if (!Array.isArray(index)) throw new Error('missing-index')

  const sessions = new Map()
  for (const [name, bytes] of entries) {
    const match = /^chat_sessions\/(.+)\.json$/u.exec(name)
    if (match === null) continue
    try {
      const file = JSON.parse(bytes.toString('utf8'))
      if (file !== null && typeof file === 'object' && Array.isArray(file.messages)) sessions.set(match[1], file)
    } catch {
      // A conversation file that does not parse is skipped, not fatal: the
      // index still names the others.
    }
  }
  return { version, index, sessions }
}

/**
 * The conversations to import, newest first.
 *
 * The index carries `updated_at`; a row without a usable time sorts last so it
 * cannot displace a dated one.
 *
 * @param index - the parsed `chat_session_index.json`.
 * @returns `[{ id, updatedAt }]`, newest first.
 */
export function rankSessions(index) {
  return (Array.isArray(index) ? index : [])
    .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string' && row.id !== '')
    .map((row) => ({ id: row.id, updatedAt: timeOf(row.updated_at) ?? timeOf(row.inserted_at) ?? 0 }))
    .sort((left, right) => right.updatedAt - left.updatedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
}

/**
 * The messages of the branch the website was showing: the path from the root to
 * `current_message_id`, or to the greatest id when that field is absent, null,
 * or names nothing. A child always has a greater id than its parent, so the
 * fallback is a leaf.
 *
 * @param file - one conversation file.
 * @returns messages from root to the selected one.
 */
export function selectBranch(file) {
  const byId = new Map()
  let newest
  for (const message of file.messages) {
    if (byId.has(message.id)) throw new Error(`duplicate message id ${message.id}`)
    byId.set(message.id, message)
    if (newest === undefined || message.id > newest.id) newest = message
  }
  if (newest === undefined) throw new Error('conversation has no messages')
  const current = file.current_message_id
  const selected = current === null || current === undefined ? undefined : byId.get(current)
  const chain = []
  let message = selected ?? newest
  for (;;) {
    if (chain.length === byId.size) throw new Error(`message ${message.id} is part of a parent cycle`)
    chain.push(message)
    if (message.parent_id === null) return chain.reverse()
    const parent = byId.get(message.parent_id)
    if (parent === undefined) throw new Error(`message parent ${message.parent_id} does not exist`)
    message = parent
  }
}

/** The text of one fragment, or '' when it carries none. */
function fragmentText(fragment) {
  return typeof fragment?.content === 'string' ? fragment.content : ''
}

/** `[title](url)` lines of one `READ_LINK` record. */
function linkLines(results) {
  const lines = []
  for (const result of Array.isArray(results) ? results : []) {
    const url = typeof result?.url === 'string' && result.url.trim() !== '' ? result.url : undefined
    const title = typeof result?.title === 'string' && result.title.trim() !== '' ? result.title : undefined
    if (url !== undefined) lines.push(`[${title ?? url}](${url})`)
    else if (title !== undefined) lines.push(title)
  }
  return lines.length === 0 ? undefined : lines.join('\n')
}

/**
 * Turn one conversation into the seed events this plugin's importer replays.
 *
 * @param file - one conversation file.
 * @param options - `{ createId, now?, title? }`.
 * @returns `{ header, events, title, warnings }`, ready for `planImport`.
 */
export function convertDeepseekSession(file, options = {}) {
  const createId = options.createId ?? (() => crypto.randomUUID())
  const chain = selectBranch(file)
  const events = []
  const warnings = []
  let time = 0

  const push = (type, data, surfaceOp) => {
    const event = { type, seq: events.length, time, data }
    if (surfaceOp !== undefined) event.surfaceOp = surfaceOp
    events.push(event)
  }
  const at = (value) => {
    time = Math.max(time, value)
  }
  // Images the host already stored, keyed by the export's file id. Anything
  // else becomes a card with no bytes, which is what the export itself holds
  // for a non-image: a name and a declared size.
  const images = options.images ?? new Map()
  const userMessage = (message) => {
    const texts = []
    const blocks = []
    for (const fragment of message.fragments ?? []) {
      if (fragment?.type === 'REQUEST') texts.push(fragmentText(fragment))
      else if (fragment?.type === 'FILE') {
        for (const entry of Array.isArray(fragment.files) ? fragment.files : []) {
          const stored = entry?.is_image === true ? images.get(String(entry?.id ?? '')) : undefined
          blocks.push(
            stored === undefined
              ? { type: 'file', attachment: syntheticFileRef(entry) }
              : { type: 'image', attachment: stored },
          )
        }
      }
    }
    const body = texts.filter((line) => line !== '').join('\n')
    const content = body.trim().length > 0
      ? [...blocks, { type: 'text', text: body }]
      : blocks.length > 0
        ? blocks
        : [{ type: 'text', text: '' }]
    return {
      content,
      source: { kind: 'user' },
      role: 'user',
      id: createId(),
    }
  }

  // One reply becomes one or more steps: text and reasoning accumulate, a
  // stage change or text after a tool call starts a new step.
  const replySteps = (reply) => {
    const steps = []
    let current = { content: [], calls: [], stage: null }
    const flush = () => {
      if (current.content.length === 0 && current.calls.length === 0) return
      steps.push(current)
      current = { content: [], calls: [], stage: null }
    }
    const appendContent = (block) => {
      if (current.calls.length > 0) flush()
      current.content.push(block)
    }
    const appendCall = (call, stage) => {
      if (stage !== null) {
        if (current.stage !== null && stage !== current.stage) flush()
        current.stage = stage
      }
      current.calls.push(call)
    }

    for (const fragment of reply.fragments ?? []) {
      switch (fragment?.type) {
        case 'THINK':
          if (fragmentText(fragment).length > 0) appendContent({ type: 'reasoning', text: fragmentText(fragment) })
          break
        case 'RESPONSE':
          if (fragmentText(fragment).length > 0) appendContent({ type: 'text', text: fragmentText(fragment) })
          break
        case 'TOOL_SEARCH': {
          if (fragment.status === 'WIP') break
          const queries = (Array.isArray(fragment.queries) ? fragment.queries : []).filter((query) => String(query).trim() !== '')
          if (fragment.status === 'FAILED') {
            appendCall({
              id: createId(),
              name: 'web_search',
              arguments: JSON.stringify({ queries }),
              result: 'Error: the export records this search as failed.',
              isError: true,
            }, fragment.stage_id ?? null)
            break
          }
          if (queries.length === 0) break
          const hits = (Array.isArray(fragment.results) ? fragment.results : [])
            .map((hit) => `- [${hit?.title ?? hit?.url ?? ''}](${hit?.url ?? ''})${hit?.snippet ? ` — ${hit.snippet}` : ''}`)
            .join('\n')
          appendCall({
            id: createId(),
            name: 'web_search',
            arguments: JSON.stringify({ queries }),
            result: hits === '' ? 'No results were recorded.' : hits,
            isError: false,
          }, fragment.stage_id ?? null)
          break
        }
        case 'TOOL_OPEN': {
          const url = typeof fragment.url === 'string' && fragment.url.trim() !== '' ? fragment.url : undefined
          if (fragment.status === 'WIP' || url === undefined) break
          const ok = fragment.status === 'FINISHED'
          const title = typeof fragment.title === 'string' && fragment.title.trim() !== '' ? fragment.title : undefined
          appendCall({
            id: createId(),
            name: 'web_fetch',
            arguments: JSON.stringify({ url }),
            result: ok
              ? `${title === undefined ? url : `${title}\n\n${url}`}\n\nThe page content is not included in the DeepSeek chat export.`
              : 'Error: the page could not be opened.',
            isError: !ok,
          }, fragment.stage_id ?? null)
          break
        }
        case 'READ_LINK': {
          const text = linkLines(fragment.results)
          if (text !== undefined) appendContent({ type: 'text', text })
          break
        }
        case 'TEMPLATE_RESPONSE':
          warnings.push('跳过一条模板回答（DEEPSEEK_EXPORT_TEMPLATE_RESPONSE）')
          break
        default:
          // TOOL_FIND / TOOL_IMAGE_SEARCH / PARTIAL_FILE_READ / TIP leave no
          // trace on the website either, and an unknown type is one a later
          // exporter added.
          break
      }
    }
    flush()
    return steps
  }

  let turn = 0
  let withdrawn = 0
  for (let index = 0; index < chain.length; index++) {
    const user = chain[index]
    if (user.role !== 'USER') continue
    const next = chain[index + 1]
    const reply = next?.role === 'ASSISTANT' ? next : undefined
    if (reply !== undefined) index++
    if (reply?.status === 'CONTENT_FILTER') {
      withdrawn++
      continue
    }
    turn += 1
    at(timeOf(user.inserted_at) ?? time)
    push('turn/start', { turn })
    push('step/start', { turn, step: 1 })
    // See `emitFromTurns`: the first surface node has to be a protected system
    // head or the store refuses to load the log it just wrote.
    if (turn === 1) {
      push('system/message', {
        turn,
        step: 1,
        message: { role: 'system', content: [], source: { kind: 'system-prompt' }, id: createId() },
      }, 'append')
    }
    push('user/message', userMessage(user), 'append')

    if (reply === undefined) {
      push('step/end', { turn, step: 1 })
      push('turn/end', { turn, reason: { kind: 'error', error: { code: 'DEEPSEEK_EXPORT_NO_REPLY', message: 'The export contains no reply to this message.' } } })
      continue
    }

    at(timeOf(reply.inserted_at) ?? time)
    const steps = replySteps(reply)
    if (reply.status !== 'FINISHED' || steps.length === 0) {
      const code = UNFINISHED.get(reply.status) ?? (reply.status !== 'FINISHED' ? 'DEEPSEEK_EXPORT_UNFINISHED_REPLY' : 'DEEPSEEK_EXPORT_EMPTY_REPLY')
      const message = reply.status !== 'FINISHED'
        ? `The original reply ended with status ${JSON.stringify(reply.status)} and is excluded from the model context.`
        : 'The original reply has no importable content.'
      push('step/end', { turn, step: 1 })
      push('turn/end', { turn, reason: { kind: 'error', error: { code, message } } })
      continue
    }

    steps.forEach((step, position) => {
      const stepNumber = position + 1
      if (position > 0) push('step/start', { turn, step: stepNumber })
      push('assistant/message', {
        turn,
        step: stepNumber,
        message: {
          role: 'assistant',
          content: [...step.content, ...step.calls.map((call) => ({ type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments }))],
          source: MODEL_SOURCE,
          id: createId(),
        },
        stream: [],
      }, 'append')
      const callSeqs = step.calls.map((call) => {
        push('tool/call', { turn, step: stepNumber, callId: call.id, name: call.name, arguments: call.arguments })
        return events.length - 1
      })
      step.calls.forEach((call, callIndex) => {
        push('tool/result', {
          turn,
          step: stepNumber,
          message: {
            role: 'tool',
            content: [{ type: 'text', text: call.result }],
            isError: call.isError,
            source: { kind: 'tool', callId: call.id },
            toolCallId: call.id,
            id: createId(),
          },
        }, 'append')
        events[events.length - 1].sourceEventSeqs = [callSeqs[callIndex]]
      })
      if (position < steps.length - 1) push('step/end', { turn, step: stepNumber })
    })
    push('step/end', { turn, step: steps.length })
    push('turn/end', { turn, reason: { kind: 'completed' } })
  }

  if (turn === 0) {
    throw new Error(withdrawn === 0 ? 'conversation has no user message' : 'every question was withdrawn by content filtering')
  }

  const rawTitle = typeof file.title === 'string' ? file.title.trim() : ''
  const title = rawTitle === '' ? (options.title ?? '') : rawTitle
  return {
    header: { id: createId(), createdAt: events[0].time, cwd: undefined },
    events,
    title,
    warnings,
    turns: turn,
  }
}
