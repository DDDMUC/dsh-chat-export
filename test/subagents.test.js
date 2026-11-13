import { describe, expect, it } from 'vitest'
import { bareSessionId, collectDescendants, listSessionHeaders } from '../src/subagents.js'

/** A header with the fields the walk reads. */
function header(id, parentSession, origin = 'subagent') {
  return { id, ...(parentSession === undefined ? {} : { parentSession }), origin }
}

describe('bareSessionId', () => {
  it('strips the prefix once', () => {
    expect(bareSessionId('session-abc')).toBe('abc')
    expect(bareSessionId('abc')).toBe('abc')
    expect(bareSessionId('session-session-abc')).toBe('session-abc')
  })
})

describe('collectDescendants', () => {
  it('walks children breadth first and reports their depth', () => {
    const headers = [
      header('session-root'),
      header('session-a', 'session-root'),
      header('session-b', 'session-root'),
      header('session-a1', 'session-a'),
    ]
    expect(collectDescendants(headers, 'session-root')).toEqual([
      { header: headers[1], depth: 1 },
      { header: headers[2], depth: 1 },
      { header: headers[3], depth: 2 },
    ])
  })

  it('matches ids with and without the session- prefix', () => {
    const headers = [header('child-1', 'root'), header('other')]
    expect(collectDescendants(headers, 'session-root').map((entry) => entry.header.id)).toEqual(['child-1'])
    expect(collectDescendants(headers, 'root').map((entry) => entry.header.id)).toEqual(['child-1'])
  })

  it('leaves forks alone', () => {
    // A fork records where it branched from, but it is a conversation of its
    // own; folding it into somebody else's export would duplicate it.
    const headers = [header('session-fork', 'session-root', 'fork')]
    expect(collectDescendants(headers, 'session-root')).toEqual([])
  })

  it('ignores sessions with no parent and headers without one', () => {
    const headers = [header('session-lonely'), { id: 'session-plain' }]
    expect(collectDescendants(headers, 'session-root')).toEqual([])
  })

  it('stops at the limit', () => {
    const headers = ['a', 'b', 'c', 'd'].map((id) => header(`session-${id}`, 'session-root'))
    expect(collectDescendants(headers, 'session-root', 2)).toHaveLength(2)
  })

  it('survives a cycle', () => {
    const headers = [header('session-a', 'session-b'), header('session-b', 'session-a')]
    expect(collectDescendants(headers, 'session-a')).toHaveLength(1)
  })

  it('returns nothing for an unknown session', () => {
    expect(collectDescendants([header('session-a', 'session-elsewhere')], 'session-root')).toEqual([])
  })
})

describe('listSessionHeaders', () => {
  it('prefers sessionQuery', async () => {
    const ctx = {
      get: (name) =>
        name === 'sessionQuery'
          ? { listSessions: async () => [{ header: { id: 'session-a' } }, { header: { id: 'session-b' } }] }
          : undefined,
    }
    expect(await listSessionHeaders(ctx)).toEqual([{ id: 'session-a' }, { id: 'session-b' }])
  })

  it('falls back to sessionPersistence when there is no query service', async () => {
    const ctx = {
      get: (name) =>
        name === 'sessionPersistence' ? { list: async () => [{ header: { id: 'session-c' } }] } : undefined,
    }
    expect(await listSessionHeaders(ctx)).toEqual([{ id: 'session-c' }])
  })

  it('falls back when the query service throws', async () => {
    const ctx = {
      get: (name) => {
        if (name === 'sessionQuery') return { listSessions: async () => { throw new Error('nope') } }
        if (name === 'sessionPersistence') return { list: async () => [{ header: { id: 'session-d' } }] }
        return undefined
      },
    }
    expect(await listSessionHeaders(ctx)).toEqual([{ id: 'session-d' }])
  })

  it('returns an empty list when nothing can list sessions', async () => {
    expect(await listSessionHeaders({ get: () => undefined })).toEqual([])
  })

  it('drops records without a header id', async () => {
    const ctx = {
      get: (name) =>
        name === 'sessionQuery'
          ? { listSessions: async () => [{ header: { id: 'session-a' } }, { header: {} }, null] }
          : undefined,
    }
    expect(await listSessionHeaders(ctx)).toEqual([{ id: 'session-a' }])
  })
})
