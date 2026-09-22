// dsh-chat-export - export options, command grammar, and filenames.
//
// Everything in this module is a pure function over plain values, so the whole
// option surface (defaults, `/export-md` parsing, query-parameter decoding,
// filename slugs) is unit-testable without a DSH host or a browser.

/** Plugin id shared by the host and browser halves. */
export const PLUGIN_ID = 'dsh-chat-export'

/** Route prefix owned by the host half (under the authenticated `/api` bridge). */
export const API_PREFIX = '/api/dsh-chat-export'

/** Accepted output formats. */
export const FORMATS = ['md', 'html', 'zip', 'txt']

/** Accepted image strategies. */
export const IMAGE_MODES = ['auto', 'embed', 'assets', 'none']

/** Accepted transcript scopes. */
export const SCOPES = ['full', 'surface']

/** Upper bound for one tool result body, in characters. */
export const DEFAULT_TOOL_RESULT_LIMIT = 4000

/** User-message source kinds that count as a human prompt. */
const HUMAN_SOURCE_KINDS = new Set(['user', undefined, null])

/**
 * Default export options.
 *
 * `thinking` and `system` default to off because reasoning blocks and the
 * system prompt are the two largest and least transcript-like parts of a log;
 * tool calls and timestamps default to on because a coding session is mostly
 * tool traffic and a transcript without times is hard to line up with anything
 * else.
 * @returns a fresh mutable options object.
 */
export function defaultOptions() {
  return {
    format: 'md',
    thinking: false,
    tools: true,
    system: false,
    injected: false,
    timestamps: true,
    usage: true,
    scope: 'full',
    images: 'auto',
    toolResultLimit: DEFAULT_TOOL_RESULT_LIMIT,
  }
}

/** Flag spellings accepted on the command line, mapped to their option key. */
const BOOLEAN_FLAGS = {
  thinking: 'thinking',
  tools: 'tools',
  system: 'system',
  injected: 'injected',
  timestamps: 'timestamps',
  usage: 'usage',
}

/** Value flags accepted on the command line. */
const VALUE_FLAGS = {
  images: 'images',
  scope: 'scope',
  limit: 'toolResultLimit',
}

/**
 * Split one command line into tokens, honouring single and double quotes.
 * @param input - raw text after the command name.
 * @returns the token list with quotes removed.
 */
export function tokenize(input) {
  const tokens = []
  let current = ''
  let quote = null
  let started = false
  for (const char of String(input ?? '')) {
    if (quote !== null) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/u.test(char)) {
      if (started || current !== '') tokens.push(current)
      current = ''
      started = false
      continue
    }
    current += char
  }
  if (started || current !== '') tokens.push(current)
  return tokens
}

/** Turn one format token into its canonical form, or undefined when unknown. */
function normalizeFormat(token) {
  const value = String(token).toLowerCase()
  if (value === 'markdown' || value === 'mdown' || value === 'mkd') return 'md'
  if (value === 'text' || value === 'plain') return 'txt'
  return FORMATS.includes(value) ? value : undefined
}

/**
 * Parse the free-form text that follows `/export-md`.
 *
 * The command registry has no argument schema (its only structured field is a
 * free-form `input.hint`), so the grammar lives here: one optional positional
 * format, then `--flag` / `--no-flag` booleans and `key=value` settings.
 *
 * @param rawInput - exact text after the command name, including its separator space.
 * @returns `{ options, save, errors }`; `errors` is empty when the line was accepted.
 */
