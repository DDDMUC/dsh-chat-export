// dsh-chat-export - host-side session reading.
//
// Every service is resolved through the cordis context at call time rather than
// imported from the SDK, so the plugin loads on any profile and degrades to a
// clear HTTP error when a service is missing instead of failing at import.
//
// The read chain is deliberately layered. `sessionPersistence` is the same
// primitive the official log exporter uses: it owns multi-frame Zstandard
// framing, format migration, and torn-tail recovery, and it works for a cold or
// archived session that is not open in any UI. `sessionQuery` is the fallback
// when a deployment mounts the query engine but not the raw persistence
// handle, and `readSurface` is the last resort because it can answer at least
// for the current model context.

/** Media type to archive extension for the raster types the store accepts. */
const MEDIA_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

/** Cap on one generic file attachment pulled into a bundle. */
export const MAX_FILE_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** The services one export needs, or `undefined` for each that is missing. */
export function exportServices(ctx) {
  return {
    persistence: ctx.get('sessionPersistence'),
    query: ctx.get('sessionQuery'),
    attachments: ctx.get('attachments'),
    fs: ctx.get('fs'),
  }
}

/** Extension for one image media type. */
export function mediaExtension(mediaType) {
  return MEDIA_EXTENSIONS[mediaType] ?? 'bin'
}

/** `session-<uuid>` and `<uuid>` are two spellings of the same session id. */
export function idVariants(sessionId) {
  const value = String(sessionId)
  const out = [value]
  if (value.startsWith('session-')) out.push(value.slice('session-'.length))
  else out.push(`session-${value}`)
  return out
}

/**
 * Read one session's complete raw log.
 *
 * @param services - the resolved service bundle.
 * @param sessionId - the session to read.
 * @param signal - optional cancellation.
 * @returns `{ header, events, source }`, or `undefined` when the id is unknown.
 */
export async function readSessionLog(services, sessionId, signal) {
  const options = signal === undefined ? {} : { signal }
  const attempts = []

  if (services.persistence !== undefined && typeof services.persistence.open === 'function') {
    for (const variant of idVariants(sessionId)) {
      try {
        const handle = await services.persistence.open(variant, 'read', options)
        try {
          const { events } = await handle.read(0, undefined, options)
          if (Array.isArray(events)) return { header: handle.header, events, source: 'persistence' }
        } finally {
          await handle.close()
        }
      } catch (error) {
        attempts.push({ message: errorMessage(error), missing: isMissing(error) })
      }
    }
  }

  if (services.query !== undefined && typeof services.query.readSession === 'function') {
    for (const variant of idVariants(sessionId)) {
      try {
        const snapshot = await services.query.readSession(variant)
        if (snapshot !== undefined && Array.isArray(snapshot.events)) {
          return { header: snapshot.session, events: snapshot.events, source: 'sessionQuery' }
        }
      } catch (error) {
        attempts.push({ message: errorMessage(error), missing: isMissing(error) })
      }
    }
  }

  if (services.query !== undefined && typeof services.query.readSurface === 'function') {
    for (const variant of idVariants(sessionId)) {
      try {
        const snapshot = await services.query.readSurface(variant)
        if (snapshot !== undefined && Array.isArray(snapshot.events)) {
          return { header: snapshot.session, events: snapshot.events, source: 'surface' }
        }
      } catch (error) {
        attempts.push({ message: errorMessage(error), missing: isMissing(error) })
      }
    }
  }

  if (attempts.length === 0) return undefined
  // A real absence is not an error: persistence signals it with a dedicated
  // error type, and the query engine words it differently. Anything else is a
  // genuine failure and must not be reported to the user as "no such session".
  if (attempts.every((attempt) => attempt.missing)) return undefined
  throw new Error(`could not read the session log: ${attempts[attempts.length - 1].message}`)
}

/** Message text of an unknown thrown value. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Whether one read failure means "this session does not exist".
 * @param error - the thrown value.
 * @returns true for an absence, false for a real failure.
 */
