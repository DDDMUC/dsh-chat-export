// dsh-chat-export - browser half.
//
// One entry point: a labelled capsule in the Session header that opens the
// export dialog. The `/export-md` command drives the same dialog, so a typed
// line and the button can never disagree about what will be produced.
//
// The plugin is a classic client bundle (the client-modules protocol): it
// registers a factory with `window.__ModuleLoader__` and returns `apply`.
// Everything it needs is required by name, which is what makes the browser half
// hot-swappable without a build step.
window.__ModuleLoader__.load({
  id: 'dsh-chat-export',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const jsxRuntime = require('react/jsx-runtime')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const clientStore = require('@deepseek-ai/dsh-client-store')
    const { jsx, jsxs, Fragment } = jsxRuntime

    const NS = 'dsh-chat-export'
    const API = '/api/dsh-chat-export'
    const HEADER_SLOT = 'conversation.session.header.utilities'

    // --- copy -----------------------------------------------------------------

    const zh = {
      'action.label': '导出文字稿',
      'action.title': '把当前会话导出成可读文字稿',
      'dialog.title': '导出会话文字稿',
      'dialog.description': '把当前会话导出成可读的 Markdown、HTML 或打包文件。导出只读会话日志，不修改任何内容。',
      'field.format': '格式',
      'format.md': 'Markdown',
      'format.html': 'HTML',
      'format.zip': 'ZIP 打包',
      'format.md.hint': '纯文本文字稿，适合归档与再编辑',
      'format.html.hint': '自包含单文件，可直接打印或另存为 PDF',
      'format.zip.hint': 'Markdown + HTML + 图片素材，全部装进一个压缩包',
      'field.scope': '范围',
      'scope.full': '完整日志',
      'scope.surface': '仅当前上下文',
      'scope.full.hint': '按发生顺序导出全部内容，包含后来被压缩或被删除的历史',
      'scope.surface.hint': '只导出模型当前还能看到的内容，压缩前的历史不含在内',
      'field.images': '图片',
      'images.auto': '自动',
      'images.embed': '内嵌',
      'images.none': '不导出',
      'images.auto.hint': '单文件内嵌，ZIP 里放 assets 目录',
      'field.content': '内容',
      'content.thinking': '思考块',
      'content.tools': '工具调用与结果',
      'content.system': '系统提示',
      'content.injected': '注入内容',
      'content.timestamps': '时间戳',
      'content.usage': '用量统计',
      'field.output': '输出',
      'output.download': '浏览器下载',
      'output.save': '保存到目录',
      'output.save.placeholder': '目录路径，留空则保存到会话工作目录下的 dsh-chat-exports/',
      'field.preview': '预览',
      'preview.show': '预览开头',
      'preview.hide': '收起预览',
      'preview.loading': '正在生成预览…',
      'preview.empty': '（会话为空，没有可预览的内容）',
      'action.cancel': '取消',
      'action.export': '导出',
      'action.exporting': '导出中…',
      'action.save': '保存',
      'action.saving': '保存中…',
      'notice.downloaded': '导出已开始下载：{name}',
      'notice.saved': '已保存到 {path}',
      'error.no-session': '无法确定当前会话。',
      'error.generic': '导出失败：{message}',
      'error.save-zip': '保存到目录只支持 Markdown / HTML / 纯文本；ZIP 请改用浏览器下载。',
    }

    const en = {
      'action.label': 'Export transcript',
      'action.title': 'Export this session as a readable transcript',
      'dialog.title': 'Export session transcript',
      'dialog.description': 'Export this session as a readable Markdown file, a self-contained HTML page, or a bundle. Export only reads the session log.',
      'field.format': 'Format',
      'format.md': 'Markdown',
      'format.html': 'HTML',
      'format.zip': 'ZIP bundle',
      'format.md.hint': 'Plain-text transcript, good for archiving and editing',
      'format.html.hint': 'One self-contained file, ready to print or save as PDF',
      'format.zip.hint': 'Markdown, HTML, and every image in one archive',
      'field.scope': 'Scope',
      'scope.full': 'Full log',
      'scope.surface': 'Current context',
      'scope.full.hint': 'Everything in the order it happened, including history that was later compacted or deleted',
      'scope.surface.hint': 'Only what the model can still see; pre-compaction history is excluded',
      'field.images': 'Images',
      'images.auto': 'Automatic',
      'images.embed': 'Embedded',
      'images.none': 'Skip',
      'images.auto.hint': 'Embedded in a single file, an assets folder inside a ZIP',
      'field.content': 'Content',
      'content.thinking': 'Reasoning',
      'content.tools': 'Tool calls and results',
      'content.system': 'System prompts',
      'content.injected': 'Injected context',
      'content.timestamps': 'Timestamps',
      'content.usage': 'Usage',
      'field.output': 'Output',
      'output.download': 'Download',
      'output.save': 'Save to a directory',
      'output.save.placeholder': 'Directory path; empty saves under the session working directory in dsh-chat-exports/',
      'field.preview': 'Preview',
      'preview.show': 'Preview the beginning',
      'preview.hide': 'Hide the preview',
      'preview.loading': 'Building the preview...',
      'preview.empty': '(This session has nothing to preview.)',
      'action.cancel': 'Cancel',
      'action.export': 'Export',
      'action.exporting': 'Exporting...',
      'action.save': 'Save',
      'action.saving': 'Saving...',
      'notice.downloaded': 'Download started: {name}',
      'notice.saved': 'Saved to {path}',
      'error.no-session': 'Could not determine the current session.',
      'error.generic': 'Export failed: {message}',
      'error.save-zip': 'Saving to a directory supports Markdown, HTML, and plain text; download the ZIP instead.',
    }

    // --- style ----------------------------------------------------------------

    const CSS = [
      '.dshce-button{display:inline-flex;align-items:center;gap:5px;height:32px;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));border-radius:18px;background:transparent;color:var(--dsw-alias-label-primary,inherit);font-family:var(--dsw-font-family,inherit);font-size:13px;font-weight:400;line-height:20px;cursor:pointer}',
      '.dshce-button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}',
      '.dshce-button:focus-visible{outline:2px solid var(--dsw-alias-button-primary-fill,#4d6bfe);outline-offset:2px}',
      '.dshce-button:disabled{color:var(--dsw-alias-label-dimmed,rgba(127,127,127,.6));cursor:progress}',
      '.dshce-button svg{flex:none}',
      '.dshce-button span{white-space:nowrap}',
      '.dshce-group{margin:0 0 18px}',
      '.dshce-group:last-child{margin-bottom:0}',
      '.dshce-group-title{margin:0 0 8px;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
      '.dshce-hint{margin:6px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshce-pills{display:flex;flex-wrap:wrap;gap:8px}',
      '.dshce-switches{display:grid;grid-template-columns:1fr 1fr;gap:8px 16px}',
      '.dshce-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:13px;color:var(--dsw-alias-label-secondary,#5c6068)}',
      '.dshce-input{display:block;width:100%;margin-top:8px;box-sizing:border-box}',
      '.dshce-preview{margin-top:10px;max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:8px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.06));padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--dsw-alias-label-secondary,#5c6068)}',
      '.dshce-error{margin:12px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary,#d54941)}',
      '.dshce-toast{position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:60;padding:8px 16px;border-radius:10px;background:var(--dsw-alias-bg-elevated,#222);color:var(--dsw-alias-label-primary,#fff);font-size:13px;box-shadow:0 6px 24px rgba(0,0,0,.24)}',
    ].join('')

    const TAG_ID = 'dsh-chat-export/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-chat-export'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- state ----------------------------------------------------------------

    /** Export options the dialog owns; the host applies the same defaults. */
    function defaultForm() {
      return {
        format: 'md',
        thinking: false,
        tools: true,
        system: false,
        injected: false,
        timestamps: true,
        usage: true,
        scope: 'full',
        images: 'auto',
        toolResultLimit: 4000,
      }
    }

    /** Per-session dialog state. */
    function defaultEntry() {
      return {
        open: false,
        busy: false,
        error: null,
        notice: null,
        form: defaultForm(),
        mode: 'download',
        directory: '',
        preview: null,
        previewLoading: false,
      }
    }

    /** Format one localized string with `{name}` parameters. */
    function format(template, params) {
      let out = String(template)
      for (const [key, value] of Object.entries(params ?? {})) out = out.split(`{${key}}`).join(String(value))
      return out
    }

    // --- controller -----------------------------------------------------------

    /** Owns the dialog state for every session and performs the export calls. */
    var ChatExportController = class {
      /**
       * @param fetcher - fetch implementation (injectable for tests).
       * @param save - browser save operation.
       */
      constructor(fetcher = (input, init) => fetch(input, init), save = downloadUrl) {
        this.fetcher = fetcher
        this.save = save
        this.store = clientStore.createSnapshotStore({ bySession: {} })
        this.disposed = false
      }

      /** The entry for one session, creating it on first use. */
      entryOf(sessionId) {
        const key = String(sessionId)
        const existing = this.store.getSnapshot().bySession[key]
        if (existing !== undefined) return existing
        const fresh = defaultEntry()
        this.store.update((state) => {
          state.bySession = { ...state.bySession, [key]: fresh }
        })
        return fresh
      }

      /** Patch one session's entry. */
      patch(sessionId, changes) {
        const key = String(sessionId)
        this.store.update((state) => {
          const current = state.bySession[key] ?? defaultEntry()
          state.bySession = { ...state.bySession, [key]: { ...current, ...changes } }
        })
      }

      /** Open the dialog. */
      open(sessionId) {
        this.patch(sessionId, { open: true, error: null })
      }

      /** Close the dialog without cancelling an in-flight request. */
      close(sessionId) {
        this.patch(sessionId, { open: false, error: null, preview: null })
      }

      /** Set one form field. */
      setField(sessionId, key, value) {
        const entry = this.entryOf(sessionId)
        this.patch(sessionId, { form: { ...entry.form, [key]: value }, error: null })
      }

      /**
       * Adopt the request a `/export-md` line parsed to.
       *
       * The host owns the grammar, so the dialog asks it what the line meant
       * instead of re-parsing it here; a line the host rejected never reaches
       * this point.
       */
      async adoptPending(sessionId) {
        try {
          const url = new URL(`${API}.pending`, window.location.origin)
          url.searchParams.set('sessionId', String(sessionId))
          const response = await this.fetcher(url, { method: 'GET' })
          if (!response.ok) return
          const body = await response.json()
          if (body.pending !== true) return
          this.patch(sessionId, {
            form: { ...defaultForm(), ...body.options },
            mode: body.save === null || body.save === undefined ? 'download' : 'save',
            directory: typeof body.save === 'string' ? body.save : '',
            open: true,
            error: null,
          })
        } catch {
          // A missing pending request just means the dialog opens with defaults.
        }
      }

      /** Query parameters for the current form. */
      paramsOf(entry) {
        const params = new URLSearchParams()
        params.set('format', entry.form.format)
        for (const key of ['thinking', 'tools', 'system', 'injected', 'timestamps', 'usage', 'scope', 'images', 'toolResultLimit']) {
          params.set(key, String(entry.form[key]))
        }
        return params
      }

      /** Build the export URL for one session. */
      urlOf(sessionId, entry) {
        const url = new URL(`${API}.export`, window.location.origin)
        url.searchParams.set('sessionId', String(sessionId))
        for (const [key, value] of this.paramsOf(entry)) url.searchParams.set(key, value)
        return url
      }

      /** Fetch the archive as a Blob so the browser save keeps the real filename. */
      async download(sessionId) {
        const entry = this.entryOf(sessionId)
        this.patch(sessionId, { busy: true, error: null })
        try {
          const response = await this.fetcher(this.urlOf(sessionId, entry), { method: 'GET' })
          if (!response.ok) throw new Error(await failureText(response))
          const blob = await response.blob()
          const name = filenameOf(response, entry.form.format)
          this.save(blob, name)
          this.patch(sessionId, { busy: false, open: false, notice: { kind: 'downloaded', name } })
        } catch (error) {
          this.patch(sessionId, { busy: false, error: messageOf(error) })
        }
      }

      /** Write the artifact into a directory through the host's filesystem. */
      async saveToDirectory(sessionId) {
        const entry = this.entryOf(sessionId)
        if (entry.form.format === 'zip') {
          this.patch(sessionId, { error: 'save-zip' })
          return
        }
        this.patch(sessionId, { busy: true, error: null })
        try {
          const response = await this.fetcher(`${API}.save`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId: String(sessionId), options: entry.form, directory: entry.directory }),
          })
          if (!response.ok) throw new Error(await failureText(response))
          const body = await response.json()
          this.patch(sessionId, { busy: false, open: false, notice: { kind: 'saved', path: body.path } })
        } catch (error) {
          this.patch(sessionId, { busy: false, error: messageOf(error) })
        }
      }

      /** Load the Markdown preview excerpt. */
      async loadPreview(sessionId) {
        const entry = this.entryOf(sessionId)
        if (entry.preview !== null) {
          this.patch(sessionId, { preview: null })
          return
        }
        this.patch(sessionId, { previewLoading: true, error: null })
        try {
          const url = new URL(`${API}.preview`, window.location.origin)
          url.searchParams.set('sessionId', String(sessionId))
          url.searchParams.set('thinking', entry.form.thinking ? '1' : '0')
          url.searchParams.set('tools', entry.form.tools ? '1' : '0')
          url.searchParams.set('scope', entry.form.scope)
          const response = await this.fetcher(url, { method: 'GET' })
          if (!response.ok) throw new Error(await failureText(response))
          this.patch(sessionId, { preview: await response.text(), previewLoading: false })
        } catch (error) {
          this.patch(sessionId, { previewLoading: false, error: messageOf(error) })
        }
      }

      /** Clear a transient notice. */
      clearNotice(sessionId) {
        this.patch(sessionId, { notice: null })
      }

      /** Mark the dialog closed and stop accepting new work. */
      dispose() {
        this.disposed = true
        this.store.set({ bySession: {} })
      }
    }

    /** Hand a Blob to the browser download manager. */
    function downloadUrl(blob, filename) {
      const href = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = filename
      anchor.rel = 'noopener'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      // Revoking immediately can cancel the download in some browsers; the
      // object is small enough that a delayed revoke costs nothing.
      setTimeout(() => URL.revokeObjectURL(href), 60_000)
    }

    /** The filename the server chose, falling back to a local guess. */
    function filenameOf(response, format) {
      const disposition = response.headers.get('content-disposition') ?? ''
      const extended = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)
      if (extended !== null) return decodeURIComponent(extended[1])
      const plain = /filename="([^"]+)"/iu.exec(disposition)
      if (plain !== null) return plain[1]
      const extension = format === 'md' ? 'md' : format === 'html' ? 'html' : 'zip'
      return `dsh-chat-export.${extension}`
    }

    /** The most useful message a failure response can carry. */
    async function failureText(response) {
      try {
        const body = await response.json()
        if (typeof body.error === 'string') return body.error
      } catch {
        // fall through to the status line
      }
      return `HTTP ${response.status}`
    }

    /** Message text of an unknown thrown value. */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    // --- react ----------------------------------------------------------------

    /** A small pill selector over a fixed set of choices. */
    function ChoiceRow({ value, choices, onChange, t }) {
      return jsx('div', {
        className: 'dshce-pills',
        role: 'radiogroup',
        children: choices.map((choice) =>
          jsx(
            primitives.Pill,
            {
              key: choice.value,
              active: value === choice.value,
              role: 'radio',
              'aria-checked': value === choice.value,
              title: choice.hint === undefined ? undefined : t(choice.hint),
              onClick: () => onChange(choice.value),
              children: t(choice.label),
            },
          ),
        ),
      })
    }

    /** A labelled switch in the two-column content grid. */
    function SwitchRow({ labelKey, checked, onChange, t }) {
      return jsx('div', {
        className: 'dshce-switch-row',
        children: [
          jsx('span', { key: 'label', children: t(labelKey) }),
          jsx(primitives.Switch, { key: 'switch', checked, onChange, label: t(labelKey) }),
        ],
      })
    }

    /** The export dialog for one session. */
    function ExportDialog({ sessionId, entry, controller, t }) {
      const form = entry.form
      const set = (key, value) => controller.setField(sessionId, key, value)
      if (!entry.open) return null
      return jsx(primitives.Modal, {
        open: true,
        title: t('dialog.title'),
        description: t('dialog.description'),
        closeLabel: t('action.cancel'),
        onClose: () => controller.close(sessionId),
        footer: jsxs(Fragment, {
          children: [
            jsx(primitives.Button, {
              variant: 'ghost',
              size: 'md',
              disabled: entry.busy,
              onClick: () => controller.loadPreview(sessionId),
              children: entry.preview === null ? t('preview.show') : t('preview.hide'),
            }),
            jsx(primitives.Button, {
              variant: 'ghost',
              size: 'md',
              disabled: entry.busy,
              onClick: () => controller.close(sessionId),
              children: t('action.cancel'),
            }),
            jsx(primitives.Button, {
              variant: 'primary',
              size: 'md',
              disabled: entry.busy || (entry.mode === 'save' && form.format === 'zip'),
              onClick: () => (entry.mode === 'save' ? controller.saveToDirectory(sessionId) : controller.download(sessionId)),
              children: entry.busy
                ? t(entry.mode === 'save' ? 'action.saving' : 'action.exporting')
                : t(entry.mode === 'save' ? 'action.save' : 'action.export'),
            }),
          ],
        }),
        children: jsxs(Fragment, {
          children: [
            jsxs('div', {
              className: 'dshce-group',
              children: [
                jsx('p', { className: 'dshce-group-title', children: t('field.format') }),
                jsx(ChoiceRow, {
                  t,
                  value: form.format,
                  onChange: (value) => set('format', value),
                  choices: [
                    { value: 'md', label: 'format.md', hint: 'format.md.hint' },
                    { value: 'html', label: 'format.html', hint: 'format.html.hint' },
                    { value: 'zip', label: 'format.zip', hint: 'format.zip.hint' },
                    { value: 'txt', label: 'format.txt', hint: 'format.txt.hint' },
                  ],
                }),
              ],
            }),
            jsxs('div', {
              className: 'dshce-group',
              children: [
                jsx('p', { className: 'dshce-group-title', children: t('field.scope') }),
                jsx(ChoiceRow, {
                  t,
                  value: form.scope,
                  onChange: (value) => set('scope', value),
                  choices: [
                    { value: 'full', label: 'scope.full', hint: 'scope.full.hint' },
                    { value: 'surface', label: 'scope.surface', hint: 'scope.surface.hint' },
                  ],
                }),
                jsxs('div', {
                  className: 'dshce-group',
                  style: { marginTop: '12px' },
                  children: [
                    jsx('p', { className: 'dshce-group-title', children: t('field.images') }),
                    jsx(ChoiceRow, {
                      t,
                      value: form.images,
                      onChange: (value) => set('images', value),
                      choices: [
                        { value: 'auto', label: 'images.auto', hint: 'images.auto.hint' },
                        { value: 'embed', label: 'images.embed' },
                        { value: 'none', label: 'images.none' },
                      ],
                    }),
                  ],
                }),
              ],
            }),
            jsxs('div', {
              className: 'dshce-group',
              children: [
                jsx('p', { className: 'dshce-group-title', children: t('field.content') }),
                jsxs('div', {
                  className: 'dshce-switches',
                  children: [
                    jsx(SwitchRow, { t, labelKey: 'content.thinking', checked: form.thinking, onChange: (v) => set('thinking', v) }),
                    jsx(SwitchRow, { t, labelKey: 'content.tools', checked: form.tools, onChange: (v) => set('tools', v) }),
                    jsx(SwitchRow, { t, labelKey: 'content.system', checked: form.system, onChange: (v) => set('system', v) }),
                    jsx(SwitchRow, { t, labelKey: 'content.injected', checked: form.injected, onChange: (v) => set('injected', v) }),
                    jsx(SwitchRow, { t, labelKey: 'content.timestamps', checked: form.timestamps, onChange: (v) => set('timestamps', v) }),
                    jsx(SwitchRow, { t, labelKey: 'content.usage', checked: form.usage, onChange: (v) => set('usage', v) }),
                  ],
                }),
              ],
            }),
            jsxs('div', {
              className: 'dshce-group',
              children: [
                jsx('p', { className: 'dshce-group-title', children: t('field.output') }),
                jsx(ChoiceRow, {
                  t,
                  value: entry.mode,
                  onChange: (value) => controller.patch(sessionId, { mode: value, error: null }),
                  choices: [
                    { value: 'download', label: 'output.download' },
                    { value: 'save', label: 'output.save' },
                  ],
                }),
                entry.mode === 'save'
                  ? jsx(primitives.Input, {
                      className: 'dshce-input',
                      value: entry.directory,
                      placeholder: t('output.save.placeholder'),
                      onChange: (event) => controller.patch(sessionId, { directory: event.target.value }),
                    })
                  : null,
              ],
            }),
            entry.previewLoading || entry.preview !== null
              ? jsx('div', {
                  className: 'dshce-group',
                  children: jsx('pre', {
                    className: 'dshce-preview',
                    children: entry.previewLoading ? t('preview.loading') : entry.preview || t('preview.empty'),
                  }),
                })
              : null,
            entry.error === null
              ? null
              : jsx('p', {
                  className: 'dshce-error',
                  role: 'status',
                  children: entry.error === 'save-zip' ? t('error.save-zip') : format(t('error.generic'), { message: entry.error }),
                }),
          ],
        }),
      })
    }

    /** The Session header entry point. */
    function HeaderAction(props) {
      const { sessionId, useChatExport, controller, t } = props
      const entry = useChatExport((state) => state.bySession[String(sessionId)]) ?? defaultEntry()
      const notice = entry.notice
      return jsxs(Fragment, {
        children: [
          jsxs('button', {
            type: 'button',
            className: 'dshce-button',
            disabled: entry.busy,
            'aria-busy': entry.busy === true,
            title: t('action.title'),
            onClick: () => controller.open(sessionId),
            children: [
              jsx(primitives.IconListPenOutline16, { key: 'icon', size: 13 }),
              jsx('span', { key: 'label', children: t('action.label') }),
            ],
          }),
          jsx(ExportDialog, { sessionId, entry, controller, t }),
          notice === null || notice === undefined
            ? null
            : jsx(primitives.Toast, {
                key: `${notice.kind}:${notice.name ?? notice.path ?? ''}`,
                text:
                  notice.kind === 'saved'
                    ? format(t('notice.saved'), { path: notice.path })
                    : format(t('notice.downloaded'), { name: notice.name }),
                onDone: () => controller.clearNotice(sessionId),
              }),
        ],
      })
    }

    // --- plugin ---------------------------------------------------------------

    function apply(ctx) {
      const controller = new ChatExportController()
      ctx.effect(() => () => controller.dispose(), 'dsh-chat-export: dialog lifecycle')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-chat-export: dictionaries')

      // `/export-md` runs on the host, which owns the argument grammar; the
      // browser half only asks what the line meant and opens the dialog on it.
      ctx.on('command/executed', (sessionId, commandName, result) => {
        if (commandName !== 'export-md') return
        if (result === null || result === undefined || result.kind !== 'success') return
        void controller.adoptPending(sessionId)
      })

      ctx.slots.inject(HEADER_SLOT, () =>
        ctx.slots.register(
          {
            name: HEADER_SLOT,
            id: 'chat-export',
            order: 10,
            locale: NS,
            inject: () => ({
              hooks: { chatExport: controller.store },
              controller,
            }),
          },
          HeaderAction,
        ),
      )
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    exports.ChatExportController = ChatExportController
    exports.defaultForm = defaultForm
    exports.filenameOf = filenameOf
    return module.exports
  },
})
