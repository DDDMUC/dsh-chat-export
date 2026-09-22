// dsh-chat-export - host half.
//
// One human command and four authenticated JSON/binary routes:
//
//   POST /api/dsh-chat-export.export   -> the artifact (download)
//   GET  /api/dsh-chat-export.pending  -> the request the last command line parsed to
//   POST /api/dsh-chat-export.save     -> write a text artifact into a directory
//   GET  /api/dsh-chat-export.preview  -> a Markdown excerpt for the dialog
//
// The routes go through `ctx.connection.fetch` rather than a raw `webServer`
// route so they inherit the connection service's authentication and its
// host/origin fence for free. The module imports nothing from the DSH SDK:
// `commands`, `connection`, `fs`, and the session services are all resolved
// through the cordis context at call time, so the plugin loads on any profile
// and reports a clear failure instead of breaking the boot when one is absent.
import {
  API_PREFIX,
  COMMAND_HINT,
  contentDisposition,
  isTextFormat,
  defaultOptions,
  extensionFor,
  exportFilename,
  optionsFromQuery,
  optionsToQuery,
  parseCommandInput,
  PLUGIN_ID,
} from './options.js'
import { produceExport, dataUri } from './export.js'
import { exportServices, readFileBytes, readImageBytes, readSessionLog, readSessionTitle, writeTextFile } from './sources.js'

/** Cordis plugin name. */
export const name = PLUGIN_ID

/** Both services are required: without them the plugin has nothing to register. */
export const inject = ['commands', 'connection']

/** How long a command-parsed request stays available to the browser half. */
const PENDING_TTL_MS = 5 * 60 * 1000

/** Preview bodies are capped so opening the dialog cannot pull a huge document. */
const DEFAULT_PREVIEW_CHARS = 120_000

/** Default configuration. */
const DEFAULT_CONFIG = {
  /** Directory a bare `--save` writes into, relative to the session working directory. */
  defaultSaveDir: 'dsh-chat-exports',
  previewChars: DEFAULT_PREVIEW_CHARS,
}

/** Every shape of request failure this plugin reports. */
class ExportError extends Error {
  constructor(status, code, message) {
    super(message)
    this.name = 'ExportError'
    this.status = status
    this.code = code
  }
}

/** A JSON response. */
function json(body, status = 200) {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** A plain-text failure response. */
function fail(status, code, message) {
  return json({ ok: false, code, error: message }, status)
}

/** Validate a session id shape before it reaches any service. */
function requireSessionId(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ExportError(400, 'invalid', 'sessionId is required')
  }
  const trimmed = value.trim()
  if (!/^(session-)?[0-9a-fA-F-]{8,64}$/u.test(trimmed)) {
    throw new ExportError(400, 'invalid', 'sessionId is not a valid session identifier')
  }
  return trimmed
}

/** Read the JSON body of a POST request. */
async function readJsonBody(request) {
  try {
    const text = await request.text()
    if (text.trim() === '') return {}
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ExportError(400, 'invalid', 'the request body must be a JSON object')
    }
    return parsed
  } catch (error) {
    if (error instanceof ExportError) throw error
    throw new ExportError(400, 'invalid', 'the request body is not valid JSON')
  }
}

/**
 * Resolve the effective request from query parameters and any pending command.
 * @param ctx - host context.
 * @param state - the plugin's mutable state.
 * @param searchParams - the request query.
 * @returns `{ sessionId, options, save }`.
 */
function resolveRequest(state, searchParams) {
  const sessionId = requireSessionId(searchParams.get('sessionId'))
  const fromQuery = optionsFromQuery(searchParams)
  if (fromQuery.errors.length > 0) throw new ExportError(400, 'invalid', fromQuery.errors.join('; '))

  let options = fromQuery.options
  let save = fromQuery.save

  if (searchParams.get('usePending') === '1') {
    const pending = takePending(state, sessionId)
    if (pending === undefined) throw new ExportError(409, 'no-pending', 'the export request expired; run the command again')
    // The query wins where it is explicit, so the browser can still narrow a
    // pending request (for example by forcing a format from the dialog).
    options = { ...pending.options, ...explicitKeys(searchParams, fromQuery.options) }
    if (fromQuery.save === null) save = pending.save
  }

  return { sessionId, options, save }
}

/** The option keys the query actually set, so defaults never override a pending request. */
function explicitKeys(searchParams, parsed) {
  const keys = new Set(['format'])
  for (const key of ['thinking', 'tools', 'system', 'injected', 'timestamps', 'usage', 'scope', 'images', 'toolResultLimit']) {
    if (searchParams.get(key) !== null) keys.add(key)
  }
  const out = {}
  for (const key of keys) out[key] = parsed[key]
  return out
}

