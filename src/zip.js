// dsh-chat-export - a minimal ZIP writer.
//
// The bundle format needs a real archive (a Markdown file plus an `assets/`
// directory cannot be downloaded as one artifact any other way), but the
// plugin ships zero runtime dependencies on purpose, so the archive is written
// here: local headers, a central directory, and an end-of-central-directory
// record, with `node:zlib`'s raw deflate as the only borrowed primitive.
//
// Scope is deliberately narrow - the entries this plugin produces are small in
// number, flat, and have no comments, extra fields, encryption, or ZIP64. Any
// of those would need more format than the feature is worth.

import { deflateRawSync, inflateRawSync } from 'node:zlib'

/** CRC-32 lookup table, built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * CRC-32 of a byte buffer, as ZIP requires it.
 * @param buffer - the bytes.
 * @returns the unsigned 32-bit checksum.
 */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time pair for one epoch millisecond value. */
function dosDateTime(epochMs) {
  const date = new Date(epochMs)
  const year = Math.max(1980, date.getFullYear())
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  }
}

/** Coerce an entry's payload into bytes. */
function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  return Buffer.from(String(value ?? ''), 'utf8')
}

/**
 * Normalize an archive path.
 *
 * A ZIP entry name is read by whatever tool opens the archive, so a traversal
 * segment in an untrusted name is a real hazard rather than a cosmetic one.
 *
 * @param path - the requested entry name.
 * @returns a relative, forward-slashed, traversal-free entry name.
 */
export function safeEntryPath(path) {
  const cleaned = String(path ?? '')
    .replace(/\\/gu, '/')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, '_')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .map((segment) => segment.replace(/^\/+/u, ''))
    .join('/')
  return cleaned === '' ? 'unnamed' : cleaned
}

/**
 * Build a ZIP archive.
 *
 * @param entries - `[{path, data, compress?}]`; `data` is a string, Buffer, or
 *   Uint8Array, and `compress` defaults to true.
 * @param options - `{ modifiedAt? }` epoch milliseconds stamped on every entry.
 * @returns the complete archive bytes.
 */
export function buildZip(entries, options = {}) {
  const modifiedAt = typeof options.modifiedAt === 'number' ? options.modifiedAt : Date.now()
  const stamp = dosDateTime(modifiedAt)
  const localParts = []
  const centralParts = []
  let offset = 0
  let count = 0

  for (const entry of entries) {
    const name = Buffer.from(safeEntryPath(entry.path), 'utf8')
    const raw = toBuffer(entry.data)
    const compress = entry.compress !== false
    const body = compress ? deflateRawSync(raw, { level: 9 }) : raw
    const method = compress ? 8 : 0
    const checksum = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(stamp.time, 10)
    local.writeUInt16LE(stamp.date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(0x031e, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(stamp.time, 12)
    central.writeUInt16LE(stamp.date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + body.length
    count += 1
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, end])
}

/**
 * Read a ZIP archive into a name → bytes map.
 *
 * Scope mirrors `buildZip`: stored (0) and raw deflate (8) entries, no
 * encryption, no ZIP64, no multi-disk. Each entry's size and CRC are verified,
 * so a corrupted archive is rejected instead of imported half-broken.
 *
 * @param buffer - the archive bytes.
 * @returns `Map<string, Buffer>` in central-directory order.
 */
export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  // The end-of-central-directory record sits at the very end (its comment is
  // empty in everything this plugin writes), but scan back over the maximum
  // comment length so a foreign archive with a comment still resolves.
  let eocd = -1
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 22 - 0xffff; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('not a zip archive: no end-of-central-directory record')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = new Map()
  for (let index = 0; index < count; index += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory signature')
    const method = buf.readUInt16LE(offset + 10)
    const expectedCrc = buf.readUInt32LE(offset + 16)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const uncompressedSize = buf.readUInt32LE(offset + 24)
    const nameLength = buf.readUInt16LE(offset + 28)
    const extraLength = buf.readUInt16LE(offset + 30)
    const commentLength = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLength)
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header signature')
    const localNameLength = buf.readUInt16LE(localOffset + 26)
    const localExtraLength = buf.readUInt16LE(localOffset + 28)
    const bodyStart = localOffset + 30 + localNameLength + localExtraLength
    const body = buf.subarray(bodyStart, bodyStart + compressedSize)
    let data
    if (method === 0) data = Buffer.from(body)
    else if (method === 8) data = inflateRawSync(body)
    else throw new Error(`unsupported compression method ${method}`)
    if (data.length !== uncompressedSize) throw new Error(`${name}: size mismatch`)
    if (crc32(data) !== expectedCrc) throw new Error(`${name}: crc mismatch`)
    entries.set(name, data)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}
