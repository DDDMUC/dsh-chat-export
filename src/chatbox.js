// dsh-chat-export - read a Chatbox export into the same turn shape the
// Markdown readers produce.
//
// Chatbox writes two kinds of export:
//
//   * an HTML page, where every message is a
//     `<div class="chatbox-export-message ...">` carrying a `<b>USER</b>` /
//     `<b>ASSISTANT</b>` label and the body in a `break-words` element;
//   * a JSON backup, `{ name, messages: [{ role, contentParts: [{ type, text }] }] }`,
//     where `contentParts` carries `text` and `reasoning`.
//
// Both are turned into `{ title, turns }` with blocks labelled 用户 / 助手, which
// is what `eventsFromMarkdown` already consumes - so a Chatbox file becomes a
// session through the same emitter as everything else.

/** Decode the entities a Chatbox export can contain. */
function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, ' ')
    .replace(/&#x([0-9a-f]+);/giu, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gu, (_match, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/gu, '&')
}

/** Flatten one fragment of HTML into readable text. */
function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<br\s*\/?>/giu, '\n')
      .replace(/<\/(?:p|div|li|h[1-6]|tr|pre)>/giu, '\n')
      .replace(/<[^>]+>/gu, ''),
  )
    .replace(/[ \t]+$/gmu, '')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/**
 * The inner HTML of the first element whose class attribute starts with
 * `marker`.
 *
 * The end of the element is found by counting nested `div` tags rather than by
 * matching the first `</div>`: a message that contains its own markup (a list,
 * a quote, a table) would otherwise be cut off at the first inner close.
 *
 * @returns the inner HTML, or null when there is no such element.
 */
function innerOf(html, marker) {
  const at = html.indexOf(marker)
  if (at < 0) return null
  const open = html.indexOf('>', at)
  if (open < 0) return null
  const start = open + 1
  let depth = 1
  const tag = /<(\/?)div\b[^>]*>/giu
  tag.lastIndex = start
  let match = tag.exec(html)
  while (match !== null) {
    if (match[1] === '/') depth -= 1
    else depth += 1
    if (depth === 0) return html.slice(start, match.index)
    match = tag.exec(html)
  }
  return null
}

/** The page title of an HTML export, if it has one. */
function htmlTitle(html) {
  const match = /<title>([\s\S]*?)<\/title>/iu.exec(html)
  if (match === null) return ''
  return htmlToText(match[1])
}

/**
 * One turn per user message; assistant blocks stay in the turn they answer.
 *
 * Shared with the composer, which authors the same `{ role, text, reasoning }`
 * records by hand instead of reading them out of a file.
 *
 * @param messages - `[{ role: 'user'|'assistant', text, reasoning? }]`.
 * @returns turns in the shape the importer's emitter consumes.
 */
export function dialogueTurns(messages) {
  const turns = []
  for (const message of messages) {
    // A message needs a body. Reasoning alone is not a message, and reasoning
    // on a user turn is not a thing at all - only the model thinks.
    if (message.text === '') continue
    const isUser = message.role === 'user'
    if (isUser || turns.length === 0) turns.push({ index: turns.length + 1, blocks: [] })
    turns[turns.length - 1].blocks.push({
      label: isUser ? '用户' : '助手',
      text: message.text,
      reasoning: isUser ? '' : message.reasoning,
    })
  }
  return turns
}

/**
 * Read a Chatbox HTML export.
 * @returns `{ title, turns }`, or null when the page is not one.
 */
function fromHtml(html) {
  if (!html.includes('chatbox-export-message')) return null
  const chunks = html.split('class="chatbox-export-message')
  const messages = []
  for (const chunk of chunks.slice(1)) {
    const label = /<b>([\s\S]*?)<\/b>/iu.exec(chunk)
    const name = label === null ? '' : htmlToText(label[1]).replace(/[:：]\s*$/u, '').toLowerCase()
    let role = null
    if (name === 'assistant') role = 'assistant'
    else if (name === 'user' || name === 'system') role = 'user'
    else if (chunk.includes('text-blue-500')) role = 'assistant'
    else if (chunk.includes('text-green-500')) role = 'user'
    if (role === null) continue
    const body = innerOf(chunk, 'class="break-words')
    if (body === null) continue
    messages.push({ role, text: htmlToText(body), reasoning: '' })
  }
  if (messages.length === 0) return null
  return { title: htmlTitle(html), turns: dialogueTurns(messages) }
}

/**
 * Read a Chatbox JSON backup.
 *
 * The shape has to be checked rather than assumed: `.json` is also the
 * extension of a session log, and that path is somebody else's.
 *
 * @returns `{ title, turns }`, or null when the object is not a backup.
 */
function fromJson(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = Array.isArray(value.messages) ? value.messages : null
  if (raw === null) return null
  if (!raw.some((message) => message !== null && typeof message === 'object' && Array.isArray(message.contentParts))) return null
  const messages = []
  for (const message of raw) {
    if (message === null || typeof message !== 'object') continue
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const texts = []
    const thoughts = []
    for (const part of Array.isArray(message.contentParts) ? message.contentParts : []) {
      if (part === null || typeof part !== 'object') continue
      const body = typeof part.text === 'string' ? part.text.trim() : ''
      if (body === '') continue
      if (part.type === 'reasoning') thoughts.push(body)
      else if (part.type === 'text') texts.push(body)
    }
    messages.push({ role, text: texts.join('\n\n'), reasoning: thoughts.join('\n') })
  }
  const title = typeof value.name === 'string' ? value.name.trim() : ''
  return { title, turns: dialogueTurns(messages) }
}

/**
 * Read a Chatbox export, HTML or JSON.
 *
 * @param text - the file's contents.
 * @returns `{ title, turns }`, or null when this is not a Chatbox export.
 */
export function readChatbox(text) {
  const raw = String(text ?? '')
  if (raw.trimStart().startsWith('<')) return fromHtml(raw)
  const trimmed = raw.trimStart()
  if (!trimmed.startsWith('{')) return null
  try {
    return fromJson(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Whether a JSON text looks like a Chatbox backup, for the import router. */
export function looksLikeChatboxJson(text) {
  const trimmed = String(text ?? '').trimStart()
  if (!trimmed.startsWith('{')) return false
  try {
    const value = JSON.parse(trimmed)
    return value !== null && typeof value === 'object' && Array.isArray(value.messages)
  } catch {
    return false
  }
}
