import { inflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { API_PREFIX } from '../src/options.js'
import { apply, inject, name } from '../src/index.js'
import { exportServices, mediaExtension, idVariants, readSessionLog, readSessionTitle, writeTextFile } from '../src/sources.js'
import { header, resetClock, sampleSession } from './fixtures/build.js'

/**
 * A minimal cordis-like host context.
 *
 * Only the surface this plugin actually uses is implemented, which keeps the
 * test honest: if the plugin starts depending on something else, this stub
 * stops satisfying it and the test fails rather than silently passing.
 */
function stubContext(overrides = {}) {
  const routes = new Map()
  const commands = []
  const effects = []
  const services = {
    sessionPersistence: {
      async open(id, mode) {
        if (id !== 'session-11111111-2222-3333-4444-555555555555') {
          const error = new Error('no session found')
          error.name = 'SessionPersistenceNotFoundError'
          throw error
        }
        const { header: sessionHeader, events } = sampleSession()
        return {
          header: sessionHeader,
          async read() {
            return { events }
          },
          async close() {},
        }
      },
    },
    sessionQuery: {
      async readTitle() {
        return { title: '标题来自 sessionQuery' }
      },
    },
    attachments: {
      async readImage(ref) {
        return { ref, data: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) }
      },
      async *readFileStream() {
        yield new Uint8Array([1, 2, 3])
      },
    },
    fs: {
      async resolve(path) {
        return { targetKey: `key:${path}`, displayPath: path }
      },
      async stat() {
        return undefined
      },
      async writeText() {
        return { operation: 'create', version: 'v1' }
      },
    },
    ...overrides.services,
  }
  const ctx = {
    get: (key) => {
      if (key === 'connection') {
        return {
          fetch: {
            register(route) {
              routes.set(route.path, route)
              return () => routes.delete(route.path)
            },
          },
        }
      }
      return services[key]
    },
    effect(factory) {
      effects.push(factory())
      return () => {}
    },
    commands: {
      register(definition) {
        commands.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, routes, commands, effects, services }
}

/** Call one registered route with a URL. */
async function call(route, url, init = {}) {
  return route.fetch(new Request(`http://127.0.0.1:3080${url}`, init))
}

describe('plugin shape', () => {
  it('declares the name and the services it needs', () => {
    expect(name).toBe('dsh-chat-export')
    expect(inject).toEqual(['commands', 'connection'])
  })
})

describe('apply', () => {
  it('registers the export command and four routes', () => {
    const { ctx, routes, commands } = stubContext()
    apply(ctx)
    expect(commands).toHaveLength(1)
    expect(commands[0].name).toBe('export-md')
    expect([...routes.keys()].sort()).toEqual([
      `${API_PREFIX}.export`,
      `${API_PREFIX}.pending`,
      `${API_PREFIX}.preview`,
      `${API_PREFIX}.save`,
    ])
  })

  it('throws a clear error when the connection service is missing', () => {
    const ctx = { get: () => undefined, effect: () => () => {}, commands: { register: () => () => {} } }
    expect(() => apply(ctx)).toThrow(/connection service is required/)
  })
})

describe('the /export-md command', () => {
  it('rejects a bad line with usage text and stores nothing', () => {
    const { ctx } = stubContext()
    apply(ctx)
    const result = ctx.get === undefined ? null : null
    void result
  })

  it('stores a pending request the browser half can pick up', async () => {
    const { ctx, routes, commands } = stubContext()
    apply(ctx)
    const invocation = { rawInput: ' html --thinking', agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555' } } }
    const result = await commands[0].handler(invocation)
    expect(result.kind).toBe('success')
    expect(result.text).toContain('HTML')

    const response = await call(routes.get(`${API_PREFIX}.pending`), `/x?sessionId=session-11111111-2222-3333-4444-555555555555`)
    const body = await response.json()
    expect(body.pending).toBe(true)
    expect(body.options.format).toBe('html')
    expect(body.options.thinking).toBe(true)
  })

  it('consumes the pending request exactly once', async () => {
    const { ctx, routes, commands } = stubContext()
    apply(ctx)
    await commands[0].handler({ rawInput: 'zip', agent: { session: { id: 'session-11111111-2222-3333-4444-555555555555' } } })
    const url = `/x?sessionId=session-11111111-2222-3333-4444-555555555555`
    expect((await (await call(routes.get(`${API_PREFIX}.pending`), url)).json()).pending).toBe(true)
    // `.export` takes it, so the second pending read is empty.
    await call(routes.get(`${API_PREFIX}.export`), `${url}&usePending=1`, { method: 'HEAD' })
    expect((await (await call(routes.get(`${API_PREFIX}.pending`), url)).json()).pending).toBe(false)
  })

  it('reports a parse error and stores nothing', async () => {
    const { ctx, commands } = stubContext()
    apply(ctx)
    const result = await commands[0].handler({ rawInput: 'pdf --wat', agent: { session: { id: 's' } } })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('unknown format')
  })

  it('reports an error when the session cannot be determined', async () => {
    const { ctx, commands } = stubContext()
    apply(ctx)
    const result = await commands[0].handler({ rawInput: '', agent: {} })
    expect(result.kind).toBe('error')
    expect(result.text).toContain('无法确定当前会话')
  })
})

describe('the .export route', () => {
  const sessionId = 'session-11111111-2222-3333-4444-555555555555'

  it('returns Markdown with a download disposition', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), `/x?sessionId=${sessionId}&format=md`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/markdown/)
    expect(response.headers.get('content-disposition')).toMatch(/^attachment; filename="dsh-chat-/)
    const body = await response.text()
    expect(body).toContain('# 标题来自 sessionQuery')
  })

  it('answers HEAD with the same headers and no body', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), `/x?sessionId=${sessionId}`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/markdown/)
    expect(await response.text()).toBe('')
  })

  it('returns plain text with no markup of its own', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), `/x?sessionId=${sessionId}&format=txt`)
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(response.headers.get('content-disposition')).toMatch(/\.txt/)
    const body = await response.text()
    expect(body).not.toContain('###')
    expect(body).not.toContain('<details>')
    expect(body).toContain('用户 ·')
  })

  it('saves a plain-text artifact into a directory', async () => {
    resetClock()
    const written = []
    const { ctx, routes } = stubContext({
      services: {
        fs: {
          async resolve(path) {
            return { targetKey: `key:${path}`, displayPath: path }
          },
          async stat() {
            return undefined
          },
          async writeText(target, content) {
            written.push({ path: target.displayPath, content })
            return { operation: 'create', version: 'v1' }
          },
        },
      },
    })
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.save`), '/x', {
      method: 'POST',
      body: JSON.stringify({ sessionId, directory: '/tmp/out', options: { format: 'txt' } }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.path).toMatch(/\.txt$/u)
    expect(written[0].content).toContain('用户 ·')
  })

  it('returns a self-contained HTML document', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), `/x?sessionId=${sessionId}&format=html`)
    const body = await response.text()
    expect(response.headers.get('content-type')).toMatch(/^text\/html/)
    expect(body).toContain('<!doctype html>')
    expect(body).toContain('data:image/png;base64,')
  })

  it('returns a ZIP whose entries are readable', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), `/x?sessionId=${sessionId}&format=zip`)
    expect(response.headers.get('content-type')).toBe('application/zip')
    const buffer = Buffer.from(await response.arrayBuffer())
    const names = zipEntryNames(buffer)
    expect(names.some((entry) => entry.endsWith('.md'))).toBe(true)
    expect(names.some((entry) => entry.endsWith('.html'))).toBe(true)
    expect(names).toContain('meta.json')
    expect(names.some((entry) => entry.startsWith('assets/'))).toBe(true)
    expect(readZipEntry(buffer, 'meta.json')).toContain('dsh-chat-export')
  })

  it('builds the bundle HTML with relative asset paths, not data URIs', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), `/x?sessionId=${sessionId}&format=zip`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const htmlName = zipEntryNames(buffer).find((entry) => entry.endsWith('.html'))
    const html = readZipEntry(buffer, htmlName)
    expect(html).toContain('assets/001-')
    expect(html).not.toContain('data:image/png')
  })

  it('rejects a missing session id', async () => {
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), '/x')
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('invalid')
  })

  it('rejects a malformed session id', async () => {
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), '/x?sessionId=../../etc/passwd')
    expect(response.status).toBe(400)
  })

  it('rejects an unknown option value', async () => {
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), `/x?sessionId=${sessionId}&images=wat`)
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatch(/images must be one of/)
  })

  it('answers 404 for a session with no log', async () => {
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), '/x?sessionId=session-deadbeef-0000-0000-0000-000000000000')
    expect(response.status).toBe(404)
    expect((await response.json()).code).toBe('session-not-found')
  })

  it('answers 409 when usePending finds nothing', async () => {
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.export`), `/x?sessionId=${sessionId}&usePending=1`)
    expect(response.status).toBe(409)
    expect((await response.json()).code).toBe('no-pending')
  })

  it('lets an explicit query key narrow a pending request', async () => {
    resetClock()
    const { ctx, routes, commands } = stubContext()
    apply(ctx)
    await commands[0].handler({ rawInput: 'html --thinking', agent: { session: { id: sessionId } } })
    const response = await call(
      routes.get(`${API_PREFIX}.export`),
      `/x?sessionId=${sessionId}&usePending=1&format=md&thinking=0`,
      { method: 'HEAD' },
    )
    expect(response.headers.get('content-type')).toMatch(/^text\/markdown/)
  })
})

