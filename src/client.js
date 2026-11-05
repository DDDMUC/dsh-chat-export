// dsh-chat-export - browser half.
//
// One entry point: a share icon in the Session header that opens a dialog with
// two tabs — export (the default) and import. The `/export-md` command drives
// the export tab, so a typed line and the button can never disagree about what
// will be produced.
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
      'action.label': '导出或导入会话',
      'action.title': '导出文字稿，或导入一个会话',
      'dialog.title': '导出会话文字稿',
      'dialog.description': '把当前会话导出成可读的 Markdown、HTML、纯文本或打包文件。导出只读会话日志，不修改任何内容。',
      'field.format': '格式',
      'format.md': 'Markdown',
      'format.html': 'HTML',
      'format.zip': 'ZIP 打包',
      'format.txt': '纯文本',
      'format.log': '会话日志',
      'format.md.hint': '带标记的文字稿，标题与折叠都交给阅读器渲染',
      'format.html.hint': '自包含单文件，可直接打印或另存为 PDF',
      'format.zip.hint': 'Markdown + HTML + 纯文本 + 图片素材，全部装进一个压缩包',
      'format.txt.hint': '不带任何标记，结构与层级全靠分隔线和缩进',
      'format.log.hint': '原始事件流（JSONL），能再用 /import-session 导回一个会话',
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
      'content.userInput': '用户输入',
      'content.modelOutput': '模型输出',
      'content.thinking': '思维链',
      'content.tools': '工具调用与结果',
      'content.system': '系统提示词',
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
      'error.save-zip': '保存到目录只支持 Markdown / HTML / 纯文本 / 会话日志；ZIP 请改用浏览器下载。',
      'tab.export': '导出',
      'tab.import': '导入',
      'import.dialog.title': '导入会话',
      'import.dialog.description': '把导出的会话日志（JSONL）、ZIP 包或文字稿（Markdown）变回一个能继续聊的真实会话。ZIP 会顺带把图片写回附件库。导入只新建会话，不改动原文件。',
      'import.field.source': '来源',
      'import.chooseFile': '选择文件',
      'import.noFile': '尚未选择文件',
      'import.source.hint': 'JSONL 日志可无损导入；ZIP 包还能把图片一起写回；Markdown 只保留文字。',
      'import.field.options': '选项',
      'import.title.label': '标题',
      'import.title.placeholder': '留空则用文件里的标题',
      'import.cwd.label': '工作目录',
      'import.cwd.placeholder': '绝对路径，留空则用原会话记录的目录',
      'import.preview.show': '预览（只看不写）',
      'import.preview.title': '将导入：{kind} · {title} · {count} 条事件',
      'import.kind.log': '会话日志',
      'import.kind.markdown': '文字稿',
      'import.preview.untitled': '（无标题）',
      'action.import': '导入',
      'action.importing': '导入中…',
      'notice.imported': '已导入会话：{title}（{count} 条事件）',
      'error.import': '导入失败：{message}',
      'import.error.noFile': '请先选择一个文件。',
      'import.dropzone': '拖拽文件到这里，或点击选择',
      'import.dropzone.hint': '支持 .zip（含图片写回）/ .jsonl / .md',
      'import.dropzone.replace': '点击或拖拽可替换',
      'import.dropzone.active': '松开即可导入',
      'import.dropzone.active.hint': '文件只在本地读取，不会上传',
    }

    const en = {
      'action.label': 'Export or import a session',
      'action.title': 'Export a transcript, or import a session',
      'dialog.title': 'Export session transcript',
      'dialog.description': 'Export this session as a readable Markdown file, a self-contained HTML page, plain text, or a bundle. Export only reads the session log.',
      'field.format': 'Format',
      'format.md': 'Markdown',
      'format.html': 'HTML',
      'format.zip': 'ZIP bundle',
      'format.txt': 'Plain text',
      'format.log': 'Session log',
      'format.md.hint': 'A marked-up transcript; headings and folds are left to your reader',
      'format.html.hint': 'One self-contained file, ready to print or save as PDF',
      'format.zip.hint': 'Markdown, HTML, plain text, and every image in one archive',
      'format.txt.hint': 'No markers at all; structure comes from rules and indentation',
      'format.log.hint': 'The raw event stream (JSONL), replayable with /import-session',
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
      'content.userInput': 'User input',
      'content.modelOutput': 'Model output',
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
      'error.save-zip': 'Saving to a directory supports Markdown, HTML, plain text, and the session log; download the ZIP instead.',
      'tab.export': 'Export',
      'tab.import': 'Import',
      'import.dialog.title': 'Import a session',
      'import.dialog.description': 'Turn an exported session log (JSONL), a ZIP bundle, or a transcript (Markdown) back into a real, continuable session. A ZIP also writes its images back into the attachment store. Import only creates a new session; it never modifies the file.',
      'import.field.source': 'Source',
      'import.chooseFile': 'Choose file',
      'import.noFile': 'No file chosen',
      'import.source.hint': 'A JSONL log imports losslessly; a ZIP bundle also restores its images; Markdown keeps text only.',
      'import.field.options': 'Options',
      'import.title.label': 'Title',
      'import.title.placeholder': 'Empty uses the title from the file',
      'import.cwd.label': 'Working directory',
      'import.cwd.placeholder': 'Absolute path; empty uses the directory the session recorded',
      'import.preview.show': 'Preview (writes nothing)',
      'import.preview.title': 'Will import: {kind} · {title} · {count} events',
      'import.kind.log': 'session log',
      'import.kind.markdown': 'transcript',
      'import.preview.untitled': '(untitled)',
      'action.import': 'Import',
      'action.importing': 'Importing...',
      'notice.imported': 'Imported session: {title} ({count} events)',
      'error.import': 'Import failed: {message}',
      'import.error.noFile': 'Choose a file first.',
      'import.dropzone': 'Drop a file here, or click to choose',
      'import.dropzone.hint': 'Supports .zip (restores images) / .jsonl / .md',
      'import.dropzone.replace': 'click or drop to replace',
      'import.dropzone.active': 'Release to import',
      'import.dropzone.active.hint': 'The file is read locally; nothing is uploaded',
    }

    // --- style ----------------------------------------------------------------

    const CSS = [
      // Square icon button, sized exactly like the harness's own Session-header
      // icon button so the two sit in one row without looking mismatched.
      '.dshce-header-action{width:28px;flex:none;padding:0;color:var(--dsw-alias-label-secondary,inherit)}',
      '.dshce-header-action svg{width:15px;height:15px}',
      // The header glyph is two halves of the same share icon: the top one as-is
      // (export), the bottom one rotated 180° (import). 7 + 1 + 7 = the 15px box
      // the single icon used, so the button keeps the same optical size.
      '.dshce-header-action .dshce-header-icon{display:inline-flex;flex-direction:column;align-items:center;justify-content:center;gap:0.5px;width:8.8px;height:16.1px;line-height:0}',
      '.dshce-header-action .dshce-header-icon-half{display:flex;align-items:center;justify-content:center;width:8.8px;height:7.8px;line-height:0}',
      // The glyph is square, so a plain 8.8x7.8 box would letterbox it back to
      // 7.8 wide. Stretch it 8.8/7.8 so the requested width is real.
      '.dshce-header-action .dshce-header-icon-half svg{width:7.8px;height:7.8px;display:block;transform:scaleX(1.1282)}',
      '.dshce-header-action .dshce-header-icon-flip{transform:rotate(180deg)}',
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
      '.dshce-tabs{display:flex;gap:8px;margin:0 0 18px;padding-bottom:12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2))}',
      '.dshce-dropzone{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;box-sizing:border-box;padding:18px 16px;border:1px dashed var(--dsw-alias-border-l1,rgba(127,127,127,.35));border-radius:10px;background:var(--dsw-alias-bg-secondary,rgba(127,127,127,.04));cursor:pointer;text-align:center;transition:border-color .15s ease,background .15s ease}',
      '.dshce-dropzone:hover{border-color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshce-dropzone-active,.dshce-dropzone-active:hover{border-color:var(--dsw-alias-label-primary,currentColor);background:var(--dsw-alias-bg-elevated,rgba(127,127,127,.10))}',
      '.dshce-dropzone-icon{width:22px;height:22px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshce-dropzone-title{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,inherit);word-break:break-all}',
      '.dshce-dropzone-hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      '.dshce-file-input{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '.dshce-field-label{display:block;margin:14px 0 0;font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary,inherit)}',
      '.dshce-warnings{margin:8px 0 0;padding-left:18px;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8a8f98)}',
      // The dialog is a dense form (two-column switches plus a preview), and the
      // primitive's default box is narrow. `Modal` forwards `className` to the
      // dialog element, so this is ours to size. Eight handles make it behave
      // like a window instead of a fixed sheet.
      '.dshce-modal{position:relative;width:min(760px,94vw);max-width:94vw;max-height:88vh}',
      '.dshce-rz-layer{display:contents}',
      // Handles sit just inside the edge: the dialog clips its own overflow, so
      // anything positioned outside the box would be cut off.
      '.dshce-rz{position:absolute;z-index:5;touch-action:none}',
      '.dshce-rz-n{top:0;left:18px;right:18px;height:7px;cursor:ns-resize}',
      '.dshce-rz-s{bottom:0;left:18px;right:18px;height:7px;cursor:ns-resize}',
      '.dshce-rz-e{right:0;top:18px;bottom:18px;width:7px;cursor:ew-resize}',
      '.dshce-rz-w{left:0;top:18px;bottom:18px;width:7px;cursor:ew-resize}',
      '.dshce-rz-ne{top:0;right:0;width:14px;height:14px;cursor:nesw-resize}',
      '.dshce-rz-nw{top:0;left:0;width:14px;height:14px;cursor:nwse-resize}',
      '.dshce-rz-se{bottom:0;right:0;width:14px;height:14px;cursor:nwse-resize}',
      '.dshce-rz-sw{bottom:0;left:0;width:14px;height:14px;cursor:nwse-resize}',
      // One visible grip so the dialog does not look inert; the rest are hit areas.
      '.dshce-rz-se::after{content:"";position:absolute;right:2px;bottom:2px;width:6px;height:6px;border-right:2px solid var(--dsw-alias-label-tertiary,#b9bcc2);border-bottom:2px solid var(--dsw-alias-label-tertiary,#b9bcc2);border-radius:1px;opacity:.6;pointer-events:none}',
      '.dshce-rz-se:hover::after{opacity:1}',
    ].join('')

    const TAG_ID = 'dsh-chat-export/client.css'
    if (typeof document !== 'undefined') {
      // Replace any tag a previous (hot-reloaded) instance left behind: keeping
      // it would make a "only if absent" guard skip the append and silently
      // drop the rules added since the last load.
      const stale = document.querySelector('style[data-plugin-css=' + JSON.stringify(TAG_ID) + ']')
      if (stale !== null && stale !== undefined) stale.remove?.()
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-chat-export'
      tag.dataset.pluginCss = TAG_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    // --- state ----------------------------------------------------------------

    /**
     * Export options the dialog owns.
     *
     * These MUST match `defaultOptions()` in src/options.js: the dialog renders
     * them as the initial switch positions, and the host fills in anything the
     * request leaves out, so a disagreement shows the user one thing and exports
     * another. The two bundles cannot import each other, so a test compares them
     * instead of trusting the comment.
     */
    function defaultForm() {
      return {
        format: 'md',
        userInput: true,
        modelOutput: true,
        thinking: true,
        tools: false,
        system: true,
        injected: false,
        timestamps: false,
        usage: false,
        scope: 'full',
        images: 'auto',
        toolResultLimit: 4000,
        // Mirrors the host default so the two halves cannot drift. The dialog
        // itself does not offer the sidecar; `/export-md zip --with-log` does.
        withLog: false,
      }
    }

    /**
     * Where the dialog remembers the options the user last exported with.
     *
     * The dialog is opened for one session at a time, but the choices (format,
     * scope, which parts to include) are a habit, not a per-session decision:
     * resetting them on every open means re-clicking the same five controls.
     */
    const FORM_KEY = 'dsh-chat-export.form.v1'

    /** The remembered payload, or null when there is none. */
    function loadSaved() {
      if (typeof window === 'undefined' || window.localStorage === undefined) return null
      try {
        const raw = window.localStorage.getItem(FORM_KEY)
        if (raw === null) return null
        const saved = JSON.parse(raw)
        return saved !== null && typeof saved === 'object' ? saved : null
      } catch {
        // Private mode, a corrupt value, or storage disabled: use the defaults.
        return null
      }
    }

    /**
     * The form to open the dialog with.
     *
     * Values are copied onto a fresh default one key at a time, so a form saved
     * by an older version cannot reintroduce a field that no longer exists, and
     * a type that changed shape is ignored rather than trusted.
     */
    function loadSavedForm() {
      const base = defaultForm()
      const saved = loadSaved()
      if (saved === null || saved.form === null || typeof saved.form !== 'object') return base
      for (const key of Object.keys(base)) {
        const value = saved.form[key]
        if (value === undefined || typeof value !== typeof base[key]) continue
        base[key] = value
      }
      return base
    }

    /** The remembered output mode. */
    function loadSavedMode() {
      const saved = loadSaved()
      return saved !== null && saved.mode === 'save' ? 'save' : 'download'
    }

    /** Persist the form and mode for the next open. */
    function saveForm(form, mode) {
      if (typeof window === 'undefined' || window.localStorage === undefined) return
      try {
        window.localStorage.setItem(FORM_KEY, JSON.stringify({ form, mode }))
      } catch {
        // Storage is a convenience here, never a requirement.
      }
    }

    /** Per-session dialog state. */
    function defaultEntry() {
      return {
        open: false,
        busy: false,
        error: null,
        notice: null,
        form: loadSavedForm(),
        mode: loadSavedMode(),
        directory: '',
        preview: null,
        previewLoading: false,
        // Import tab state. Kept beside the export state so one dialog can
        // switch between the two without losing what the other tab held.
        tab: 'export',
        impName: '',
        impText: '',
        impZip: '',
        impKind: '',
        impTitle: '',
        impCwd: '',
        impPreview: null,
        impBusy: false,
        impError: null,
        impDragging: false,
        impSize: 0,
      }
    }

    /** Format one localized string with `{name}` parameters. */
    function format(template, params) {
      let out = String(template)
      for (const [key, value] of Object.entries(params ?? {})) out = out.split(`{${key}}`).join(String(value))
      return out
    }

    /** Human-readable byte size for the chosen file. */
    function formatBytes(bytes) {
      const n = Number(bytes) || 0
      if (n < 1024) return `${n} B`
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
      return `${(n / 1024 / 1024).toFixed(1)} MB`
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
          // Merge over a fresh default so an entry created before a field was
          // added still gets every key the components read.
          const current = { ...defaultEntry(), ...(state.bySession[key] ?? {}) }
          state.bySession = { ...state.bySession, [key]: { ...current, ...changes } }
        })
        // Remember the choices, so the next dialog opens the way this one was
        // left. Only the export options are habits; the directory, the file
        // and the preview belong to the session that produced them.
        if (changes.form !== undefined || changes.mode !== undefined) {
          const next = this.entryOf(sessionId)
          saveForm(next.form, next.mode)
        }
      }

      /** Open the dialog on the export tab. */
      open(sessionId) {
        this.patch(sessionId, { open: true, error: null, tab: 'export', impPreview: null, impError: null })
      }

      /** Close the dialog without cancelling an in-flight request. */
      close(sessionId) {
        this.patch(sessionId, { open: false, error: null, preview: null, impPreview: null, impError: null })
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
        // A ZIP that cannot be re-imported is a trap: always carry the sidecar
        // log when the chosen format is the bundle.
        params.set('withLog', String(entry.form.format === 'zip' ? true : entry.form.withLog))
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

      /** Switch the dialog between the export and import tabs. */
      setTab(sessionId, tab) {
        this.patch(sessionId, { tab, error: null, impError: null })
      }

      /** Read a chosen file into memory; nothing is sent until import runs. */
      async chooseImportFile(sessionId, file) {
        if (file === null || file === undefined) return
        try {
          const name = typeof file.name === 'string' ? file.name : ''
          const lower = name.toLowerCase()
          if (lower.endsWith('.zip')) {
            // A ZIP is binary: base64 it in chunks so a multi-megabyte bundle
            // does not blow the argument limit of String.fromCharCode.
            const bytes = new Uint8Array(await file.arrayBuffer())
            let binary = ''
            const chunk = 0x8000
            for (let index = 0; index < bytes.length; index += chunk) {
              binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk))
            }
            this.patch(sessionId, { impName: name, impText: '', impZip: btoa(binary), impKind: 'zip', impSize: typeof file.size === 'number' ? file.size : 0, impDragging: false, impPreview: null, impError: null })
            return
          }
          const text = await file.text()
          const kind = lower.endsWith('.jsonl') || lower.endsWith('.json')
            ? 'log'
            : lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')
              ? 'markdown'
              : ''
          this.patch(sessionId, { impName: name, impText: text, impZip: '', impKind: kind, impSize: typeof file.size === 'number' ? file.size : 0, impDragging: false, impPreview: null, impError: null })
        } catch (error) {
          this.patch(sessionId, { impError: messageOf(error) })
        }
      }

      /** Highlight (or clear) the drop target while a file is dragged over it. */
      setDragging(sessionId, value) {
        this.patch(sessionId, { impDragging: value === true })
      }

      /** Set one import option (title or working directory). */
      setImportField(sessionId, key, value) {
        this.patch(sessionId, { [key]: value, impPreview: null, impError: null })
      }

      /** Dry-run or perform the import through the host route. */
      async runImport(sessionId, dryRun) {
        const entry = this.entryOf(sessionId)
        const isZip = entry.impKind === 'zip'
        const hasContent = isZip ? (entry.impZip ?? '') !== '' : (entry.impText ?? '').trim() !== ''
        if (!hasContent) {
          this.patch(sessionId, { impError: 'no-file' })
          return
        }
        this.patch(sessionId, { impBusy: true, impError: null })
        try {
          const payload = isZip
            ? {
                zip: entry.impZip,
                cwd: entry.impCwd === '' ? undefined : entry.impCwd,
                title: entry.impTitle === '' ? undefined : entry.impTitle,
                dryRun: dryRun === true,
              }
            : {
                text: entry.impText,
                kind: entry.impKind === '' ? undefined : entry.impKind,
                cwd: entry.impCwd === '' ? undefined : entry.impCwd,
                title: entry.impTitle === '' ? undefined : entry.impTitle,
                dryRun: dryRun === true,
              }
          const response = await this.fetcher(isZip ? `${API}.import-zip` : `${API}.import`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          })
          if (!response.ok) throw new Error(await failureText(response))
          const result = await response.json()
          if (dryRun === true) {
            this.patch(sessionId, { impBusy: false, impPreview: result })
          } else {
            this.patch(sessionId, {
              impBusy: false,
              open: false,
              tab: 'export',
              impPreview: null,
              notice: { kind: 'imported', title: result.title, count: result.eventCount },
            })
          }
        } catch (error) {
          this.patch(sessionId, { impBusy: false, impError: messageOf(error) })
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
      const extension = format === 'md' ? 'md' : format === 'html' ? 'html' : format === 'txt' ? 'txt' : format === 'log' ? 'jsonl' : 'zip'
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

    /** The two-tab switch at the top of the dialog. */
    function TabRow({ tab, onChange, t }) {
      return jsx('div', {
        className: 'dshce-tabs',
        role: 'tablist',
        children: [
          { value: 'export', label: 'tab.export' },
          { value: 'import', label: 'tab.import' },
        ].map((choice) =>
          jsx(primitives.Pill, {
            key: choice.value,
            active: tab === choice.value,
            role: 'tab',
            'aria-selected': tab === choice.value,
            onClick: () => onChange(choice.value),
            children: t(choice.label),
          }),
        ),
      })
    }

    /** The export tab's form. */
    function ExportBody({ sessionId, entry, controller, t }) {
      const form = entry.form
      const set = (key, value) => controller.setField(sessionId, key, value)
      return jsxs(Fragment, {
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
                  { value: 'log', label: 'format.log', hint: 'format.log.hint' },
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
                  // The four that are the conversation, in reading order.
                  jsx(SwitchRow, { t, labelKey: 'content.userInput', checked: form.userInput, onChange: (v) => set('userInput', v) }),
                  jsx(SwitchRow, { t, labelKey: 'content.modelOutput', checked: form.modelOutput, onChange: (v) => set('modelOutput', v) }),
                  jsx(SwitchRow, { t, labelKey: 'content.thinking', checked: form.thinking, onChange: (v) => set('thinking', v) }),
                  jsx(SwitchRow, { t, labelKey: 'content.system', checked: form.system, onChange: (v) => set('system', v) }),
                  jsx(SwitchRow, { t, labelKey: 'content.tools', checked: form.tools, onChange: (v) => set('tools', v) }),
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
      })
    }

    /** The export tab's footer buttons. */
    function ExportFooter({ sessionId, entry, controller, t }) {
      const form = entry.form
      return jsxs(Fragment, {
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
      })
    }

    /** The import tab's form. */
    function ImportBody({ sessionId, entry, controller, t }) {
      const preview = entry.impPreview ?? null
      const name = entry.impName ?? ''
      const hasFile = name !== ''
      const dragging = entry.impDragging === true
      const onDragOver = (event) => {
        event.preventDefault()
        if (event.dataTransfer !== null && event.dataTransfer !== undefined) event.dataTransfer.dropEffect = 'copy'
        if (!dragging) controller.setDragging(sessionId, true)
      }
      const onDragLeave = (event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) controller.setDragging(sessionId, false)
      }
      const onDrop = (event) => {
        event.preventDefault()
        controller.setDragging(sessionId, false)
        const file = event.dataTransfer?.files?.[0]
        if (file !== null && file !== undefined) controller.chooseImportFile(sessionId, file)
      }
      return jsx('div', {
        className: 'dshce-import-body',
        onDragOver,
        onDragLeave,
        onDrop,
        children: jsxs(Fragment, {
          children: [
            jsxs('div', {
              className: 'dshce-group',
              children: [
                jsx('p', { className: 'dshce-group-title', children: t('import.field.source') }),
                // The whole tab is a drop target; this label is the click target
                // and the visual affordance. The input is clipped, not hidden,
                // so a click anywhere on the label still opens the picker.
                jsxs('label', {
                  className: 'dshce-dropzone' + (dragging ? ' dshce-dropzone-active' : ''),
                  children: [
                    jsx('input', {
                      type: 'file',
                      className: 'dshce-file-input',
                      accept: '.jsonl,.json,.md,.markdown,.txt,.zip,text/plain,application/json,application/zip',
                      onChange: (event) => {
                        controller.chooseImportFile(sessionId, event.target.files?.[0])
                        // Reset so choosing the same file again still fires.
                        event.target.value = ''
                      },
                    }),
                    jsx('svg', {
                      className: 'dshce-dropzone-icon',
                      viewBox: '0 0 24 24',
                      fill: 'none',
                      stroke: 'currentColor',
                      strokeWidth: 1.6,
                      strokeLinecap: 'round',
                      strokeLinejoin: 'round',
                      'aria-hidden': 'true',
                      children: [
                        jsx('path', { d: 'M12 3v10' }),
                        jsx('path', { d: 'm7 9 5 5 5-5' }),
                        jsx('path', { d: 'M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2' }),
                      ],
                    }),
                    jsx('span', {
                      className: 'dshce-dropzone-title',
                      children: dragging ? t('import.dropzone.active') : hasFile ? name : t('import.dropzone'),
                    }),
                    jsx('span', {
                      className: 'dshce-dropzone-hint',
                      children: dragging
                        ? t('import.dropzone.active.hint')
                        : hasFile
                          ? `${formatBytes(entry.impSize ?? 0)} · ${t('import.dropzone.replace')}`
                          : t('import.dropzone.hint'),
                    }),
                  ],
                }),
              ],
            }),
            jsxs('div', {
              className: 'dshce-group',
              children: [
                jsx('p', { className: 'dshce-group-title', children: t('import.field.options') }),
                jsx('span', { className: 'dshce-field-label', children: t('import.title.label') }),
                jsx(primitives.Input, {
                  className: 'dshce-input',
                  value: entry.impTitle ?? '',
                  placeholder: t('import.title.placeholder'),
                  onChange: (event) => controller.setImportField(sessionId, 'impTitle', event.target.value),
                }),
                jsx('span', { className: 'dshce-field-label', children: t('import.cwd.label') }),
                jsx(primitives.Input, {
                  className: 'dshce-input',
                  value: entry.impCwd ?? '',
                  placeholder: t('import.cwd.placeholder'),
                  onChange: (event) => controller.setImportField(sessionId, 'impCwd', event.target.value),
                }),
              ],
            }),
            preview !== null
              ? jsxs('div', {
                  className: 'dshce-group',
                  children: [
                    jsx('p', {
                      className: 'dshce-group-title',
                      children: format(t('import.preview.title'), {
                        kind: preview.kind === 'log' ? t('import.kind.log') : t('import.kind.markdown'),
                        title: preview.title || t('import.preview.untitled'),
                        count: preview.eventCount,
                      }),
                    }),
                    (preview.warnings ?? []).length === 0
                      ? null
                      : jsx('ul', {
                          className: 'dshce-warnings',
                          children: preview.warnings.map((warning, index) => jsx('li', { key: index, children: warning })),
                        }),
                  ],
                })
              : null,
            entry.impError === null || entry.impError === undefined
              ? null
              : jsx('p', {
                  className: 'dshce-error',
                  role: 'status',
                  children:
                    entry.impError === 'no-file'
                      ? t('import.error.noFile')
                      : format(t('error.import'), { message: entry.impError }),
                }),
          ],
        }),
      })
    }

    /** The import tab's footer buttons. */
    function ImportFooter({ sessionId, entry, controller, t }) {
      const hasFile = (entry.impText ?? '') !== '' || (entry.impZip ?? '') !== ''
      const busy = entry.impBusy === true
      return jsxs(Fragment, {
        children: [
          jsx(primitives.Button, {
            variant: 'ghost',
            size: 'md',
            disabled: busy || !hasFile,
            onClick: () => controller.runImport(sessionId, true),
            children: t('import.preview.show'),
          }),
          jsx(primitives.Button, {
            variant: 'ghost',
            size: 'md',
            disabled: busy,
            onClick: () => controller.close(sessionId),
            children: t('action.cancel'),
          }),
          jsx(primitives.Button, {
            variant: 'primary',
            size: 'md',
            disabled: busy || !hasFile,
            onClick: () => controller.runImport(sessionId, false),
            children: busy ? t('action.importing') : t('action.import'),
          }),
        ],
      })
    }

    // --- dialog sizing --------------------------------------------------------

    /** Where the dialog remembers the box the user dragged it to. */
    const SIZE_KEY = 'dsh-chat-export.dialog.v1'
    const MIN_DIALOG_W = 460
    const MIN_DIALOG_H = 320
    /** The eight drag directions, clockwise from the top edge. */
    const DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw']

    /** Keep a number inside a range. */
    function clamp(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    /** The remembered dialog box, or null when there is none. */
    function loadDialogSize() {
      if (typeof window === 'undefined' || window.localStorage === undefined) return null
      try {
        const raw = window.localStorage.getItem(SIZE_KEY)
        if (raw === null) return null
        const saved = JSON.parse(raw)
        if (saved === null || typeof saved !== 'object') return null
        const width = Number(saved.width)
        const height = Number(saved.height)
        if (!Number.isFinite(width) || !Number.isFinite(height)) return null
        return { width, height }
      } catch {
        return null
      }
    }

    /** Remember a box, or forget it when `size` is null. */
    function storeDialogSize(size) {
      if (typeof window === 'undefined' || window.localStorage === undefined) return
      try {
        if (size === null) window.localStorage.removeItem(SIZE_KEY)
        else window.localStorage.setItem(SIZE_KEY, JSON.stringify(size))
      } catch {
        // Storage is a convenience here, never a requirement.
      }
    }

    /** The viewport-bounded limits one drag has to respect. */
    function dialogLimits() {
      const width = typeof window === 'undefined' ? 1280 : window.innerWidth
      const height = typeof window === 'undefined' ? 800 : window.innerHeight
      return {
        minWidth: MIN_DIALOG_W,
        minHeight: MIN_DIALOG_H,
        maxWidth: Math.max(MIN_DIALOG_W, Math.round(width * 0.96)),
        maxHeight: Math.max(MIN_DIALOG_H, Math.round(height * 0.92)),
      }
    }

    /**
     * The box a drag produces, given where it started and how far it moved.
     *
     * The dialog is centred by the primitive, so the box grows and shrinks
     * around its middle: dragging the west edge left widens it rather than
     * sliding it sideways. That is predictable, and it never fights the layout
     * that keeps the dialog centred.
     */
    function resizedBox(start, delta, direction, limits) {
      let width = start.width
      let height = start.height
      if (direction.indexOf('e') !== -1) width = start.width + delta.dx
      else if (direction.indexOf('w') !== -1) width = start.width - delta.dx
      if (direction.indexOf('s') !== -1) height = start.height + delta.dy
      else if (direction.indexOf('n') !== -1) height = start.height - delta.dy
      return {
        width: clamp(width, limits.minWidth, limits.maxWidth),
        height: clamp(height, limits.minHeight, limits.maxHeight),
      }
    }

    /** Apply one box to the dialog element, pinning it so flex cannot undo it. */
    function applyBox(dialog, box) {
      dialog.style.width = `${box.width}px`
      dialog.style.height = `${box.height}px`
      // A pinned height has to scroll, or the footer is pushed out of the box.
      dialog.style.overflowY = 'auto'
    }

    /** Resize the dialog by dragging one edge or corner. */
    function beginResize(event, direction) {
      const handle = event.currentTarget
      const dialog = handle.closest === undefined ? null : handle.closest('.dshce-modal')
      if (dialog === null) return
      event.preventDefault()
      const box = dialog.getBoundingClientRect()
      const start = { width: box.width, height: box.height }
      const origin = { x: event.clientX, y: event.clientY }
      const limits = dialogLimits()
      applyBox(dialog, start)
      const move = (moveEvent) => {
        applyBox(
          dialog,
          resizedBox(start, { dx: moveEvent.clientX - origin.x, dy: moveEvent.clientY - origin.y }, direction, limits),
        )
      }
      const finish = () => {
        handle.removeEventListener('pointermove', move)
        handle.removeEventListener('pointerup', finish)
        handle.removeEventListener('pointercancel', finish)
        const done = dialog.getBoundingClientRect()
        storeDialogSize({ width: Math.round(done.width), height: Math.round(done.height) })
      }
      try {
        handle.setPointerCapture(event.pointerId)
      } catch {
        // A pointer that already ended cannot be captured; the drag still works
        // while it is over the handle.
      }
      handle.addEventListener('pointermove', move)
      handle.addEventListener('pointerup', finish)
      handle.addEventListener('pointercancel', finish)
    }

    /** Forget the dragged size and go back to the stylesheet's box. */
    function resetDialogSize(event) {
      const dialog = event.currentTarget.closest === undefined ? null : event.currentTarget.closest('.dshce-modal')
      if (dialog === null) return
      dialog.style.width = ''
      dialog.style.height = ''
      dialog.style.overflowY = ''
      storeDialogSize(null)
    }

    /** Re-apply the remembered box once the dialog exists in the DOM. */
    function applySavedSize(node) {
      if (node === null || node.closest === undefined) return
      const dialog = node.closest('.dshce-modal')
      if (dialog === null) return
      const saved = loadDialogSize()
      if (saved === null) return
      const limits = dialogLimits()
      applyBox(dialog, {
        width: clamp(saved.width, limits.minWidth, limits.maxWidth),
        height: clamp(saved.height, limits.minHeight, limits.maxHeight),
      })
    }

    /** The eight drag handles. Double-click any of them to reset the box. */
    function ResizeHandles() {
      return jsx('div', {
        className: 'dshce-rz-layer',
        ref: applySavedSize,
        children: DIRECTIONS.map((direction) =>
          jsx('div', {
            key: direction,
            className: `dshce-rz dshce-rz-${direction}`,
            onPointerDown: (event) => beginResize(event, direction),
            onDoubleClick: resetDialogSize,
          }),
        ),
      })
    }

    /** The one dialog behind the header button: export and import tabs. */
    function ExportDialog({ sessionId, entry, controller, t }) {
      if (!entry.open) return null
      const tab = entry.tab ?? 'export'
      const isImport = tab === 'import'
      return jsx(primitives.Modal, {
        open: true,
        className: 'dshce-modal',
        title: t(isImport ? 'import.dialog.title' : 'dialog.title'),
        description: t(isImport ? 'import.dialog.description' : 'dialog.description'),
        closeLabel: t('action.cancel'),
        onClose: () => controller.close(sessionId),
        footer: isImport
          ? jsx(ImportFooter, { sessionId, entry, controller, t })
          : jsx(ExportFooter, { sessionId, entry, controller, t }),
        children: jsxs(Fragment, {
          children: [
            jsx(TabRow, { tab, onChange: (value) => controller.setTab(sessionId, value), t }),
            isImport
              ? jsx(ImportBody, { sessionId, entry, controller, t })
              : jsx(ExportBody, { sessionId, entry, controller, t }),
            jsx(ResizeHandles, {}),
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
          jsx(primitives.Button, {
            size: 'sm',
            className: 'dshce-header-action',
            disabled: entry.busy,
            'aria-busy': entry.busy === true,
            // The icon carries no text, so the accessible name and the tooltip
            // are the only things naming the action.
            'aria-label': t('action.label'),
            title: t('action.title'),
            onClick: () => controller.open(sessionId),
            // Two halves of one glyph: top is the share icon as-is (export),
            // bottom is the same path rotated 180° (import) — one icon, both
            // directions, and it still sits in the 15px box the old icon used.
            children: jsx('span', {
              className: 'dshce-header-icon',
              children: [
                jsx('span', {
                  key: 'out',
                  className: 'dshce-header-icon-half',
                  children: jsx(primitives.IconShareOutlineRegular, {}),
                }),
                jsx('span', {
                  key: 'in',
                  className: 'dshce-header-icon-half dshce-header-icon-flip',
                  children: jsx(primitives.IconShareOutlineRegular, {}),
                }),
              ],
            }),
          }),
          jsx(ExportDialog, { sessionId, entry, controller, t }),
          notice === null || notice === undefined
            ? null
            : jsx(primitives.Toast, {
                key: `${notice.kind}:${notice.name ?? notice.path ?? notice.title ?? ''}`,
                text:
                  notice.kind === 'saved'
                    ? format(t('notice.saved'), { path: notice.path })
                    : notice.kind === 'imported'
                      ? format(t('notice.imported'), { title: notice.title ?? '', count: notice.count ?? 0 })
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
    // Exposed for the resize test: the drag maths is the only part of the
    // dialog that can be checked without a DOM.
    exports.resizedBox = resizedBox
    return module.exports
  },
})
