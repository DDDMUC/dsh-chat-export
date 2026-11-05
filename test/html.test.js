import { describe, expect, it } from 'vitest'
import { buildTranscript } from '../src/transcript.js'
import { defaultOptions } from '../src/options.js'
import { escapeHtml, formatDuration, renderHtml, renderMarkdownBody } from '../src/html.js'
import {
  assistantMessage,
  header,
  image,
  reasoning,
  resetClock,
  sampleSession,
  text,
  toolCallEvent,
  toolResultEvent,
  turnStart,
  userMessage,
} from './fixtures/build.js'

/** Render HTML for the given events. */
function render(events, overrides = {}, context = {}) {
  const transcript = buildTranscript(header(), events, { ...defaultOptions(), ...overrides })
  return renderHtml(transcript, context)
}

describe('escapeHtml', () => {
  it('escapes the five significant characters', () => {
    expect(escapeHtml(`<script>"x"&'y'</script>`)).toBe('&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;')
  })

  it('handles nullish input', () => {
    expect(escapeHtml(undefined)).toBe('')
  })
})

describe('renderMarkdownBody', () => {
  it('renders a paragraph', () => {
    expect(renderMarkdownBody('hello')).toBe('<p>hello</p>')
  })

  it('renders inline code, bold, italic, and links', () => {
    const html = renderMarkdownBody('a `code` and **bold** and *it* and [x](https://e.com)')
    expect(html).toContain('<code>code</code>')
    expect(html).toContain('<strong>bold</strong>')
    expect(html).toContain('<em>it</em>')
    expect(html).toContain('<a href="https://e.com"')
  })

  it('renders a fenced code block verbatim and escaped', () => {
    const html = renderMarkdownBody('```js\nif (a < b) {}\n```')
    expect(html).toContain('<pre class="code language-js">')
    expect(html).toContain('if (a &lt; b) {}')
    expect(html).not.toContain('<b>')
  })

  it('does not let a fence body escape into markup', () => {
    const html = renderMarkdownBody('```\n</code></pre><script>alert(1)</script>\n```')
    expect(html).not.toContain('<script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders headings one level below the message heading', () => {
    expect(renderMarkdownBody('# One')).toBe('<h4>One</h4>')
    expect(renderMarkdownBody('###### Six')).toBe('<h6>Six</h6>')
  })

  it('renders unordered and ordered lists', () => {
    expect(renderMarkdownBody('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>')
    expect(renderMarkdownBody('1. a\n2. b')).toBe('<ol><li>a</li><li>b</li></ol>')
  })

  it('renders a pipe table with a delimiter row', () => {
    const html = renderMarkdownBody('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(html).toContain('<table><thead><tr><th>a</th><th>b</th></tr></thead>')
    expect(html).toContain('<td>1</td>')
  })

  it('leaves a pipe block alone when the second row is not a delimiter', () => {
    const html = renderMarkdownBody('| a | b |\n| c | d |')
    expect(html).not.toContain('<table>')
    expect(html).toContain('<p>')
  })

  it('renders a blockquote with its inner Markdown', () => {
    expect(renderMarkdownBody('> quoted **text**')).toBe('<blockquote><p>quoted <strong>text</strong></p></blockquote>')
  })

  it('turns single newlines inside a paragraph into line breaks', () => {
    expect(renderMarkdownBody('a\nb')).toBe('<p>a<br>b</p>')
  })

  it('returns nothing for empty input', () => {
    expect(renderMarkdownBody('')).toBe('')
  })
})

describe('renderHtml', () => {
  it('produces a complete self-contained document', () => {
    const html = render([turnStart(0, 1), userMessage(1, 'm', [text('hi')])])
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('<html lang="zh-CN">')
    expect(html.trimEnd().endsWith('</html>')).toBe(true)
    // Self-contained: no stylesheet link and no script src.
    expect(html).not.toContain('<link')
    expect(html).not.toContain('<script src')
    expect(html).toContain('<style>')
  })

  it('carries a print button and a print stylesheet', () => {
    const html = render([])
    expect(html).toContain('打印 / 另存为 PDF')
    expect(html).toContain('window.print()')
    expect(html).toContain('@media print')
    expect(html).toContain('break-inside:avoid')
  })

  it('escapes the title in the head and the heading', () => {
    const html = render([turnStart(0, 1), userMessage(1, 'm', [text('</title><script>x</script>')])], {}, { title: '</title><script>y</script>' })
    expect(html).not.toContain('<script>y</script>')
    expect(html).toContain('&lt;/title&gt;')
  })

  it('does not let a message inject markup', () => {
    const html = render([turnStart(0, 1), userMessage(1, 'm', [text('<img src=x onerror=alert(1)>')])])
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('renders the metadata table', () => {
    const html = render([], {}, {})
    expect(html).toContain('<table class="meta">')
    expect(html).toContain('会话 ID')
    expect(html).toContain('规模')
  })

  it('folds reasoning into a closed details element by default', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [reasoning('内心戏'), text('结论')])]
    const closed = render(events, { thinking: true })
    expect(closed).toContain('<details class="think">')
    const open = render(events, { thinking: true }, { openThinking: true })
    expect(open).toContain('<details class="think" open>')
  })

  it('marks a failed tool call', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'bash'), toolResultEvent(2, 'c', 'boom', { isError: true })]
    const html = render(events, { tools: true })
    expect(html).toContain('<details class="tool err">')
    expect(html).toContain('出错')
  })

  it('embeds an image with its caption', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [image('sha256:aa', { name: 'shot.png' })])]
    const html = render(events, {}, { imageSrc: () => 'assets/001-shot.png' })
    expect(html).toContain('<img src="assets/001-shot.png"')
    expect(html).toContain('<figcaption>shot.png · 640×480 · 2 KiB</figcaption>')
  })

  it('describes an image that has no source', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [image('sha256:aa', { name: 'shot.png' })])]
    const html = render(events, {}, {})
    expect(html).toContain('图片：shot.png')
    expect(html).not.toContain('<img')
  })

  it('carries no decorative emoji anywhere in the output', () => {
    const { header: sessionHeader, events } = sampleSession()
    const transcript = buildTranscript(sessionHeader, events, { ...defaultOptions(), thinking: true, injected: true, system: true })
    const html = renderHtml(transcript, { imageSrc: () => 'assets/001-shot.png' })
    const body = html.slice(html.indexOf('<body>'))
    const emoji = body.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu) ?? []
    expect(emoji).toEqual([])
  })

  it('renders a whole sample session with balanced section tags', () => {
    const { header: sessionHeader, events } = sampleSession()
    const transcript = buildTranscript(sessionHeader, events, { ...defaultOptions(), thinking: true, injected: true, system: true })
    const html = renderHtml(transcript, { imageSrc: () => 'assets/001-shot.png' })
    expect((html.match(/<section/g) ?? []).length).toBe((html.match(/<\/section>/g) ?? []).length)
    expect((html.match(/<details/g) ?? []).length).toBe((html.match(/<\/details>/g) ?? []).length)
    expect(html).toContain('回合 3')
    expect(html).toContain('只有 spliced 里有这条')
  })

  it('always closes the last open section', () => {
    const html = render([turnStart(0, 1), userMessage(1, 'm', [text('last turn, no turn/end')])])
    expect((html.match(/<section/g) ?? []).length).toBe((html.match(/<\/section>/g) ?? []).length)
  })
})

