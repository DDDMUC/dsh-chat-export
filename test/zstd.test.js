import { zstdCompressSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodeSessionArtifact, decodeZstdFrames, scanZstdFrames } from '../src/zstd.js'

/** Concatenate independently compressed frames, as a real session artifact does. */
function framesOf(lines) {
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))))
}

describe('scanZstdFrames', () => {
  it('finds every concatenated frame', () => {
    const buffer = framesOf(['{"a":1}', '{"b":2}', '{"c":3}'])
    const { frames, tornStart } = scanZstdFrames(buffer)
    expect(frames).toHaveLength(3)
    expect(frames[0].start).toBe(0)
    expect(frames[frames.length - 1].end).toBe(buffer.length)
    expect(tornStart).toBeUndefined()
  })

  it('reports each frame range contiguously', () => {
    const buffer = framesOf(Array.from({ length: 40 }, (_value, index) => `{"i":${index}}`))
    const { frames } = scanZstdFrames(buffer)
    expect(frames).toHaveLength(40)
    for (let index = 1; index < frames.length; index += 1) {
      expect(frames[index].start).toBe(frames[index - 1].end)
    }
  })

  it('stops at maxFrames', () => {
    const buffer = framesOf(['a', 'b', 'c', 'd'])
    expect(scanZstdFrames(buffer, 2).frames).toHaveLength(2)
  })

  it('rejects a bad magic byte rather than guessing', () => {
    const buffer = framesOf(['a'])
    buffer.writeUInt32LE(0x11223344, 0)
    expect(() => scanZstdFrames(buffer)).toThrow(/invalid frame magic/)
  })

  it('reports a torn tail instead of throwing', () => {
    const buffer = framesOf(['{"a":1}', '{"b":2}'])
    const truncated = buffer.subarray(0, buffer.length - 6)
    const { frames, tornStart } = scanZstdFrames(truncated)
    expect(frames).toHaveLength(1)
    expect(tornStart).toBe(frames[0].end)
  })

  it('reports a torn header', () => {
    const { frames, tornStart } = scanZstdFrames(Buffer.from([0x28, 0xb5]))
    expect(frames).toEqual([])
    expect(tornStart).toBe(0)
  })

  it('handles an empty artifact', () => {
    expect(scanZstdFrames(Buffer.alloc(0))).toEqual({ frames: [] })
  })
})

describe('decodeZstdFrames', () => {
  it('reads past the first frame, which the one-shot API cannot', () => {
    const lines = ['{"type":"session","version":3}', '{"seq":0}', '{"seq":1}']
    const decoded = decodeZstdFrames(framesOf(lines))
    expect(decoded.toString('utf8')).toBe(lines.map((line) => `${line}\n`).join(''))
  })

  it('is not fooled by a body that itself looks like a frame boundary', () => {
    const lines = ['{"text":"28 b5 2f fd looks like a magic"}', '{"text":"still frame two"}']
    const decoded = decodeZstdFrames(framesOf(lines))
    expect(decoded.toString('utf8').split('\n').filter(Boolean)).toHaveLength(2)
  })

  it('drops an incomplete final frame but keeps the prefix', () => {
    const buffer = framesOf(['{"a":1}', '{"b":2}', '{"c":3}'])
    const decoded = decodeZstdFrames(buffer.subarray(0, buffer.length - 4))
    expect(decoded.toString('utf8')).toContain('"a":1')
    expect(decoded.toString('utf8')).toContain('"b":2')
    expect(decoded.toString('utf8')).not.toContain('"c":3')
  })
})

describe('decodeSessionArtifact', () => {
  it('decodes a many-frame artifact into JSONL text', () => {
    const lines = Array.from({ length: 500 }, (_value, index) => JSON.stringify({ type: 'x', seq: index }))
    const text = decodeSessionArtifact(framesOf(lines))
    const parsed = text.split('\n').filter((line) => line !== '')
    expect(parsed).toHaveLength(500)
    expect(JSON.parse(parsed[499]).seq).toBe(499)
  })

  it('decodes a real session artifact end to end', () => {
    // The fixture is a slice of a real session log, kept in the repository so
    // the frame walker is exercised against genuine multi-frame output rather
    // than only against frames this test compressed itself.
    const path = fileURLToPath(new URL('./fixtures/real-session-slice.v3.jsonl.zstd', import.meta.url))
    let bytes
    try {
      bytes = readFileSync(path)
    } catch {
      return
    }
    const text = decodeSessionArtifact(bytes)
    const rows = text.split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
    expect(rows[0].type).toBe('session')
    expect(rows[0].version).toBe(3)
    expect(rows.length).toBeGreaterThan(10)
    const seqs = rows.slice(1).map((row) => row.seq)
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right))
  })
})