/** Remember the request a command line parsed to, for the browser half to pick up. */
function putPending(state, sessionId, request) {
  state.pending.set(sessionId, { ...request, at: Date.now() })
  sweepPending(state)
}

/** Take (and consume) a pending request. */
function takePending(state, sessionId) {
  const entry = state.pending.get(sessionId)
  if (entry === undefined) return undefined
  state.pending.delete(sessionId)
  if (Date.now() - entry.at > PENDING_TTL_MS) return undefined
  return entry
}

/** Drop expired pending requests. */
function sweepPending(state) {
  const now = Date.now()
  for (const [key, entry] of state.pending) {
    if (now - entry.at > PENDING_TTL_MS) state.pending.delete(key)
  }
}

/**
 * Build one export artifact for a request.
 * @param ctx - host context.
 * @param state - plugin state.
 * @param resolved - `{ sessionId, options, save }`.
 * @param signal - request cancellation.
 * @returns `{ artifact, log }`.
 */
async function buildArtifact(ctx, state, resolved, signal) {
  const services = exportServices(ctx)
  const log = await readSessionLog(services, resolved.sessionId, signal)
  if (log === undefined) throw new ExportError(404, 'session-not-found', 'no stored log was found for this session')

  const title = await readSessionTitle(services, resolved.sessionId, log.events, signal)
  const artifact = await produceExport({
    header: log.header,
    events: log.events,
    title,
    options: resolved.options,
    loadImage: (ref) => readImageBytes(services, ref, signal),
    loadFile: (ref) => readFileBytes(services, ref, signal),
  })
  return { artifact, log }
}

/** Absolute target directory for a save request. */
function resolveSaveDirectory(save, artifact, log, config) {
  const base = typeof save === 'string' && save !== '' ? save : config.defaultSaveDir
  if (base.startsWith('/')) return base
  const cwd = log.header !== undefined && typeof log.header.cwd === 'string' && log.header.cwd !== '' ? log.header.cwd : process.cwd()
  return `${cwd.replace(/\/+$/u, '')}/${base}`
}

/**
 * Write the text artifact of one export into a directory.
 *
 * Only text formats can be saved: the host's `ctx.fs` exposes a text write and
 * no binary write, and routing around it with `node:fs` would ignore the
 * sandbox policy the session is running under. A ZIP therefore stays a
 * download, which is reported as such rather than silently producing nothing.
 */
async function saveArtifact(ctx, services, resolved, artifact, log, config, signal) {
  if (!isTextFormat(artifact.format)) {
    throw new ExportError(
      400,
      'unsupported-save',
      '保存到目录只支持 Markdown / HTML / 纯文本；ZIP 请用浏览器下载（宿主 ctx.fs 没有二进制写入）',
    )
  }
  const directory = resolveSaveDirectory(resolved.save, artifact, log, config)
  const extension = extensionFor(artifact.format)
  const filename = exportFilename(artifact.format, artifact.transcript.meta.title, artifact.transcript.meta.createdAt)
  const path = `${directory.replace(/\/+$/u, '')}/${filename}`
  const text = artifact.buffer.toString('utf8')
  const written = await writeTextFile(services, path, text, signal)
  return { ok: true, path: written.path, operation: written.operation, bytes: Buffer.byteLength(text), format: artifact.format, filename }
}

/** Parse one `/export-md` line. */
function parseCommand(invocation) {
  const parsed = parseCommandInput(invocation.rawInput ?? '')
  return parsed
}

