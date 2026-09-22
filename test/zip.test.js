import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildZip, crc32, safeEntryPath } from '../src/zip.js'

/**
 * Read a ZIP archive back with nothing but the format specification, so the
 * test proves the produced bytes are valid rather than agreeing with the
 * writer's own assumptions.
 * @param buffer - the archive.
 * @returns `[{name, data, method}]` in central-directory order.
 */
function readZip(buffer) {
  let eocd = buffer.length - 22
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1
  if (eocd < 0) throw new Error('no end-of-central-directory record')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory signature')
    const method = buffer.readUInt16LE(offset + 10)
    const expectedCrc = buffer.readUInt32LE(offset + 16)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const uncompressedSize = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header signature')
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength
    const body = buffer.subarray(bodyStart, bodyStart + compressedSize)
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body)

    if (data.length !== uncompressedSize) throw new Error(`${name}: size mismatch`)
    if (crc32(data) !== expectedCrc) throw new Error(`${name}: crc mismatch`)
    entries.push({ name, data, method })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

describe('crc32', () => {
  it('matches the known value for a standard vector', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
  })

  it('is zero for an empty buffer', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})

describe('safeEntryPath', () => {
  it('keeps ordinary paths', () => {
    expect(safeEntryPath('assets/001-a.png')).toBe('assets/001-a.png')
  })

  it('removes traversal segments', () => {
    expect(safeEntryPath('../../etc/passwd')).toBe('etc/passwd')
    expect(safeEntryPath('a/../../b')).toBe('a/b')
  })

  it('normalizes separators and control characters', () => {
    expect(safeEntryPath('a\\b')).toBe('a/b')
    expect(safeEntryPath('a\u0000b')).toBe('a_b')
  })

  it('never returns an empty name', () => {
    expect(safeEntryPath('')).toBe('unnamed')
    expect(safeEntryPath('../')).toBe('unnamed')
  })
})

describe('buildZip', () => {
  it('round-trips a text entry', () => {
    const archive = buildZip([{ path: 'a.txt', data: 'hello' }])
    const entries = readZip(archive)
    expect(entries).toHaveLength(1)
    expect(entries[0].name).toBe('a.txt')
    expect(entries[0].data.toString('utf8')).toBe('hello')
    expect(entries[0].method).toBe(8)
  })

  it('round-trips binary data byte for byte', () => {
    const bytes = Buffer.from(Array.from({ length: 4096 }, (_value, index) => index % 251))
    const entries = readZip(buildZip([{ path: 'assets/a.png', data: bytes }]))
    expect(entries[0].data.equals(bytes)).toBe(true)
  })

  it('supports storing without compression', () => {
    const entries = readZip(buildZip([{ path: 'a.txt', data: 'raw', compress: false }]))
    expect(entries[0].method).toBe(0)
    expect(entries[0].data.toString('utf8')).toBe('raw')
  })

  it('keeps entry order and count', () => {
    const entries = readZip(
      buildZip([
        { path: 'transcript.md', data: '# a' },
        { path: 'transcript.html', data: '<html></html>' },
        { path: 'assets/001-x.png', data: Buffer.from([1, 2, 3]) },
        { path: 'meta.json', data: '{}' },
      ]),
    )
    expect(entries.map((entry) => entry.name)).toEqual(['transcript.md', 'transcript.html', 'assets/001-x.png', 'meta.json'])
  })

  it('handles UTF-8 entry names', () => {
    const entries = readZip(buildZip([{ path: '会话/记录.md', data: 'x' }]))
    expect(entries[0].name).toBe('会话/记录.md')
  })

  it('writes an empty archive for no entries', () => {
    const archive = buildZip([])
    expect(readZip(archive)).toEqual([])
    expect(archive.length).toBe(22)
  })

  it('round-trips a large body', () => {
    const body = 'line\n'.repeat(50_000)
    const entries = readZip(buildZip([{ path: 'big.md', data: body }]))
    expect(entries[0].data.toString('utf8')).toBe(body)
    expect(entries[0].data.length).toBe(body.length)
  })

  it('is accepted by the system unzip when one is available', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-chat-export-zip-'))
    try {
      const path = join(directory, 'bundle.zip')
      writeFileSync(path, buildZip([{ path: 'a.txt', data: 'hello' }, { path: 'nested/b.txt', data: 'world' }]))
      let output
      try {
        output = execFileSync('unzip', ['-t', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (error) {
        // No unzip on this machine; the format assertions above already cover us.
        if (error?.code === 'ENOENT') return
        throw error
      }
      expect(output).toContain('No errors detected')
      const listed = execFileSync('unzip', ['-l', path], { encoding: 'utf8' })
      expect(listed).toContain('a.txt')
      expect(listed).toContain('nested/b.txt')
      const extracted = execFileSync('unzip', ['-p', path, 'nested/b.txt'], { encoding: 'utf8' })
      expect(extracted).toBe('world')
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('survives a real extraction to disk', () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-chat-export-x-'))
    try {
      const path = join(directory, 'b.zip')
      const payload = '中文内容 with emoji 🚀\n'
      writeFileSync(path, buildZip([{ path: 'x/y.txt', data: payload }]))
      let extracted
      try {
        extracted = execFileSync('unzip', ['-p', path, 'x/y.txt'], { encoding: 'utf8' })
      } catch (error) {
        if (error?.code === 'ENOENT') return
        throw error
      }
      expect(extracted).toBe(payload)
      expect(readFileSync(path).length).toBeGreaterThan(0)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
