import { describe, expect, it } from 'vitest'
import { buildTranscript } from '../src/transcript.js'
import { defaultOptions } from '../src/options.js'
import { escapeHtml, renderHtml, renderMarkdownBody } from '../src/html.js'
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