/** Install the plugin. */
export function apply(ctx, config = {}) {
  const settings = { ...DEFAULT_CONFIG, ...(config !== null && typeof config === 'object' ? config : {}) }
  const state = { pending: new Map() }

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'export-md',
        description: '把当前会话导出成可读文字稿（Markdown / HTML / ZIP）',
        input: { hint: COMMAND_HINT },
        handler: (invocation) => {
          const parsed = parseCommand(invocation)
          if (parsed.errors.length > 0) {
            return { kind: 'error', text: `导出参数有误：${parsed.errors.join('；')}\n用法：/export-md ${COMMAND_HINT}` }
          }
          const sessionId = sessionIdOfAgent(invocation)
          if (sessionId === undefined) {
            return { kind: 'error', text: '无法确定当前会话，请在会话里重新执行。' }
          }
          putPending(state, sessionId, { options: parsed.options, save: parsed.save })
          const label = parsed.options.format === 'md' ? 'Markdown' : parsed.options.format === 'html' ? 'HTML' : 'ZIP'
          return { kind: 'success', text: `正在导出${label}文字稿…` }
        },
      }),
    'dsh-chat-export: command',
  )

  const connection = ctx.get('connection')
  if (connection === undefined || connection.fetch === undefined || typeof connection.fetch.register !== 'function') {
    throw new Error('dsh-chat-export: the connection service is required to serve the export routes')
  }

  connection.fetch.register({
    path: `${API_PREFIX}.export`,
    methods: ['POST', 'GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const resolved = resolveRequest(state, url.searchParams)
        const { artifact, log } = await buildArtifact(ctx, state, resolved, request.signal)

        if (resolved.save !== null) {
          const saved = await saveArtifact(ctx, exportServices(ctx), resolved, artifact, log, settings, request.signal)
          return json(saved)
        }

        const headers = {
          'content-type': artifact.contentType,
          'content-disposition': contentDisposition(artifact.filename),
          'content-length': String(artifact.buffer.length),
        }
        if (request.method === 'HEAD') return new Response(null, { headers })
        return new Response(artifact.buffer, { headers })
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  connection.fetch.register({
    path: `${API_PREFIX}.pending`,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const sessionId = requireSessionId(url.searchParams.get('sessionId'))
        const entry = state.pending.get(sessionId)
        if (entry === undefined || Date.now() - entry.at > PENDING_TTL_MS) {
          return json({ ok: true, pending: false, options: defaultOptions(), save: null })
        }
        return json({
          ok: true,
          pending: true,
          options: entry.options,
          save: entry.save,
          query: [...optionsToQuery(entry.options, entry.save ?? undefined)].map(([key, value]) => [key, value]),
        })
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  connection.fetch.register({
    path: `${API_PREFIX}.save`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJsonBody(request)
        const sessionId = requireSessionId(body.sessionId)
        const parsed = optionsFromQuery(searchParamsOf(body.options))
        if (parsed.errors.length > 0) throw new ExportError(400, 'invalid', parsed.errors.join('; '))
        const save = typeof body.directory === 'string' && body.directory !== '' ? body.directory : ''
        const resolved = { sessionId, options: parsed.options, save }
        const services = exportServices(ctx)
        const log = await readSessionLog(services, sessionId, request.signal)
        if (log === undefined) throw new ExportError(404, 'session-not-found', 'no stored log was found for this session')
        const title = await readSessionTitle(services, sessionId, log.events, request.signal)
        const artifact = await produceExport({
          header: log.header,
          events: log.events,
          title,
          options: resolved.options,
          loadImage: (ref) => readImageBytes(services, ref, request.signal),
          loadFile: (ref) => readFileBytes(services, ref, request.signal),
        })
        const saved = await saveArtifact(ctx, services, resolved, artifact, log, settings, request.signal)
        return json(saved)
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  connection.fetch.register({
    path: `${API_PREFIX}.preview`,
    methods: ['GET', 'HEAD'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const resolved = resolveRequest(state, url.searchParams)
        resolved.options = { ...resolved.options, format: 'md', images: 'none' }
        const { artifact } = await buildArtifact(ctx, state, resolved, request.signal)
        const limit = Math.max(200, Number(settings.previewChars) || DEFAULT_PREVIEW_CHARS)
        const full = artifact.buffer.toString('utf8')
        const truncated = full.length > limit
        const text = truncated ? `${full.slice(0, limit)}\n\n---\n\n_（预览已截断，完整内容请导出）_\n` : full
        const headers = {
          'content-type': 'text/markdown; charset=utf-8',
          'content-length': String(Buffer.byteLength(text)),
          'x-dsh-chat-export-truncated': truncated ? '1' : '0',
        }
        if (request.method === 'HEAD') return new Response(null, { headers })
        return new Response(text, { headers })
      } catch (error) {
        return errorResponse(error)
      }
    },
  })

  ctx.effect(() => () => state.pending.clear(), 'dsh-chat-export: pending requests')
}

/** Turn a thrown value into a response without leaking a stack to the browser. */
function errorResponse(error) {
  if (error instanceof ExportError) return fail(error.status, error.code, error.message)
  const message = error instanceof Error ? error.message : String(error)
  return fail(500, 'internal', message)
}

/** Build query parameters from an options object sent by the browser. */
function searchParamsOf(options) {
  const params = new URLSearchParams()
  if (options === null || typeof options !== 'object') return params
  for (const [key, value] of Object.entries(options)) params.set(key, String(value))
  return params
}

/**
 * The session id behind one command invocation.
 *
 * The invocation exposes the receiving agent, whose session id names the log to
 * export. Both spellings are accepted because the store and the persistence
 * directories disagree about the `session-` prefix.
 */
function sessionIdOfAgent(invocation) {
  const agent = invocation?.agent
  const candidates = [agent?.session?.id, agent?.sessionId, agent?.id]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '') return candidate
  }
  return undefined
}

export { dataUri }
