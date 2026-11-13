// dsh-chat-export - assembling one export artifact.
//
// The orchestration is separated from the HTTP layer so it can be tested with
// stub loaders instead of a live host: given a header, an event log, and two
// async byte loaders, this module returns the exact bytes and filename a route
// would hand to the browser.

import { buildTranscript, attachmentKey } from './transcript.js'
import { renderMarkdown } from './markdown.js'
import { renderText } from './text.js'
import { escapeHtml, renderHtml } from './html.js'
import { buildZip } from './zip.js'
import { buildLogArtifact, LOG_FILENAME } from './log.js'
import { effectiveImageMode, exportBaseName, exportFilename, contentTypeFor, PLUGIN_ID } from './options.js'
import { mediaExtension } from './sources.js'

/** Push every ATX heading down one level, so a child keeps its own outline. */
function demoteHeadings(markdown) {
  return markdown.replace(/^(#{1,5}) /gmu, '#$1 ')
}

/**
 * The Markdown appendix: one section per subagent, in discovery order.
 *
 * Children are appended rather than inlined at the delegation call: the parent
 * log records the call, not the child's id, so matching them would be a guess.
 */
function withMarkdownSubagents(markdown, children, imageSrc) {
  if (children.length === 0) return markdown
  const parts = [markdown, '\n\n---\n\n', `# 子会话（${children.length}）\n`]
  for (const child of children) {
    const title = child.transcript.meta.title === '' ? child.header.id : child.transcript.meta.title
    const arrow = child.depth > 1 ? `${'↳ '.repeat(child.depth - 1)}` : ''
    parts.push(`\n## ${arrow}${title}\n\n`)
    parts.push(`> 派生自主会话 · 深度 ${child.depth} · \`${child.header.id}\`\n\n`)
    parts.push(demoteHeadings(renderMarkdown(child.transcript, { imageSrc })))
    parts.push('\n')
  }
  return parts.join('')
}

/** The body of a rendered document, without its own header, footer, or script. */
function innerBody(document) {
  const start = document.indexOf('<body>')
  const end = document.lastIndexOf('</body>')
  if (start < 0 || end < 0) return document
  return document
    .slice(start + '<body>'.length, end)
    .replace(/<header>[\s\S]*?<\/header>/u, '')
    .replace(/<footer>[\s\S]*?<\/footer>/u, '')
    .replace(/<script>[\s\S]*?<\/script>/gu, '')
}

/**
 * The HTML appendix. Each child keeps the markup it was rendered with, minus
 * the parts that belong to a standalone document.
 */
function withHtmlSubagents(document, children, imageSrc) {
  if (children.length === 0) return document
  const sections = children.map((child) => {
    const title = child.transcript.meta.title === '' ? child.header.id : child.transcript.meta.title
    const meta = `派生自主会话 · 深度 ${child.depth} · ${child.header.id}`
    return [
      '<section class="subagent">',
      `<h2>${escapeHtml(title)}</h2>`,
      `<p class="subagent-meta">${escapeHtml(meta)}</p>`,
      innerBody(renderHtml(child.transcript, { imageSrc })),
      '</section>',
    ].join('\n')
  })
  const anchor = document.lastIndexOf('<footer>')
  const block = `<div class="subagent-list">\n<h1>子会话（${children.length}）</h1>\n${sections.join('\n')}\n</div>\n`
  if (anchor < 0) return document.replace('</body>', `${block}</body>`)
  return `${document.slice(0, anchor)}${block}${document.slice(anchor)}`
}

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

  // Build the children before asset paths are assigned: their images go into
  // the same sink, so one archive carries every attachment both documents use.
  const children = (Array.isArray(input.subagents) ? input.subagents : []).map((child) => {
    const childTranscript = buildTranscript(child.header, child.events, options, sink)
    const title = typeof child.title === 'string' && child.title !== '' ? child.title : childTranscript.meta.title
    if (title !== '') childTranscript.meta.title = title
    return { header: child.header, depth: child.depth ?? 1, transcript: childTranscript }
  })

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
  const markdown = withMarkdownSubagents(renderMarkdown(transcript, { imageSrc }), children, imageSrc)
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
    const html = withHtmlSubagents(renderHtml(transcript, { imageSrc }), children, imageSrc)
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

  // The sidecar is the one lossless artifact: the events go out exactly as the
  // store served them, so `planImport` can replay them without guessing.
  if (format === 'log') {
    const log = buildLogArtifact({ header, events, title: transcript.meta.title })
    return {
      format,
      baseName,
      filename: exportFilename('log', transcript.meta.title, transcript.meta.createdAt),
      contentType: contentTypeFor('log'),
      buffer: Buffer.from(log, 'utf8'),
      files: [{ path: `${baseName}.jsonl`, data: log }],
      transcript,
      missingImages,
      mode,
    }
  }

  // A bundle references its assets relatively, so the same HTML renders on disk.
  const bundleSrc = (ref) => imagePaths.get(attachmentKey(ref)) ?? null
  const bundleHtml = withHtmlSubagents(renderHtml(transcript, { imageSrc: bundleSrc }), children, bundleSrc)
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
  // A bundle can be both readable and replayable: the sidecar sits next to the
  // rendered artifacts and the README-equivalent `meta.json` says it is there.
  if (options.withLog === true) {
    entries.push({ path: LOG_FILENAME, data: buildLogArtifact({ header, events, title: transcript.meta.title }) })
  }
  // A manifest of the images carried in `assets/`, so an import can write the
  // bytes back into the attachment store and relink each reference. The file
  // name alone cannot do that: `assets/001-shot.png` says nothing about which
  // `attachmentId` the events cite.
  entries.push({
    path: 'assets.json',
    data: JSON.stringify(
      images
        .filter((entry) => imageBytes.has(entry.key))
        .map((entry) => ({
          path: imagePaths.get(entry.key),
          attachmentId: typeof entry.ref.attachmentId === 'string' ? entry.ref.attachmentId : '',
          name: typeof entry.ref.name === 'string' ? entry.ref.name : '',
          mediaType: typeof entry.ref.mediaType === 'string' ? entry.ref.mediaType : '',
          bytes: imageBytes.get(entry.key).length,
        })),
      null,
      2,
    ),
  })
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
        importable: options.withLog === true,
        ...options.withLog === true ? { log: LOG_FILENAME } : {},
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