export function parseCommandInput(rawInput) {
  const options = defaultOptions()
  const errors = []
  let save = null

  for (const token of tokenize(rawInput)) {
    if (token.startsWith('--')) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      const rawName = eq === -1 ? body : body.slice(0, eq)
      const rawValue = eq === -1 ? undefined : body.slice(eq + 1)
      let negated = false
      let name = rawName
      if (name.startsWith('no-')) {
        negated = true
        name = name.slice(3)
      }
      if (name === 'save') {
        if (negated) {
          save = null
          continue
        }
        save = rawValue === undefined || rawValue === '' ? '' : rawValue
        continue
      }
      if (name === 'surface') {
        options.scope = negated ? 'full' : 'surface'
        continue
      }
      if (name === 'embed-images') {
        options.images = negated ? 'assets' : 'embed'
        continue
      }
      const booleanKey = BOOLEAN_FLAGS[name]
      if (booleanKey !== undefined) {
        if (rawValue !== undefined) {
          errors.push(`--${rawName} does not take a value`)
          continue
        }
        options[booleanKey] = !negated
        continue
      }
      const valueKey = VALUE_FLAGS[name]
      if (valueKey !== undefined) {
        if (negated) {
          errors.push(`--no-${name} is not a valid flag`)
          continue
        }
        if (rawValue === undefined) {
          errors.push(`--${name} needs a value, e.g. --${name}=${exampleValueFor(name)}`)
          continue
        }
        if (valueKey === 'toolResultLimit') {
          const limit = Number(rawValue)
          if (!Number.isFinite(limit) || limit < 0) {
            errors.push(`--limit must be a non-negative number`)
            continue
          }
          options.toolResultLimit = Math.floor(limit)
          continue
        }
        if (valueKey === 'images' && !IMAGE_MODES.includes(rawValue)) {
          errors.push(`--images must be one of ${IMAGE_MODES.join(', ')}`)
          continue
        }
        if (valueKey === 'scope' && !SCOPES.includes(rawValue)) {
          errors.push(`--scope must be one of ${SCOPES.join(', ')}`)
          continue
        }
        options[valueKey] = rawValue
        continue
      }
      errors.push(`unknown option --${rawName}`)
      continue
    }

    const format = normalizeFormat(token)
    if (format === undefined) {
      errors.push(`unknown format "${token}" (expected ${FORMATS.join(', ')})`)
      continue
    }
    options.format = format
  }

  return { options, save, errors }
}

/** A representative value used in a flag error message. */
function exampleValueFor(name) {
  if (name === 'images') return 'embed'
  if (name === 'scope') return 'surface'
  if (name === 'limit') return '2000'
  return 'value'
}

/** Human-facing help line advertised through `input.hint` and the dialog. */
export const COMMAND_HINT =
  '[md|html|zip|txt] [--thinking] [--no-tools] [--surface] [--images=embed|assets|none] [--save=目录]'

/**
 * Decode export options from a URL query string.
 *
 * Absent keys keep their default, so the browser can send only what the user
 * actually changed; an unparsable value is an error rather than a silent
 * fallback, because a wrong export is worse than a refused one.
 *
 * @param searchParams - `URLSearchParams` (or anything with `get`).
 * @returns `{ options, save, errors }`.
 */
export function optionsFromQuery(searchParams) {
  const options = defaultOptions()
  const errors = []
  let save = null

  const readBool = (key, target) => {
    const raw = searchParams.get(key)
    if (raw === null) return
    if (raw === '1' || raw === 'true') options[target] = true
    else if (raw === '0' || raw === 'false') options[target] = false
    else errors.push(`${key} must be 1 or 0`)
  }

  const rawFormat = searchParams.get('format')
  if (rawFormat !== null) {
    const format = normalizeFormat(rawFormat)
    if (format === undefined) errors.push(`format must be one of ${FORMATS.join(', ')}`)
    else options.format = format
  }

  readBool('thinking', 'thinking')
  readBool('tools', 'tools')
  readBool('system', 'system')
  readBool('injected', 'injected')
  readBool('timestamps', 'timestamps')
  readBool('usage', 'usage')

  const rawScope = searchParams.get('scope')
  if (rawScope !== null) {
    if (SCOPES.includes(rawScope)) options.scope = rawScope
    else errors.push(`scope must be one of ${SCOPES.join(', ')}`)
  }

  const rawImages = searchParams.get('images')
  if (rawImages !== null) {
    if (IMAGE_MODES.includes(rawImages)) options.images = rawImages
    else errors.push(`images must be one of ${IMAGE_MODES.join(', ')}`)
  }

  const rawLimit = searchParams.get('toolResultLimit')
  if (rawLimit !== null) {
    const limit = Number(rawLimit)
    if (!Number.isFinite(limit) || limit < 0) errors.push('toolResultLimit must be a non-negative number')
    else options.toolResultLimit = Math.floor(limit)
  }

  const rawSave = searchParams.get('save')
  if (rawSave !== null) save = rawSave

  return { options, save, errors }
}