function isMissing(error) {
  const name = error instanceof Error ? error.name : ''
  if (/not.?found/iu.test(name)) return true
  return /not.?found|no such|missing|does not exist|unknown session|no session/iu.test(errorMessage(error))
}

/**
 * Fold the session title.
 *
 * `sessionQuery.readTitle` is the authoritative fold when the query engine is
 * mounted; otherwise the last `session/title` event in the log is used, which
 * is what the host folds anyway.
 *
 * @param services - the resolved service bundle.
 * @param sessionId - the session whose title is wanted.
 * @param events - the log already read, used as the fallback source.
 * @param signal - optional cancellation.
 * @returns the title, or an empty string when the session has none yet.
 */
export async function readSessionTitle(services, sessionId, events, signal) {
  if (services.query !== undefined && typeof services.query.readTitle === 'function') {
    for (const variant of idVariants(sessionId)) {
      try {
        const snapshot = await services.query.readTitle(variant, signal)
        if (snapshot !== undefined && typeof snapshot.title === 'string' && snapshot.title !== '') return snapshot.title
      } catch {
        // fall through to the log fold
      }
    }
  }
  let title = ''
  for (const event of events) {
    if (event.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') title = event.data.title
  }
  return title
}

/**
 * Read the stored bytes of one image attachment.
 * @param services - the resolved service bundle.
 * @param ref - the durable image reference from the log.
 * @param signal - optional cancellation.
 * @returns the bytes, or `undefined` when they cannot be read.
 */
export async function readImageBytes(services, ref, signal) {
  if (services.attachments === undefined || typeof services.attachments.readImage !== 'function') return undefined
  try {
    const stored = await services.attachments.readImage(ref, signal)
    if (stored === undefined || stored.data === undefined) return undefined
    return Buffer.from(stored.data)
  } catch {
    return undefined
  }
}

/**
 * Read the bytes of one generic file attachment, up to a size cap.
 * @param services - the resolved service bundle.
 * @param ref - the durable file reference from the log.
 * @param signal - optional cancellation.
 * @returns the bytes, or `undefined` when unreadable or over the cap.
 */
export async function readFileBytes(services, ref, signal) {
  if (services.attachments === undefined || typeof services.attachments.readFileStream !== 'function') return undefined
  if (typeof ref.bytes === 'number' && ref.bytes > MAX_FILE_ATTACHMENT_BYTES) return undefined
  try {
    const chunks = []
    let total = 0
    for await (const chunk of services.attachments.readFileStream(ref, signal)) {
      const buffer = Buffer.from(chunk)
      total += buffer.length
      if (total > MAX_FILE_ATTACHMENT_BYTES) return undefined
      chunks.push(buffer)
    }
    return Buffer.concat(chunks)
  } catch {
    return undefined
  }
}

/**
 * Write one text artifact into a chosen directory through `ctx.fs`.
 *
 * `ctx.fs` is the sanctioned, sandbox-aware writer: it refuses paths outside
 * the execution world's allowed roots unless the caller is granted a wider
 * policy, which is exactly the behaviour a plugin should not route around.
 * It also has no binary write, which is why only the text formats can be saved.
 *
 * @param services - the resolved service bundle.
 * @param path - absolute target path.
 * @param content - UTF-8 text.
 * @param signal - optional cancellation.
 * @returns `{ path, operation }` after a successful write.
 */
export async function writeTextFile(services, path, content, signal) {
  const fs = services.fs
  if (fs === undefined || typeof fs.resolve !== 'function' || typeof fs.writeText !== 'function') {
    throw new Error('the fs service is unavailable, so saving to a directory is not possible')
  }
  const target = await fs.resolve(path, { signal })
  const existing = typeof fs.stat === 'function' ? await fs.stat(target, signal) : undefined
  const intent = existing === undefined ? { kind: 'createIfAbsent' } : { kind: 'replaceIfVersion', version: existing.version }
  await fs.writeText(target, content, intent, signal)
  return { path: target.displayPath ?? path, operation: existing === undefined ? 'create' : 'update' }
}