describe('ask_user_question cards', () => {
  const args = JSON.stringify({
    questions: [
      {
        id: 'deploy',
        header: '部署方式',
        question: '新版 client.js 怎么部署？',
        options: [
          { label: '我自己复制并重启', description: '推荐：改动只在你手里' },
          { label: '你来复制' },
        ],
      },
      { id: 'verify', header: '回归', question: '要连接浏览器做回归吗？', options: [{ label: '要' }, { label: '不要' }] },
    ],
  })

  it('renders questions, options, and the chosen answer', () => {
    const answer = JSON.stringify({ answers: [{ id: 'deploy', selected: ['我自己复制并重启'] }] })
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'ask_user_question', args), toolResultEvent(2, 'c', answer)]
    const html = render(events, { tools: true })

    expect(html).toContain('<details class="ask"')
    expect(html).toContain('提问')
    expect(html).toContain('1/2 已回答')
    expect(html).toContain('部署方式')
    expect(html).toContain('新版 client.js 怎么部署？')
    expect(html).toContain('<li class="opt sel"><div class="lbl">我自己复制并重启</div>')
    expect(html).toContain('推荐：改动只在你手里')
    // The unanswered question still renders, with its options.
    expect(html).toContain('要连接浏览器做回归吗？')
  })

  it('marks an unanswered question instead of inventing a choice', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'ask_user_question', args)]
    const html = render(events, { tools: true })
    expect(html).toContain('未记录回答')
    expect(html).toContain('（日志中没有记录选择）')
    expect(html).not.toContain('class="opt sel"')
  })

  it('falls back to the plain tool card when the arguments are not a question set', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'ask_user_question', 'not json')]
    const html = render(events, { tools: true })
    expect(html).not.toContain('class="ask"')
    expect(html).toContain('<details class="tool">')
  })

  it('leaves other tools alone', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'bash', args)]
    const html = render(events, { tools: true })
    expect(html).not.toContain('class="ask"')
  })
})

