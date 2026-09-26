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
// when a deployment mounts the query engine but not the raw persistence handle,
// and `readSurface` can at least answer for the current model context.
//
// The last resort reads the artifact off the filesystem with this plugin's own
// frame walker. It exists because the service chain is the official one, so
// when the harness breaks its own reader every first-party export breaks too:
// on 0.1.7-rc.2 two sessions whose v3 log was sealed and whose v4 log was then
// appended to reject `sessionPersistence.open`, and the official
// session-log-export returns 500 on exactly the same sessions. Walking frames
// directly still yields the complete log, and doing so is not a divergence from
// the official behaviour - it is the only thing that still answers at all.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeSessionArtifact } from './zstd.js'

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

/**
 * The newest session generation present in a directory.
 *
 * A directory can hold several generations at once after a format upgrade
 * (`session.v3.jsonl.zstd` beside `session.v4.jsonl.zstd`). The newest is the
 * one carrying every event - the older files are pre-migration snapshots - so
 * this returns the highest `vN` it can find.
 *
 * @param dir - one session directory.
 * @returns its newest artifact path, or undefined when none is present.
 */
export function newestGeneration(dir) {
  let best
  let bestVersion = -1
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const match = /^session\.v(\d+)\.jsonl\.zstd$/u.exec(entry.name)
    if (match === null) continue
    const version = Number(match[1])
    if (version > bestVersion) {
      bestVersion = version
      best = entry.name
    }
  }
  return best === undefined ? undefined : join(dir, best)
}

/**
 * The DeepSeek Harness home, mirroring the harness's own resolution.
 *
 * `DSH_HOME` wins when set (a `~` prefix is expanded), and `~/.dsh` is the
 * default. The sessions root is derived from it exactly as
 * `dshHomePath('sessions')` derives it, so a machine that relocates its home
 * gets the artifact fallback in the right place too.
 *
 * @param env - the environment to read (defaults to `process.env`; injectable
 *   so callers and tests do not have to mutate the real environment).
 * @returns the resolved absolute home path.
 */
export function dshHome(env = process.env) {
  const fromEnv = env.DSH_HOME
  // A literal "undefined" or "null" string is treated as unset: shells and
  // wrappers set those by accident, and following them would hide every session
  // behind a nonexistent directory.
  const usable = fromEnv !== undefined && !/^(?:undefined|null)$/iu.test(fromEnv.trim()) && fromEnv.trim().length > 0
  const configured = usable ? fromEnv : join(homedir(), '.dsh')
  if (configured === '~') return homedir()
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(homedir(), configured.slice(2))
  return resolve(configured)
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
 * @param readOptions - `{ root }` overrides the sessions root for the last-resort
 *   artifact read, so the whole chain is testable against a fixture directory.
 * @returns `{ header, events, source }`, or `undefined` when the id is unknown.
 */
export async function readSessionLog(services, sessionId, signal, readOptions = {}) {
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

  // Last resort: walk the frames of the artifact on disk.
  const direct = readArtifactDirectly(sessionId, signal, readOptions.root === undefined ? {} : { root: readOptions.root })
  if (direct !== undefined) return direct

  if (attempts.length === 0) return undefined
  // A real absence is not an error: persistence signals it with a dedicated
  // error type, and the query engine words it differently. Anything else is a
  // genuine failure and must not be reported to the user as "no such session".
  if (attempts.every((attempt) => attempt.missing)) return undefined
  // Every attempt is reported, not just the last one: the final message is
  // usually the fallback's, which is the least informative of the lot and hides
  // why the primary reader actually failed.
  throw new Error(`could not read the session log: ${attempts.map((attempt) => attempt.message).join(' | ')}`)
}

/**
 * Read the session artifact straight off the filesystem.
 *
 * This bypasses the harness services entirely, which is deliberate: when the
 * official reader rejects a log, every first-party export rejects it too, and
 * the artifact is still perfectly readable. The frame walker handles the
 * multi-frame Zstandard framing and an incomplete final frame (a live session
 * written while it is exported legitimately ends mid-frame), so only complete
 * frames are returned - the same prefix persistence would serve.
 *
 * @param sessionId - the session to read.
 * @param signal - optional cancellation.
 * @param options - `{ root }` overrides the sessions root (for tests).
 * @returns `{ header, events, source }`, or undefined when no artifact is found.
 */
export function readArtifactDirectly(sessionId, signal, options = {}) {
  signal?.throwIfAborted()
  const root = options.root ?? join(dshHome(), 'sessions')
  if (!existsSync(root)) return undefined
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    for (const variant of idVariants(sessionId)) {
      const dir = join(root, project.name, variant)
      if (!existsSync(dir)) continue
      const newest = newestGeneration(dir)
      if (newest === undefined) continue
      try {
        const rows = decodeSessionArtifact(readFileSync(newest))
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line))
        return { header: rows[0], events: rows.slice(1), source: 'artifact' }
      } catch (error) {
        throw new Error(`could not read the session log: artifact ${newest} (${errorMessage(error)})`)
      }
    }
  }
  return undefined
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