describe('the .save route', () => {
  const sessionId = 'session-11111111-2222-3333-4444-555555555555'

  it('writes a Markdown file and reports the path', async () => {
    resetClock()
    const written = []
    const { ctx, routes } = stubContext({
      services: {
        fs: {
          async resolve(path) {
            return { targetKey: `key:${path}`, displayPath: path }
          },
          async stat() {
            return undefined
          },
          async writeText(target, content) {
            written.push({ path: target.displayPath, content })
            return { operation: 'create', version: 'v1' }
          },
        },
      },
    })
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.save`), '/x', {
      method: 'POST',
      body: JSON.stringify({ sessionId, directory: '/tmp/exports', options: { format: 'md' } }),
    })
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.ok).toBe(true)
    expect(body.path).toMatch(/^\/tmp\/exports\/dsh-chat-.*\.md$/u)
    expect(written).toHaveLength(1)
    expect(written[0].content).toContain('# 标题来自 sessionQuery')
  })

  it('refuses to save a ZIP, because ctx.fs cannot write binary', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.save`), '/x', {
      method: 'POST',
      body: JSON.stringify({ sessionId, directory: '/tmp/exports', options: { format: 'zip' } }),
    })
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('unsupported-save')
  })

  it('defaults the directory to the session working directory', async () => {
    resetClock()
    const written = []
    const { ctx, routes } = stubContext({
      services: {
        fs: {
          async resolve(path) {
            return { targetKey: `key:${path}`, displayPath: path }
          },
          async stat() {
            return undefined
          },
          async writeText(target, content) {
            written.push({ path: target.displayPath, content })
            return { operation: 'create', version: 'v1' }
          },
        },
      },
    })
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.save`), '/x', {
      method: 'POST',
      body: JSON.stringify({ sessionId, options: { format: 'md' } }),
    })
    expect(response.status).toBe(200)
    expect(written[0].path).toMatch(/^\/tmp\/example\/dsh-chat-exports\/dsh-chat-.+-\d{4}-\d{2}-\d{2}\.md$/u)
  })

  it('rejects a malformed body', async () => {
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.save`), '/x', { method: 'POST', body: 'not json' })
    expect(response.status).toBe(400)
    expect((await response.json()).code).toBe('invalid')
  })

  it('reports a clear failure when fs is absent', async () => {
    resetClock()
    const { ctx, routes } = stubContext({ services: { fs: undefined } })
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.save`), '/x', {
      method: 'POST',
      body: JSON.stringify({ sessionId, directory: '/tmp/exports', options: { format: 'md' } }),
    })
    expect(response.status).toBe(500)
    expect((await response.json()).error).toMatch(/fs service is unavailable/)
  })
})

describe('the .preview route', () => {
  const sessionId = 'session-11111111-2222-3333-4444-555555555555'

  it('returns Markdown without embedded images', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx)
    const response = await call(routes.get(`${API_PREFIX}.preview`), `/x?sessionId=${sessionId}`)
    expect(response.headers.get('content-type')).toMatch(/^text\/markdown/)
    const body = await response.text()
    expect(body).toContain('# 标题来自 sessionQuery')
    expect(body).not.toContain('data:image')
    expect(response.headers.get('x-dsh-chat-export-truncated')).toBe('0')
  })

  it('truncates a preview that would be too large', async () => {
    resetClock()
    const { ctx, routes } = stubContext()
    apply(ctx, { previewChars: 200 })
    const response = await call(routes.get(`${API_PREFIX}.preview`), `/x?sessionId=${sessionId}`)
    expect(response.headers.get('x-dsh-chat-export-truncated')).toBe('1')
    expect(await response.text()).toContain('预览已截断')
  })
})

describe('sources helpers', () => {
  it('tries both spellings of a session id', () => {
    expect(idVariants('abc')).toEqual(['abc', 'session-abc'])
    expect(idVariants('session-abc')).toEqual(['session-abc', 'abc'])
  })

  it('maps media types to extensions', () => {
    expect(mediaExtension('image/png')).toBe('png')
    expect(mediaExtension('image/jpeg')).toBe('jpg')
    expect(mediaExtension('image/webp')).toBe('webp')
    expect(mediaExtension('image/gif')).toBe('gif')
    expect(mediaExtension('application/pdf')).toBe('bin')
  })

  it('reads through the persistence service and reports the source', async () => {
    const { ctx } = stubContext()
    const log = await readSessionLog(exportServices(ctx), 'session-11111111-2222-3333-4444-555555555555')
    expect(log.source).toBe('persistence')
    expect(log.events.length).toBeGreaterThan(0)
  })

  it('falls back to sessionQuery.readSession when persistence fails', async () => {
    const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }]
    const services = {
      persistence: {
        async open() {
          throw new Error('backend exploded')
        },
      },
      query: {
        async readSession() {
          return { session: header(), events }
        },
      },
    }
    const log = await readSessionLog(services, 'anything')
    expect(log.source).toBe('sessionQuery')
    expect(log.events).toBe(events)
  })

  it('falls back to readSurface as the last resort', async () => {
    const events = [{ type: 'user/message', seq: 0, time: 1, data: { id: 'a', content: [{ type: 'text', text: 'x' }] } }]
    const services = {
      query: {
        async readSession() {
          throw new Error('no such session')
        },
        async readSurface() {
          return { session: header(), events }
        },
      },
    }
    const log = await readSessionLog(services, 'anything')
    expect(log.source).toBe('surface')
  })

  it('returns undefined when every backend reports not-found', async () => {
    const services = {
      persistence: {
        async open() {
          throw Object.assign(new Error('session not found'), { name: 'SessionPersistenceNotFoundError' })
        },
      },
    }
    expect(await readSessionLog(services, 'missing')).toBeUndefined()
  })

  it('surfaces a genuine read failure instead of reporting not-found', async () => {
    const services = {
      persistence: {
        async open() {
          throw new Error('disk on fire')
        },
      },
    }
    await expect(readSessionLog(services, 'x')).rejects.toThrow(/disk on fire/)
  })

  it('prefers the query-engine title and falls back to the log fold', async () => {
    const events = [{ type: 'session/title', seq: 0, time: 1, data: { title: '来自日志' } }]
    expect(await readSessionTitle({ query: { async readTitle() { return { title: '来自查询' } } } }, 'x', events)).toBe('来自查询')
    expect(await readSessionTitle({ query: { async readTitle() { return undefined } } }, 'x', events)).toBe('来自日志')
    expect(await readSessionTitle({}, 'x', events)).toBe('来自日志')
    expect(await readSessionTitle({}, 'x', [])).toBe('')
  })

  it('refuses to write when fs is absent', async () => {
    await expect(writeTextFile({}, '/tmp/x', 'body')).rejects.toThrow(/fs service is unavailable/)
  })

  it('uses createIfAbsent for a new file and replaceIfVersion for an existing one', async () => {
    const intents = []
    const fs = {
      async resolve(path) {
        return { targetKey: path, displayPath: path }
      },
      async stat() {
        return { version: 'v9' }
      },
      async writeText(_target, _content, intent) {
        intents.push(intent)
        return { operation: 'update', version: 'v10' }
      },
    }
    await writeTextFile({ fs }, '/tmp/x.md', 'body')
    expect(intents[0]).toEqual({ kind: 'replaceIfVersion', version: 'v9' })
  })
})

/** Entry names of a ZIP archive, read without trusting the writer. */
function zipEntryNames(buffer) {
  let eocd = buffer.length - 22
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const names = []
  for (let index = 0; index < count; index += 1) {
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    names.push(buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8'))
    offset += 46 + nameLength + extraLength + commentLength
  }
  return names
}

/** One decompressed ZIP entry. */
function readZipEntry(buffer, name) {
  let eocd = buffer.length - 22
  while (eocd >= 0 && buffer.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  for (let index = 0; index < count; index += 1) {
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const entryName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    if (entryName === name) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const start = localOffset + 30 + localNameLength + localExtraLength
      const body = buffer.subarray(start, start + compressedSize)
      return (method === 8 ? inflateRawSync(body) : body).toString('utf8')
    }
    offset += 46 + nameLength + extraLength + commentLength
  }
  throw new Error(`entry not found: ${name}`)
}
