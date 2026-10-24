// dsh-chat-export - the machine-readable sidecar.
//
// The Markdown/HTML/TXT artifacts are for humans and are lossy on purpose: a
// tool call becomes a paragraph, a reasoning block becomes a blockquote, and
// nothing survives that could be replayed. This module owns the one artifact
// that is NOT lossy - the session's own event log, wrapped in a small envelope
// so a file on disk can say what it is without being told.
//
// Three shapes are accepted when parsing, because all three occur in practice:
//
//   1. this plugin's envelope line followed by one event per line (`.jsonl`)
//   2. a raw session artifact (`session.v4.jsonl` decompressed): a `session`
//      line followed by events - what `readArtifactDirectly` reads
//   3. a bare JSON array of events, for hand-assembled files
//
// Everything here is a pure function over strings, so the format is testable
// without a host.

/** Envelope discriminator written as the first line of a `.jsonl` artifact. */
export const LOG_KIND = 'dsh-chat-export/log'

/** Envelope version. Bumped when the envelope's own fields change shape. */
export const LOG_VERSION = 1

/** Archive name used inside a ZIP bundle and as the default sidecar filename. */
export const LOG_FILENAME = 'log.jsonl'

/** Session format generation this plugin writes and reads. */
export const SESSION_FORMAT_VERSION = 4

/** A parse failure with a machine-readable reason. */
export class LogFormatError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LogFormatError'
    this.code = code
  }
}

/**
 * Serialize one session log as the sidecar artifact.
 *
 * The events are written verbatim - not normalized, not re-sequenced - because
 * this file's whole purpose is to be replayed by `planImport`, which does its
 * own reindexing and can therefore stay the single place that knows the rules.
 *
 * @param input - `{ header, events, title?, exportedAt? }`.
 * @returns the artifact text, newline-terminated.
 */
export function buildLogArtifact(input) {
  const events = Array.isArray(input.events) ? input.events : []
  const envelope = {
    kind: LOG_KIND,
    version: LOG_VERSION,
    tool: 'dsh-chat-export',
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    session: input.header ?? {},
    title: typeof input.title === 'string' ? input.title : '',
    eventCount: events.length,
  }
  const lines = [JSON.stringify(envelope)]
  for (const event of events) lines.push(JSON.stringify(event))
  return `${lines.join('\n')}\n`
}

/**
 * Parse one sidecar artifact in any of the three accepted shapes.
 *
 * @param input - the artifact text (or bytes, decoded as UTF-8).
 * @returns `{ header, events, title, warnings }`; `header` is `{}` when the
 *   file carried none, and the caller decides what to default.
 * @throws {LogFormatError} when the text is not a session log at all.
 */
export function parseLogArtifact(input) {
  const text = Buffer.isBuffer(input) ? input.toString('utf8') : String(input ?? '')
  const body = text.replace(/^\uFEFF/u, '').trim()
  if (body === '') throw new LogFormatError('empty', '文件是空的，没有可导入的内容')

  const rows = body.startsWith('[') || body.startsWith('{') && !body.includes('\n') ? parseJsonDocument(body) : parseJsonLines(body)
  if (rows.length === 0) throw new LogFormatError('empty', '文件里没有任何记录')

  const warnings = []
  let header = {}
  let title = ''
  const events = []

  for (const row of rows) {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      warnings.push('跳过了一条不是对象的记录')
      continue
    }
    if (row.kind === LOG_KIND) {
      if (typeof row.version === 'number' && row.version > LOG_VERSION) {
        warnings.push(`sidecar 版本 ${row.version} 高于本插件支持的 ${LOG_VERSION}，未知字段会被忽略`)
      }
      if (row.session !== null && typeof row.session === 'object' && !Array.isArray(row.session)) header = row.session
      if (typeof row.title === 'string') title = row.title
      continue
    }
    // A raw session artifact opens with the header as its first JSONL line.
    if (row.type === 'session' && header.id === undefined && events.length === 0) {
      header = row
      continue
    }
    if (typeof row.type !== 'string' || row.type === '') {
      warnings.push('跳过了一条没有 type 的记录')
      continue
    }
    events.push(row)
  }

  if (events.length === 0) throw new LogFormatError('no-events', '文件里没有会话事件（只有头信息）')
  if (typeof header.id === 'string' && header.id !== '') {
    if (typeof header.version === 'number' && header.version > SESSION_FORMAT_VERSION) {
      warnings.push(`会话格式 v${header.version} 比本插件支持的 v${SESSION_FORMAT_VERSION} 新，导入可能被宿主拒绝`)
    }
  }

  return { header, events, title, warnings }
}

/** Parse a whole-document JSON payload (an array, or one envelope object). */
function parseJsonDocument(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    // A single-line object may still be a JSONL artifact with one line.
    return parseJsonLines(text)
  }
  if (Array.isArray(parsed)) return parsed
  if (parsed !== null && typeof parsed === 'object') {
    if (Array.isArray(parsed.events)) return [parsed, ...parsed.events]
    return [parsed]
  }
  throw new LogFormatError('invalid', '文件不是有效的 JSON 会话日志')
}

/** Parse one-record-per-line JSON, reporting the first unparsable line. */
function parseJsonLines(text) {
  const rows = []
  const lines = text.split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '') continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      throw new LogFormatError('invalid-line', `第 ${index + 1} 行不是有效 JSON，文件可能被截断或不是会话日志`)
    }
  }
  return rows
}

/**
 * Whether one parsed artifact can be replayed as a conversation.
 *
 * The check is deliberately shallow: the host is the authority on event
 * validity, and a deep validator here would drift from it.
 *
 * @param parsed - the result of {@link parseLogArtifact}.
 * @returns a list of human-readable problems; empty means "worth trying".
 */
export function inspectLog(parsed) {
  const problems = []
  if (!Array.isArray(parsed.events) || parsed.events.length === 0) problems.push('没有事件')
  const first = parsed.events?.[0]
  if (first !== undefined && first.type === 'session') problems.push('事件流里混进了会话头')
  return problems
}
