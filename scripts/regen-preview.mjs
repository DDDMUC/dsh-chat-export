#!/usr/bin/env node
// Regenerate the preview artifacts in `dsh-chat-exports/` without a running host.
//
// This is a development tool, not part of the published package (`files` does
// not include `scripts/`). It decodes real session artifacts straight out of
// `~/.dsh/sessions` with the same multi-frame walker the plugin uses offline,
// then renders every format through the same `produceExport` the HTTP route
// calls - which is how the acceptance run compares a host export against an
// offline one byte for byte.
//
// Usage: node scripts/regen-preview.mjs [sessionId] [outputDir]

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { decodeSessionArtifact } from '../src/zstd.js'
import { produceExport } from '../src/export.js'
import { defaultOptions } from '../src/options.js'

const SESSIONS = [
  { label: '短会话', id: 'session-48310605-bb1a-4966-a207-380f947e220b' },
  { label: '本会话', id: 'session-e81f9424-63ef-47ee-89cd-f42a3cc099a5' },
  { label: '长会话', id: 'session-5e6c2afd-d056-47e6-8654-fb5f7cfc6e9f' },
]

const VARIANTS = [
  { tag: '', overrides: {} },
  { tag: '（全量·带思考）', overrides: { thinking: true, injected: true, system: true } },
]

const FORMATS = ['md', 'html', 'zip', 'txt']

const EXTENSION = { md: 'md', html: 'html', zip: 'zip', txt: 'txt' }

/**
 * Locate a session artifact wherever the workspace key put it.
 * `~/.dsh/sessions` is keyed by an escaped working directory, so the session id
 * is searched for one level down rather than reconstructed.
 */
function sessionDir(id) {
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) return undefined
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(root, entry.name, id)
    if (existsSync(join(candidate, 'session.v3.jsonl.zstd'))) return candidate
  }
  return undefined
}

/**
 * The newest session generation present in a directory.
 *
 * A session directory can hold several generations at once after a format
 * upgrade (`session.v3.jsonl.zstd` next to `session.v4.jsonl.zstd`), and the
 * newest one is the one that carries every event: the older is the pre-migration
 * snapshot. Returns undefined when the directory holds none.
 */
function newestGeneration(dir) {
  const present = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => /^session\.(v\d+)\.jsonl\.zstd$/u.exec(entry.name))
    .filter((match) => match !== null)
    .map((match) => ({ version: Number(match[1]), name: match[0] }))
    .sort((left, right) => right.version - left.version)
  return present.length === 0 ? undefined : join(dir, present[0].name)
}

/** Read one image straight out of the content-addressed attachment store. */
async function loadImage(ref) {
  const hex = String(ref.attachmentId).replace(/^sha256:/u, '')
  const path = join(homedir(), '.dsh', 'attachments', 'v1', 'objects', hex.slice(0, 2), hex)
  return existsSync(path) ? readFileSync(path) : undefined
}

// An empty argument means "no filter", not "match nothing".
const only = process.argv[2] || undefined
const outDir = process.argv[3] ?? join(process.cwd(), '..', 'dsh-chat-exports')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

for (const { label, id } of SESSIONS) {
  if (only !== undefined && id !== only) continue
  const dir = sessionDir(id)
  if (dir === undefined) {
    console.log(`跳过 ${label}（找不到 ${id}）`)
    continue
  }
  const rows = decodeSessionArtifact(readFileSync(newestGeneration(dir)))
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line))
  const header = rows[0]
  const events = rows.slice(1)

  for (const { tag, overrides } of VARIANTS) {
    for (const format of FORMATS) {
      const artifact = await produceExport({
        header,
        events,
        options: { ...defaultOptions(), ...overrides, format },
        loadImage,
      })
      const filename = `预览-${label}${tag}.${EXTENSION[format]}`
      writeFileSync(join(outDir, filename), artifact.buffer)
      console.log(`${filename.padEnd(32)} ${(artifact.buffer.length / 1024).toFixed(0).padStart(6)} KiB`)
    }
  }
}
