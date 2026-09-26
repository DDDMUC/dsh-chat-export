import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../src/client.js', import.meta.url)), 'utf8')

/**
 * The browser half is a plain client bundle: it registers a factory with
 * `window.__ModuleLoader__` and requires its dependencies by name. This harness
 * supplies those globals with the smallest fakes that keep the module honest -
 * notably a real (if tiny) snapshot store, so controller state behaves the way
 * the shipped `@deepseek-ai/dsh-client-store` behaves.
 */

/** A minimal `jsx`/`jsxs` that keeps props and children addressable. */
function h(type, props, ...rest) {
  const children = props === null || props === undefined ? rest : (props.children ?? rest)
  return { type, props: props ?? {}, children }
}

/** A minimal snapshot store with the same contract the real one exposes. */
function createSnapshotStore(init) {
  let state = init
  const listeners = new Set()
  return {
    getSnapshot: () => state,
    set(next) {
      state = next
      for (const listener of listeners) listener()
    },
    update(mutator) {
      const draft = structuredClone(state)
      mutator(draft)
      this.set(draft)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

/**
 * Evaluate `src/client.js` the way the browser does.
 *
 * The bundle is a classic script that self-registers with
 * `window.__ModuleLoader__` and pulls its dependencies through the loader's
 * `require`, so it is evaluated as source rather than imported: that keeps the
 * test on the real loading path instead of a bundler's approximation of it.
 *
 * @returns `{entry, exports, styles}` for the freshly evaluated bundle.
 */
async function loadClient() {
  const loaded = []
  const styles = []
  globalThis.window = {
    location: { origin: 'http://127.0.0.1:3080' },
    __ModuleLoader__: {
      load(entry) {
        loaded.push(entry)
      },
    },
  }
  globalThis.document = {
    querySelector: () => null,
    createElement: () => ({ dataset: {}, textContent: '' }),
    head: { appendChild: (node) => styles.push(node) },
    body: { appendChild: () => {}, removeChild: () => {} },
  }
  const modules = {
    react: {},
    'react/jsx-runtime': { jsx: h, jsxs: h, Fragment: 'Fragment' },
    '@deepseek-ai/dsh-client-ui-primitives': {
      Modal: 'Modal',
      Button: 'Button',
      Pill: 'Pill',
      Switch: 'Switch',
      Input: 'Input',
      Toast: 'Toast',
      IconShareOutlineRegular: 'IconShareOutlineRegular',
    },
    '@deepseek-ai/dsh-client-store': { createSnapshotStore },
  }
  // eslint-disable-next-line no-new-func
  new Function(CLIENT_SOURCE)()
  const entry = loaded[0]
  return { entry, exports: entry.factory((name) => modules[name]), styles }
}

/** A stub cordis browser context. */
function stubCtx() {
  const slots = []
  const events = []
  const effects = []
  const locales = []
  const registrations = []
  return {
    slots,
    events,
    locales,
    registrations,
    ctx: {
      effect(factory) {
        effects.push(factory())
        return () => {}
      },
      on(name, handler) {
        events.push({ name, handler })
        return () => {}
      },
      locale: {
        register(ns, dict) {
          locales.push({ ns, dict })
          return () => {}
        },
      },
      slots: {
        inject(name, factory) {
          slots.push({ name, registration: factory() })
          return () => {}
        },
        register(descriptor, component) {
          registrations.push({ ...descriptor, component })
          return () => {}
        },
      },
    },
  }
}

/** A fetch stub returning a canned response. */
function stubFetch(handler) {
  const calls = []
  const fetchImpl = async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString()
    calls.push({ url, init })
    return handler(url, init)
  }
  fetchImpl.calls = calls
  return fetchImpl
}

/** A response-like object good enough for the controller. */
function response(body, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    headers: { get: (name) => (options.headers ?? {})[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    blob: async () => ({ size: 1, type: 'text/plain' }),
  }
}

describe('client bundle shape', () => {
  it('registers itself under the plugin id', async () => {
    const { entry } = await loadClient()
    expect(entry.id).toBe('dsh-chat-export')
    expect(typeof entry.factory).toBe('function')
  })

  it('injects its stylesheet once, tagged for eviction on unload', async () => {
    const { styles } = await loadClient()
    expect(styles).toHaveLength(1)
    expect(styles[0].dataset.plugin).toBe('dsh-chat-export')
    expect(styles[0].dataset.pluginCss).toContain('dsh-chat-export')
    expect(styles[0].textContent).toContain('.dshce-header-action')
  })

  it('requires the client store, not the removed client-runtime shim', async () => {
    const { exports } = await loadClient()
    expect(exports.inject).toEqual(['slots', 'locale'])
    expect(typeof exports.ChatExportController).toBe('function')
  })
})

describe('apply', () => {
  it('registers the dictionaries, the command listener, and the header slot', async () => {
    const { exports } = await loadClient()
    const { ctx, slots, events, locales, registrations } = stubCtx()
    exports.apply(ctx)
    expect(locales).toHaveLength(1)
    expect(locales[0].ns).toBe('dsh-chat-export')
    expect(Object.keys(locales[0].dict)).toEqual(['zh', 'en'])
    expect(events.map((entry) => entry.name)).toEqual(['command/executed'])
    expect(slots).toHaveLength(1)
    expect(slots[0].name).toBe('conversation.session.header.utilities')
    const registration = registrations[0]
    expect(registration.name).toBe('conversation.session.header.utilities')
    expect(registration.id).toBe('chat-export')
    expect(registration.order).toBe(10)
    expect(registration.locale).toBe('dsh-chat-export')
    const injected = registration.inject()
    expect(typeof injected.controller.download).toBe('function')
    expect(injected.hooks.chatExport).toBeDefined()
  })

  it('asks the host about a pending request only for its own command', async () => {
    const { exports } = await loadClient()
    const { ctx, events, registrations } = stubCtx()
    exports.apply(ctx)
    const listener = events[0].handler

    // The same controller instance is handed to the slot and to the listener.
    const controller = registrations[0].inject().controller
    const adopt = vi.spyOn(controller, 'adoptPending').mockResolvedValue(undefined)

    listener('s1', 'export-md', { kind: 'success' })
    expect(adopt).toHaveBeenCalledWith('s1')

    adopt.mockClear()
    listener('s1', 'export', { kind: 'success' })
    listener('s1', 'export-md', { kind: 'error', text: 'bad arguments' })
    listener('s1', 'export-md', null)
    expect(adopt).not.toHaveBeenCalled()
  })
})

describe('ChatExportController', () => {
  let loaded
  beforeEach(async () => {
    loaded = await loadClient()
  })

  it('creates per-session state on first use', async () => {
    const controller = new loaded.exports.ChatExportController()
    const entry = controller.entryOf('s1')
    expect(entry.open).toBe(false)
    expect(entry.form.format).toBe('md')
    expect(controller.entryOf('s1')).toBe(controller.entryOf('s1'))
  })

  it('opens and closes per session without touching another session', async () => {
    const controller = new loaded.exports.ChatExportController()
    controller.open('s1')
    expect(controller.entryOf('s1').open).toBe(true)
    expect(controller.entryOf('s2').open).toBe(false)
    controller.close('s1')
    expect(controller.entryOf('s1').open).toBe(false)
  })

  it('builds a URL carrying every option', async () => {
    const controller = new loaded.exports.ChatExportController()
    controller.setField('s1', 'format', 'zip')
    controller.setField('s1', 'thinking', true)
    const url = controller.urlOf('s1', controller.entryOf('s1'))
    expect(url.pathname).toBe('/api/dsh-chat-export.export')
    expect(url.searchParams.get('sessionId')).toBe('s1')
    expect(url.searchParams.get('format')).toBe('zip')
    expect(url.searchParams.get('thinking')).toBe('true')
    expect(url.searchParams.get('scope')).toBe('full')
  })

  it('downloads a blob and reports the server filename', async () => {
    const fetchImpl = stubFetch(() =>
      response('data', {
        headers: { 'content-disposition': "attachment; filename=\"fallback.md\"; filename*=UTF-8''dsh-chat-%E4%BC%9A%E8%AF%9D-2026-01-02.md" },
      }),
    )
    const saved = []
    const controller = new loaded.exports.ChatExportController(fetchImpl, (blob, name) => saved.push({ blob, name }))
    await controller.download('s1')
    const entry = controller.entryOf('s1')
    expect(entry.busy).toBe(false)
    expect(entry.open).toBe(false)
    expect(saved).toHaveLength(1)
    expect(saved[0].name).toBe('dsh-chat-会话-2026-01-02.md')
    expect(entry.notice.kind).toBe('downloaded')
  })

  it('falls back to a filename when the header is absent', async () => {
    const fetchImpl = stubFetch(() => response('data'))
    const saved = []
    const controller = new loaded.exports.ChatExportController(fetchImpl, (blob, name) => saved.push(name))
    controller.setField('s1', 'format', 'html')
    await controller.download('s1')
    expect(saved[0]).toBe('dsh-chat-export.html')
  })

  it('surfaces the server error message on a failed download', async () => {
    const fetchImpl = stubFetch(() => response({ error: 'no stored log was found for this session' }, { ok: false, status: 404 }))
    const controller = new loaded.exports.ChatExportController(fetchImpl, () => {})
    await controller.download('s1')
    expect(controller.entryOf('s1').error).toContain('no stored log')
    expect(controller.entryOf('s1').busy).toBe(false)
  })

  it('refuses to save a ZIP before calling the host', async () => {
    const fetchImpl = stubFetch(() => response({ ok: true }))
    const controller = new loaded.exports.ChatExportController(fetchImpl, () => {})
    controller.setField('s1', 'format', 'zip')
    await controller.saveToDirectory('s1')
    expect(fetchImpl.calls).toHaveLength(0)
    expect(controller.entryOf('s1').error).toBe('save-zip')
  })

  it('posts the directory when saving', async () => {
    const fetchImpl = stubFetch(() => response({ ok: true, path: '/tmp/example/dsh-chat-exports/x.md' }))
    const controller = new loaded.exports.ChatExportController(fetchImpl, () => {})
    controller.patch('s1', { directory: '/tmp/example/out' })
    await controller.saveToDirectory('s1')
    expect(fetchImpl.calls[0].url).toBe('/api/dsh-chat-export.save')
    expect(JSON.parse(fetchImpl.calls[0].init.body).directory).toBe('/tmp/example/out')
    const entry = controller.entryOf('s1')
    expect(entry.notice).toEqual({ kind: 'saved', path: '/tmp/example/dsh-chat-exports/x.md' })
    expect(entry.open).toBe(false)
  })

  it('adopts a pending request from the host', async () => {
    const fetchImpl = stubFetch(() =>
      response({ ok: true, pending: true, options: { format: 'html', thinking: true }, save: '/tmp/out' }),
    )
    const controller = new loaded.exports.ChatExportController(fetchImpl, () => {})
    await controller.adoptPending('s1')
    const entry = controller.entryOf('s1')
    expect(entry.open).toBe(true)
    expect(entry.form.format).toBe('html')
    expect(entry.form.thinking).toBe(true)
    // Untouched keys keep their defaults rather than becoming undefined.
    expect(entry.form.tools).toBe(true)
    expect(entry.mode).toBe('save')
    expect(entry.directory).toBe('/tmp/out')
  })

  it('leaves the dialog alone when there is no pending request', async () => {
    const fetchImpl = stubFetch(() => response({ ok: true, pending: false }))
    const controller = new loaded.exports.ChatExportController(fetchImpl, () => {})
    await controller.adoptPending('s1')
    expect(controller.entryOf('s1').open).toBe(false)
  })

  it('swallows a pending lookup failure', async () => {
    const fetchImpl = stubFetch(() => {
      throw new Error('network down')
    })
    const controller = new loaded.exports.ChatExportController(fetchImpl, () => {})
    await expect(controller.adoptPending('s1')).resolves.toBeUndefined()
  })

  it('toggles and loads the preview', async () => {
    const fetchImpl = stubFetch(() => response('# 会话记录\n\n正文'))
    const controller = new loaded.exports.ChatExportController(fetchImpl, () => {})
    await controller.loadPreview('s1')
    expect(controller.entryOf('s1').preview).toContain('# 会话记录')
    await controller.loadPreview('s1')
    expect(controller.entryOf('s1').preview).toBeNull()
  })

  it('reports a preview failure', async () => {
    const fetchImpl = stubFetch(() => response({ error: 'boom' }, { ok: false, status: 500 }))
    const controller = new loaded.exports.ChatExportController(fetchImpl, () => {})
    await controller.loadPreview('s1')
    expect(controller.entryOf('s1').error).toContain('boom')
    expect(controller.entryOf('s1').previewLoading).toBe(false)
  })

  it('clears a notice and everything on dispose', async () => {
    const controller = new loaded.exports.ChatExportController(stubFetch(() => response('x')), () => {})
    controller.patch('s1', { notice: { kind: 'saved', path: '/tmp/x' } })
    controller.clearNotice('s1')
    expect(controller.entryOf('s1').notice).toBeNull()
    controller.dispose()
    expect(controller.store.getSnapshot().bySession).toEqual({})
  })
})

describe('the Session-header entry point', () => {
  /** Render the registered HeaderAction with plain fakes (no React needed). */
  async function renderHeaderAction() {
    const { exports } = await loadClient()
    const { ctx, registrations } = stubCtx()
    exports.apply(ctx)
    const { component } = registrations[0]
    expect(typeof component).toBe('function')
    const tree = component({
      sessionId: 'session-1',
      useChatExport: (select) => select({ bySession: {} }),
      controller: { open: () => {}, clearNotice: () => {} },
      t: (key) => key,
    })
    return tree.children[0]
  }

  it('renders as the harness Button primitive, not a raw button', async () => {
    const button = await renderHeaderAction()
    // Using the primitive is what keeps this visually identical to the
    // harness's own header icon button next to it.
    expect(button.type).toBe('Button')
  })

  it('carries the share icon and no visible text label', async () => {
    const button = await renderHeaderAction()
    expect(button.children.type).toBe('IconShareOutlineRegular')
    // The label survives only as the accessible name and the tooltip; a text
    // child here would turn the square icon button back into a labelled pill.
    expect(button.props['aria-label']).toBe('action.label')
    expect(button.props.title).toBe('action.title')
    const textChildren = [button.children].flat().filter((child) => typeof child === 'string')
    expect(textChildren).toEqual([])
  })

  it('sizes itself like the harness icon button', async () => {
    const button = await renderHeaderAction()
    expect(button.props.size).toBe('sm')
    expect(button.props.className).toBe('dshce-header-action')
  })
})

describe('locale completeness', () => {
  /**
   * Keys the dialog can ask for: `label`/`hint`/`labelKey` in a choice or row
   * definition, plus every direct `t('...')` call.
   */
  function referencedKeys(source) {
    const keys = new Set()
    for (const match of source.matchAll(/(?:label|hint|labelKey):\s*'([a-z][A-Za-z0-9.]*)'/gu)) keys.add(match[1])
    for (const match of source.matchAll(/\bt\('([a-z][A-Za-z0-9.]*)'/gu)) keys.add(match[1])
    return [...keys].sort()
  }

  /** The `zh` / `en` dictionaries as written in the bundle source. */
  function dictionaries(source) {
    const out = {}
    for (const locale of ['zh', 'en']) {
      const start = source.indexOf(`const ${locale} = {`)
      expect(start, `${locale} dictionary`).toBeGreaterThan(-1)
      const end = source.indexOf('\n    }', start)
      const body = source.slice(start, end)
      out[locale] = new Set([...body.matchAll(/'([^']+)':/gu)].map((match) => match[1]))
    }
    return out
  }

  it('defines every key the dialog asks for, in both languages', () => {
    const dicts = dictionaries(CLIENT_SOURCE)
    const missing = []
    for (const key of referencedKeys(CLIENT_SOURCE)) {
      for (const locale of ['zh', 'en']) {
        if (!dicts[locale].has(key)) missing.push(`${locale}: ${key}`)
      }
    }
    // A key that resolves to itself renders as the raw dotted string in the UI,
    // which is how 'format.txt' shipped as a visible label once.
    expect(missing).toEqual([])
  })

  it('carries a plain-text entry in both languages', () => {
    const dicts = dictionaries(CLIENT_SOURCE)
    expect(dicts.zh.has('format.txt')).toBe(true)
    expect(dicts.en.has('format.txt')).toBe(true)
  })

  it('gives every format pill its own label and hint', () => {
    const referenced = referencedKeys(CLIENT_SOURCE)
    for (const format of ['md', 'html', 'zip', 'txt']) {
      expect(referenced, `format.${format}`).toContain(`format.${format}`)
    }
  })
})
