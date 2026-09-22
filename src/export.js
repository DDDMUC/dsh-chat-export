// dsh-chat-export - assembling one export artifact.
//
// The orchestration is separated from the HTTP layer so it can be tested with
// stub loaders instead of a live host: given a header, an event log, and two
// async byte loaders, this module returns the exact bytes and filename a route
// would hand to the browser.

import { buildTranscript, attachmentKey } from './transcript.js'
import { renderMarkdown } from './markdown.js'
import { renderText } from './text.js'
import { renderHtml } from './html.js'
import { buildZip } from './zip.js'
import { effectiveImageMode, exportBaseName, exportFilename, contentTypeFor, PLUGIN_ID } from './options.js'
import { mediaExtension } from './sources.js'

/** Sanitize one path segment derived from an untrusted attachment name. */
function safeSegment(value, fallback) {
  const cleaned = String(value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/gu, '')
    .replace(/[\\/:*?"<>|]/gu, '_')
    .replace(/^\.+/u, '')
    .trim()
  return cleaned === '' ? fallback : cleaned
}

/**
 * The archive path for one image reference.
 * @param index - 1-based position in the export.
 * @param ref - the durable image reference.
 * @returns a path under `assets/`.
 */
export function imageAssetPath(index, ref) {
  const extension = mediaExtension(ref.mediaType)
  const name = safeSegment(ref.name, `image-${String(index).padStart(3, '0')}`)
  const withExtension = name.toLowerCase().endsWith(`.${extension}`) ? name : `${name}.${extension}`
  return `assets/${String(index).padStart(3, '0')}-${withExtension}`
}

/** The archive path for one generic file reference. */
export function fileAssetPath(ref) {
  return `files/${safeSegment(ref.name, 'file')}`
}

/** A `data:` URI for one image. */
export function dataUri(ref, bytes) {
  return `data:${ref.mediaType ?? 'application/octet-stream'};base64,${bytes.toString('base64')}`
}

/**
 * Produce the export artifact for one session.
 *
 * @param input - `{ header, events, title?, options, loadImage?, loadFile? }`.
 *   `loadImage(ref)` and `loadFile(ref)` return a Buffer or undefined; they are
 *   the only I/O this function performs.
 * @returns `{ format, baseName, filename, contentType, buffer, files, transcript, missingImages }`.
 */
export async function produceExport(input) {
  const { header, events, options } = input
  const loadImage = input.loadImage ?? (async () => undefined)
  const loadFile = input.loadFile ?? (async () => undefined)
  const mode = effectiveImageMode(options.format, options)

  const sink = { images: new Map(), files: new Map() }
  const transcript = buildTranscript(header, events, options, sink)
  if (typeof input.title === 'string' && input.title !== '') transcript.meta.title = input.title

  // Assign every asset its final archive path up front: the renderers need the
  // paths, and the paths have to be stable across the Markdown, the HTML, and
  // the archive listing.
  const imagePaths = new Map()
  const images = []
  let index = 0
  for (const [key, ref] of sink.images) {
    index += 1
    imagePaths.set(key, imageAssetPath(index, ref))
    images.push({ key, ref })
  }

  const imageBytes = new Map()
  const missingImages = []
  if (mode !== 'none') {
    for (const entry of images) {
      const bytes = await loadImage(entry.ref)
      if (bytes === undefined || bytes === null) missingImages.push(entry.ref)
      else imageBytes.set(entry.key, bytes)
    }
  }

  const imageSrc = (ref) => {
    if (mode === 'none') return null
    const key = attachmentKey(ref)
    const bytes = imageBytes.get(key)
    if (bytes === undefined) return null
    if (mode === 'embed') return dataUri(ref, bytes)
    return imagePaths.get(key) ?? null
  }

  const baseName = exportBaseName(transcript.meta.title, transcript.meta.createdAt)
  const markdown = renderMarkdown(transcript, { imageSrc })
  const format = options.format

  if (format === 'md') {
    return {
      format,
      baseName,
      filename: exportFilename('md', transcript.meta.title, transcript.meta.createdAt),
      contentType: contentTypeFor('md'),
      buffer: Buffer.from(markdown, 'utf8'),
      files: [{ path: `${baseName}.md`, data: markdown }],
      transcript,
      missingImages,
      mode,
    }
  }

  if (format === 'txt') {
    const text = renderText(transcript)
    return {
      format,
      baseName,
      filename: exportFilename('txt', transcript.meta.title, transcript.meta.createdAt),
      contentType: contentTypeFor('txt'),
      buffer: Buffer.from(text, 'utf8'),
      files: [{ path: `${baseName}.txt`, data: text }],
      transcript,
      missingImages,
      mode,
    }
  }

  if (format === 'html') {
    const html = renderHtml(transcript, { imageSrc })
    return {
      format,
      baseName,
      filename: exportFilename('html', transcript.meta.title, transcript.meta.createdAt),
      contentType: contentTypeFor('html'),
      buffer: Buffer.from(html, 'utf8'),
      files: [{ path: `${baseName}.html`, data: html }],
      transcript,
      missingImages,
      mode,
    }
  }

  // A bundle references its assets relatively, so the same HTML renders on disk.
  const bundleHtml = renderHtml(transcript, { imageSrc: (ref) => imagePaths.get(attachmentKey(ref)) ?? null })
  const bundleText = renderText(transcript)
  const entries = [
    { path: `${baseName}.md`, data: markdown },
    { path: `${baseName}.html`, data: bundleHtml },
    { path: `${baseName}.txt`, data: bundleText },
  ]
  for (const entry of images) {
    const bytes = imageBytes.get(entry.key)
    if (bytes === undefined) continue
    entries.push({ path: imagePaths.get(entry.key), data: bytes })
  }
  for (const [key, ref] of sink.files) {
    const bytes = await loadFile(ref)
    if (bytes === undefined || bytes === null) continue
    entries.push({ path: fileAssetPath(ref), data: bytes })
    void key
  }
  entries.push({
    path: 'meta.json',
    data: JSON.stringify(
      {
        tool: PLUGIN_ID,
        exportedAt: new Date().toISOString(),
        sessionId: transcript.meta.sessionId,
        title: transcript.meta.title,
        cwd: transcript.meta.cwd,
        createdAt: transcript.meta.createdAt,
        updatedAt: transcript.meta.updatedAt,
        models: transcript.meta.models,
        usage: transcript.meta.usage,
        counts: transcript.meta.counts,
        options,
      },
      null,
      2,
    ),
  })

  const zipBuffer = buildZip(entries, { modifiedAt: transcript.meta.updatedAt || undefined })

  return {
    format: 'zip',
    baseName,
    filename: exportFilename('zip', transcript.meta.title, transcript.meta.createdAt),
    contentType: contentTypeFor('zip'),
    buffer: zipBuffer,
    files: entries,
    transcript,
    missingImages,
    mode,
  }
}