describe('questions asked from inside a run_code program', () => {
  // The shape a PTC-style preset produces: `ask_user_question` is not callable
  // at the top level, so the program calls it and returns the answers itself,
  // under a key of its own choosing.
  const code = [
    'const fs = await import("node:fs/promises");',
    'const questionRes = await tools.ask_user_question({',
    '  questions: [',
    '    {',
    '      id: "branch_1_release_age",',
    '      header: "分支 1 决策：发布等待期策略与强制参数",',
    '      question: "是否将发布等待期强制跳过参数移植到脚本版？",',
    '      options: [',
    '        { label: "移植该分支（推荐）", description: "勾选强制升级时自动附加参数。" },',
    '        { label: "暂不移植该分支", description: "保持现状。" }',
    '      ]',
    '    }',
    '  ]',
    '});',
    'return { userAnswer: questionRes.answers };',
  ].join('\n')
  const args = JSON.stringify({ code, description: 'Compare and ask', timeoutMs: 600000 })
  const answered = `${JSON.stringify({
    releaseAgeDef: '',
    userAnswer: [{ id: 'branch_1_release_age', selected: ['移植该分支（推荐）'] }],
  })}\nFile sandbox enforcement is partial on this host.`

  function run(seq, callId, result) {
    const events = [turnStart(0, 1), toolCallEvent(1, callId, 'run_code', args)]
    if (result !== undefined) events.push(toolResultEvent(2, callId, result))
    return render(events, { tools: true })
  }

  it('renders the question card above the call that asked it', () => {
    const html = run(1, 'c', answered)
    expect(html).toContain('<details class="ask" open>')
    expect(html).toContain('分支 1 决策：发布等待期策略与强制参数')
    expect(html).toContain('是否将发布等待期强制跳过参数移植到脚本版？')
    expect(html).toContain('1/1 已回答')
    // The picked option is marked, the other one is not.
    expect(html).toContain('<li class="opt sel"><div class="lbl">移植该分支（推荐）</div>')
    expect(html).toContain('<li class="opt"><div class="lbl">暂不移植该分支</div>')
    // The call itself is still there, below the card.
    expect(html.indexOf('class="ask"')).toBeLessThan(html.indexOf('<details class="tool"'))
  })

  it('still shows the questions when the program did not return the answers', () => {
    const html = run(1, 'c', '{"ok":true}')
    expect(html).toContain('未记录回答')
    expect(html).toContain('是否将发布等待期强制跳过参数移植到脚本版？')
    expect(html).not.toContain('class="opt sel"')
  })

  it('finds answers under any key, not just a fixed one', () => {
    const html = run(1, 'c', JSON.stringify({ anything: { nested: [{ id: 'branch_1_release_age', selected: ['暂不移植该分支'] }] } }))
    expect(html).toContain('1/1 已回答')
    expect(html).toContain('<li class="opt sel"><div class="lbl">暂不移植该分支</div>')
  })

  it('leaves a program without a question alone', () => {
    const plain = JSON.stringify({ code: 'const x = await fs.readFile("a"); return x;' })
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'run_code', plain)]
    const html = render(events, { tools: true })
    expect(html).not.toContain('class="ask"')
    expect(html).toContain('<details class="tool">')
  })

  it('falls back rather than guessing when the literal is not readable', () => {
    // The question set is a variable, so there is nothing static to read.
    const dynamic = JSON.stringify({ code: 'const qs = buildQuestions(); await tools.ask_user_question({ questions: qs });' })
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'run_code', dynamic)]
    const html = render(events, { tools: true })
    expect(html).not.toContain('class="ask"')
    expect(html).toContain('<details class="tool">')
  })
})

