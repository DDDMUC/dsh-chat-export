// dsh-chat-export - multi-frame Zstandard session-log decoding.
//
// A `session.v3.jsonl.zstd` artifact is NOT one Zstandard stream: it is a
// concatenation of independent frames (one for the header line, one per durable
// append batch) - a 9.6 MB session on the reference machine holds 39,968 of
// them. Node's convenience APIs both get this wrong for our purposes:
//
//   * `zstdDecompressSync(wholeFile)` silently decodes ONLY the first frame and
//     returns just the header line;
//   * `createZstdDecompress()` decodes the first frame and then throws
//     `ZSTD_error_prefix_unknown` on the second.
//
// So frame boundaries are walked here by parsing each frame header and block
// list, then every frame is handed to `zstdDecompressSync` on its own. This is
// the same algorithm the official `dsh-session-persistence-jsonl` backend uses.
//
// The plugin's primary read path is `sessionPersistence.open(id, 'read')`,
// which owns framing, format migration, and torn-tail recovery. This module
// exists for the offline path (reading a session directory or an extracted ZIP
// without a running host) and so those boundaries can be unit-tested directly.

import { zstdDecompressSync } from 'node:zlib'

/** Zstandard frame magic, little-endian `0xFD2FB528`. */
const ZSTD_MAGIC = 0xfd2fb528

/** How many bytes of a frame header precede its block list, at most. */
const MAX_FRAME_HEADER_BYTES = 18

/**
 * Locate every complete frame in a Zstandard artifact.
 *
 * A structural problem that cannot be a torn write (bad magic, a reserved bit,
 * a reserved block type) throws, because the caller must not silently export
 * half a conversation. Running out of bytes inside a frame is different: it is
 * a normal torn tail on a live log, so the incomplete frame's start offset is
 * reported instead and the complete prefix is still usable.
 *
 * @param buffer - bytes currently present in the session artifact.
 * @param maxFrames - optional complete-frame limit for metadata-only readers.
 * @returns `{ frames: [{start, end}], tornStart? }`.
 */
export function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 24) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (remainingHeaderBytes > MAX_FRAME_HEADER_BYTES) {
      throw new Error(`corrupt Zstandard session log: implausible frame header at byte ${start}`)
    }
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      if (blockType === 3) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      // A compressed block stores `blockSize` payload bytes; a raw block stores
      // exactly `blockSize`; an RLE block stores one byte that expands to it.
      const payloadBytes = blockType === 1 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }
  return { frames }
}

/**
 * Decode every complete frame of a Zstandard artifact.
 *
 * An incomplete final frame is dropped rather than failing the read: a session
 * being written while it is exported legitimately ends mid-frame, and the
 * complete prefix is exactly what the host's own persistence layer would serve.
 *
 * @param buffer - the artifact bytes.
 * @returns the concatenated plaintext of every complete frame.
 */
export function decodeZstdFrames(buffer) {
  const { frames } = scanZstdFrames(buffer)
  const parts = []
  for (const frame of frames) {
    parts.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts)
}

/**
 * Decode a session artifact into its JSONL text.
 * @param buffer - the `.jsonl.zstd` bytes.
 * @returns the decoded text.
 */
export function decodeSessionArtifact(buffer) {
  return decodeZstdFrames(buffer).toString('utf8')
}
