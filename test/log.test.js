import { describe, expect, it } from 'vitest'
import { LOG_FILENAME, LOG_KIND, LogFormatError, buildLogArtifact, parseLogArtifact } from '../src/log.js'

const header = {
  type: 'session',
  version: '4',
  id: 'session-11111111-2222-3333-4444-555555555555',
  createdAt: '1791617627977',
  cwd: '/Users/someone/project',
  isSeeded: 'false',
}

const events = [
  { type: 'turn/start', seq: 0, time: 1791617628145, data: { turn: 1 } },
  { type: 'user/message', seq: 1, time: 1791617632296, data: { content: [{ type: 'text', text: '你好' }], source: { kind: 'user' }, role: 'user', id: 'm1' } },
  { type: 'turn/end', seq: 2, time: 1791618088257, data: { turn: 1, reason: { kind: 'completed' } } },
]

describe('buildLogArtifact', () => {
  it('writes an envelope line, then the events verbatim', () => {
    const text = buildLogArtifact({ header, events, title: '示例会话', exportedAt: '2026-10-25T00:00:00.000Z' })
    const lines = text.trimEnd().split('\n')
    expect(lines).toHaveLength(events.length + 1)
    const envelope = JSON.parse(lines[0])
    expect(envelope.kind).toBe(LOG_KIND)
    expect(envelope.eventCount).toBe(3)
    expect(envelope.title).toBe('示例会话')
    expect(envelope.session.id).toBe(header.id)
    expect(JSON.parse(lines[1])).toEqual(events[0])
    expect(text.endsWith('\n')).toBe(true)
  })

  it('defaults the filename constant to log.jsonl', () => {
    expect(LOG_FILENAME).toBe('log.jsonl')
  })
})

describe('parseLogArtifact', () => {
  it('round-trips an artifact this plugin wrote', () => {
    const parsed = parseLogArtifact(buildLogArtifact({ header, events, title: '示例会话' }))
    expect(parsed.header.id).toBe(header.id)
    expect(parsed.title).toBe('示例会话')
    expect(parsed.events).toEqual(events)
    expect(parsed.warnings).toEqual([])
  })

  it('reads a raw session artifact whose first line is the header', () => {
    const text = [header, ...events].map((row) => JSON.stringify(row)).join('\n')
    const parsed = parseLogArtifact(text)
    expect(parsed.header).toEqual(header)
    expect(parsed.events).toHaveLength(3)
  })

  it('reads a bare JSON array of events', () => {
    const parsed = parseLogArtifact(JSON.stringify(events))
    expect(parsed.header).toEqual({})
    expect(parsed.events).toHaveLength(3)
  })

  it('accepts bytes and strips a BOM', () => {
    const text = `\uFEFF${buildLogArtifact({ header, events })}`
    const parsed = parseLogArtifact(Buffer.from(text, 'utf8'))
    expect(parsed.events).toHaveLength(3)
  })

  it('refuses an empty file', () => {
    expect(() => parseLogArtifact('   ')).toThrow(LogFormatError)
    try {
      parseLogArtifact('')
    } catch (error) {
      expect(error.code).toBe('empty')
    }
  })

  it('names the line that is not JSON', () => {
    const text = `${JSON.stringify(events[0])}\n{ broken`
    try {
      parseLogArtifact(text)
      throw new Error('should have thrown')
    } catch (error) {
      expect(error.code).toBe('invalid-line')
      expect(error.message).toContain('第 2 行')
    }
  })

  it('refuses a file that carries a header and no events', () => {
    try {
      parseLogArtifact(JSON.stringify(header))
      throw new Error('should have thrown')
    } catch (error) {
      expect(error.code).toBe('no-events')
    }
  })
})