/** Serialize options into query parameters, omitting anything left at its default. */
export function optionsToQuery(options, save) {
  const base = defaultOptions()
  const params = new URLSearchParams()
  params.set('format', options.format)
  for (const key of Object.keys(base)) {
    if (key === 'format') continue
    if (options[key] === base[key]) continue
    params.set(key, String(options[key]))
  }
  if (typeof save === 'string') params.set('save', save)
  return params
}

/**
 * Which image strategy a format actually uses.
 *
 * `auto` means "whatever produces a usable artifact without asking": a
 * Markdown file downloaded on its own has nowhere to put sibling assets, so it
 * embeds; a ZIP has an `assets/` directory, so it references.
 *
 * @param format - `md` | `html` | `zip`.
 * @param options - resolved export options.
 * @returns `embed`, `assets`, or `none`.
 */
export function effectiveImageMode(format, options) {
  if (options.images === 'none') return 'none'
  if (options.images !== 'auto') return options.images
  return format === 'zip' ? 'assets' : 'embed'
}

/**
 * One filesystem- and header-safe slug for an untrusted session title.
 *
 * CJK survives on purpose: a Chinese session title is the most useful part of
 * the filename, so only path separators, control characters, and the reserved
 * Windows set are replaced.
 *
 * @param title - session title, possibly empty or undefined.
 * @param fallback - used when the title yields nothing usable.
 * @returns a slug of at most 60 characters.
 */
export function slugifyTitle(title, fallback = 'session') {
  const cleaned = String(title ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/[\\/:*?"<>|]/gu, ' ')
    .replace(/[\s\u3000]+/gu, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/gu, '')
    .replace(/-{2,}/gu, '-')
  if (cleaned === '') return fallback
  return Array.from(cleaned).slice(0, 60).join('')
}

/**
 * `YYYY-MM-DD` in local time.
 * @param epochMs - Unix epoch milliseconds.
 * @returns the date stamp used in export filenames.
 */
export function dateStamp(epochMs) {
  const date = new Date(epochMs)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The artifact base name shared by every produced file (no extension). */
export function exportBaseName(title, createdAt) {
  return `dsh-chat-${slugifyTitle(title)}-${dateStamp(createdAt)}`
}

/** Extension for one format. */
export function extensionFor(format) {
  if (format === 'md') return 'md'
  if (format === 'html') return 'html'
  if (format === 'txt') return 'txt'
  return 'zip'
}

/** The single downloadable filename for a format. */
export function exportFilename(format, title, createdAt) {
  return `${exportBaseName(title, createdAt)}.${extensionFor(format)}`
}

/** MIME type for one format. */
export function contentTypeFor(format) {
  if (format === 'md') return 'text/markdown; charset=utf-8'
  if (format === 'html') return 'text/html; charset=utf-8'
  if (format === 'txt') return 'text/plain; charset=utf-8'
  return 'application/zip'
}

/**
 * Whether a format is plain text and therefore writable through `ctx.fs`.
 * The host filesystem exposes a text write and no binary write, so a bundle
 * cannot be saved into a directory.
 */
export function isTextFormat(format) {
  return format === 'md' || format === 'html' || format === 'txt'
}

/**
 * A `content-disposition` value for one download filename.
 *
 * HTTP header values are byte strings, so a Chinese session title cannot ride
 * in the quoted `filename=` parameter at all - it throws when the Response is
 * constructed. The ASCII parameter therefore carries a transliterated fallback
 * for old clients while `filename*` carries the real UTF-8 name, which is the
 * RFC 6266/5987 arrangement every current browser honours.
 *
 * @param filename - the intended download name.
 * @returns a header value safe for any byte-string context.
 */
export function contentDisposition(filename) {
  const value = String(filename ?? 'export')
  const ascii = value
    .replace(/[^\u0020-\u007e]/gu, '_')
    .replace(/["\\]/gu, '_')
    .slice(0, 180)
  return `attachment; filename="${ascii === '' ? 'export' : ascii}"; filename*=UTF-8''${encodeURIComponent(value)}`
}