describe('content headings', () => {
  it('gives every demoted level an explicit size', () => {
    const html = render([], {}, {})
    // The renderer maps `#`..`###` to h4..h6 so the turn/message outline stays
    // the document skeleton; unstyled levels fall back to ~10px browser text.
    for (const level of ['h4', 'h5', 'h6']) {
      expect(html, `${level} rule`).toMatch(new RegExp(`${level}\\{font-size:\\d`))
    }
  })

  it('renders ### as h6 rather than dropping the heading', () => {
    expect(renderMarkdownBody('### 小标题')).toBe('<h6>小标题</h6>')
  })
})

describe('row titles', () => {
  it('previews a reasoning block with its first line', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [reasoning('核对分支二的条件。\n第二行不该出现在标题里。')])]
    const html = render(events, { thinking: true })
    expect(html).toContain('<summary>思考 · 核对分支二的条件。（')
    expect(html).not.toContain('思考 · 核对分支二的条件。第二行')
  })

  it('falls back to the character count when there is nothing to preview', () => {
    const events = [turnStart(0, 1), assistantMessage(1, [reasoning('   \n  ')])]
    expect(render(events, { thinking: true })).toMatch(/<summary>思考（\d+ 字）<\/summary>/)
  })

  it('cuts a very long preview at a readable length', () => {
    const long = '一'.repeat(120)
    const events = [turnStart(0, 1), assistantMessage(1, [reasoning(long)])]
    const html = render(events, { thinking: true })
    const summary = /<summary>思考 · (.*?)<\/summary>/.exec(html)[1]
    expect(summary).toBe(`${'一'.repeat(60)}…（120 字）`)
  })

  it('uses the call description as the tool title', () => {
    const args = JSON.stringify({ description: '查看 core/compatibility.py 中的兼容性判定', code: 'x' })
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'run_code', args)]
    const html = render(events, { tools: true })
    expect(html).toContain('<code>run_code</code> · 查看 core/compatibility.py 中的兼容性判定')
  })

  it('leaves a call without a description alone', () => {
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'bash', JSON.stringify({ command: 'ls' }))]
    const html = render(events, { tools: true })
    expect(html).toContain('<summary><code>bash</code>')
  })

  it('escapes a description that contains markup', () => {
    const args = JSON.stringify({ description: '<img src=x onerror=alert(1)>', code: 'x' })
    const events = [turnStart(0, 1), toolCallEvent(1, 'c', 'run_code', args)]
    const html = render(events, { tools: true })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })
})

describe('reading width', () => {
  it('exposes a width control and a CSS variable for it', () => {
    const html = render([], {}, {})
    expect(html).toContain('max-width:var(--wrap,900px)')
    expect(html).toContain('id="dshce-w"')
    expect(html).toContain('dshceWidth()')
    expect(html).toContain('1360px')
  })
})

describe('formatDuration', () => {
  it('scales the unit to the length', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(850)).toBe('850ms')
    expect(formatDuration(4200)).toBe('4.2s')
    expect(formatDuration(60000)).toBe('1m')
    expect(formatDuration(1933659)).toBe('32m 14s')
  })

  it('treats a missing duration as zero rather than NaN', () => {
    expect(formatDuration(undefined)).toBe('0ms')
    expect(formatDuration(-5)).toBe('0ms')
  })
})
