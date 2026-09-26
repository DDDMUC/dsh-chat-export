import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync, constants } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { dshHome, newestGeneration, readArtifactDirectly } from '../src/sources.js'

/** One checksummed Zstandard frame, the way persistence writes them. */
function frame(line) {
  return zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'), { params: { [constants.ZSTD_c_checksumFlag]: 1 } })
}

/** A session directory holding the given generations. */
function sessionDir(lines, versions) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-chat-export-artifact-'))
  // One project-key directory, the way the real layout nests it:
  // <sessions>/<escaped cwd>/<sessionId>/
  const project = join(root, '--tmp-Project--')
  const dir = join(project, 'session-11111111-2222-3333-4444-555555555555')
  mkdirSync(dir, { recursive: true })
  const header = { type: 'session', version: 3, id: 'session-11111111-2222-3333-4444-555555555555', cwd: '/tmp/x' }
  const events = Array.from({ length: lines }, (_value, index) => ({ type: 'x', seq: index, time: 1, data: { index } }))
  for (const version of versions) {
    const batches = [[header], ...events.map((event) => [event])]
    writeFileSync(
      join(dir, `session.v${version}.jsonl.zstd`),
      Buffer.concat(batches.map((batch) => frame(batch.map((line) => JSON.stringify(line)).join('\n')))),
    )
  }
  return { root, dir }
}

describe('newestGeneration', () => {
  it('picks the highest generation when several are present', () => {
    const { dir } = sessionDir(2, [3, 4])
    expect(newestGeneration(dir)).toBe(join(dir, 'session.v4.jsonl.zstd'))
  })

  it('picks a double-digit generation over a single-digit one', () => {
    const { dir } = sessionDir(1, [4, 10])
    expect(newestGeneration(dir)).toBe(join(dir, 'session.v10.jsonl.zstd'))
  })

  it('returns undefined when no session artifact is present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-chat-export-empty-'))
    expect(newestGeneration(dir)).toBeUndefined()
  })
})

describe('readArtifactDirectly', () => {
  it('reads the newest generation, not the oldest', () => {
    const { root } = sessionDir(3, [3, 4])
    try {
      const read = readArtifactDirectly('session-11111111-2222-3333-4444-555555555555', undefined, { root })
      expect(read).toBeDefined()
      expect(read.source).toBe('artifact')
      expect(read.events).toHaveLength(3)
      expect(read.header.id).toBe('session-11111111-2222-3333-4444-555555555555')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('accepts the bare-uuid spelling too', () => {
    const { root } = sessionDir(1, [4])
    try {
      expect(readArtifactDirectly('11111111-2222-3333-4444-555555555555', undefined, { root })?.events).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('returns undefined for a session that is not on disk', () => {
    expect(readArtifactDirectly('session-00000000-0000-0000-0000-000000000000')).toBeUndefined()
  })
})

describe('dshHome', () => {
  const home = join(homedir(), '.dsh')

  it('falls back to ~/.dsh for every unusable spelling', () => {
    for (const value of [undefined, '', '   ', 'undefined', 'null', 'UNDEFINED', 'Null']) {
      expect(dshHome({ DSH_HOME: value }), String(value)).toBe(home)
    }
  })

  it('honours an explicit home', () => {
    expect(dshHome({ DSH_HOME: '/tmp/custom-dsh' })).toBe('/tmp/custom-dsh')
  })

  it('expands a tilde prefix', () => {
    expect(dshHome({ DSH_HOME: '~/alt-dsh' })).toBe(join(homedir(), 'alt-dsh'))
    expect(dshHome({ DSH_HOME: '~' })).toBe(homedir())
  })

  it('makes sessions a child of the resolved home', () => {
    expect(join(dshHome({ DSH_HOME: '/tmp/custom-dsh' }), 'sessions')).toBe('/tmp/custom-dsh/sessions')
  })

  it('reads the real environment when none is injected', () => {
    expect(dshHome()).toBe(join(dshHome(process.env)))
  })
})
