// dsh-chat-export - find the subagent sessions one conversation spawned.
//
// A subagent is a session of its own: its own directory, its own log, linked to
// its parent only by `parentSession` in the header. The parent log records the
// delegation call and what came back, but nothing of the child's own reasoning,
// tool traffic, or intermediate turns. An export that reads only the parent id
// therefore shows a hole where the work happened.

import { readSessionLog, readSessionTitle } from './sources.js'

/** Session ids are stored with and without the `session-` prefix. */
export function bareSessionId(id) {
  const value = String(id ?? '')
  return value.startsWith('session-') ? value.slice('session-'.length) : value
}

/**
 * Every session header the host knows about.
 *
 * `sessionQuery` merges live and persisted sessions and already carries
 * `parentSession`, so the parent/child map never has to be decoded out of the
 * zstd logs. `sessionPersistence` is the fallback on hosts without it.
 *
 * @returns session headers, or `[]` when no service can list them.
 */
export async function listSessionHeaders(ctx) {
  try {
    const query = ctx.get('sessionQuery')
    if (query !== undefined && typeof query.listSessions === 'function') {
      const records = await query.listSessions()
      const headers = (Array.isArray(records) ? records : [])
        .map((record) => record?.header)
        .filter((header) => header !== null && header !== undefined && typeof header.id === 'string')
      if (headers.length > 0) return headers
    }
  } catch {
    // fall through to the persistence service
  }
  try {
    const persistence = ctx.get('sessionPersistence')
    if (persistence !== undefined && typeof persistence.list === 'function') {
      const snapshots = await persistence.list({})
      return (Array.isArray(snapshots) ? snapshots : [])
        .map((snapshot) => snapshot?.header)
        .filter((header) => header !== null && header !== undefined && typeof header.id === 'string')
    }
  } catch {
    // no service can list sessions on this host
  }
  return []
}

/**
 * Every subagent under one session, breadth first.
 *
 * Only `origin === 'subagent'` counts. A fork also records `parentSession`, but
 * it is a conversation of its own that the user can open like any other, so it
 * must not be folded into somebody else's export.
 *
 * @param headers - the host session headers.
 * @param sessionId - the session being exported.
 * @param limit - stop after this many descendants.
 * @returns `[{ header, depth }]`, parents before their own children.
 */
export function collectDescendants(headers, sessionId, limit = 50) {
  const byParent = new Map()
  for (const header of Array.isArray(headers) ? headers : []) {
    if (typeof header?.parentSession !== 'string') continue
    if (header.origin !== 'subagent') continue
    const key = bareSessionId(header.parentSession)
    const list = byParent.get(key)
    if (list === undefined) byParent.set(key, [header])
    else list.push(header)
  }

  const found = []
  const seen = new Set([bareSessionId(sessionId)])
  const queue = [{ id: bareSessionId(sessionId), depth: 0 }]
  while (queue.length > 0 && found.length < limit) {
    const current = queue.shift()
    for (const child of byParent.get(current.id) ?? []) {
      const key = bareSessionId(child.id)
      if (seen.has(key)) continue
      seen.add(key)
      found.push({ header: child, depth: current.depth + 1 })
      if (found.length >= limit) break
      queue.push({ id: key, depth: current.depth + 1 })
    }
  }
  return found
}

/**
 * Read the logs of every subagent under one session.
 *
 * A child whose log has gone missing is skipped rather than failing the export:
 * the parent transcript is still worth writing, and the gap is reported by the
 * caller's warning list.
 *
 * @param ctx - host context, for the session list.
 * @param services - the export services.
 * @param sessionId - the session being exported.
 * @param signal - request cancellation.
 * @param options - `{ limit? }`.
 * @returns `[{ header, events, title, depth }]`.
 */
export async function loadSubagents(ctx, services, sessionId, signal, options = {}) {
  const found = collectDescendants(await listSessionHeaders(ctx), sessionId, options.limit ?? 50)
  const out = []
  for (const { header, depth } of found) {
    const log = await readSessionLog(services, header.id, signal)
    if (log === undefined) continue
    const resolved = log.header ?? header
    const title = await readSessionTitle(services, header.id, log.events, signal)
    out.push({ header: resolved, events: log.events, title, depth })
  }
  return out
}
