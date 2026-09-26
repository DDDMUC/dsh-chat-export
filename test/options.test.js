import { describe, expect, it } from 'vitest'
import {
  COMMAND_HINT,
  contentTypeFor,
  extensionFor,
  isTextFormat,
  dateStamp,
  defaultOptions,
  effectiveImageMode,
  exportBaseName,
  exportFilename,
  optionsFromQuery,
  optionsToQuery,
  parseCommandInput,
  slugifyTitle,
  tokenize,
} from '../src/options.js'

describe('defaultOptions', () => {
  it('defaults to the conversation: reasoning and system in, tool calls out', () => {
    const options = defaultOptions()
    expect(options.thinking).toBe(true)
    expect(options.system).toBe(true)
    expect(options.tools).toBe(false)
    expect(options.injected).toBe(false)
    expect(options.scope).toBe('full')
    expect(options.format).toBe('md')
  })

  it('returns a fresh object each time', () => {
    const first = defaultOptions()
    first.thinking = false
    expect(defaultOptions().thinking).toBe(true)
  })
})

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize(' html --thinking ')).toEqual(['html', '--thinking'])
  })

  it('keeps quoted values together', () => {
    expect(tokenize('--save="/tmp/my exports" --timestamps')).toEqual(['--save=/tmp/my exports', '--timestamps'])
    expect(tokenize("--save='/tmp/a b'")).toEqual(['--save=/tmp/a b'])
  })

  it('treats an empty quoted string as a token', () => {
    expect(tokenize('--save=""')).toEqual(['--save='])
  })

  it('handles an empty input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize(undefined)).toEqual([])
  })
})

describe('parseCommandInput', () => {
  it('accepts an empty line and returns the defaults', () => {
    const parsed = parseCommandInput('')
    expect(parsed.errors).toEqual([])
    expect(parsed.options).toEqual(defaultOptions())
    expect(parsed.save).toBe(null)
  })

  it('accepts the leading separator space the registry includes', () => {
    const parsed = parseCommandInput(' html')
    expect(parsed.errors).toEqual([])
    expect(parsed.options.format).toBe('html')
  })

  it('normalizes markdown spellings', () => {
    expect(parseCommandInput('markdown').options.format).toBe('md')
    expect(parseCommandInput('MKD').options.format).toBe('md')
  })

  it('accepts plain text under every spelling', () => {
    for (const token of ['txt', 'text', 'plain', 'TXT']) {
      expect(parseCommandInput(token).options.format, token).toBe('txt')
      expect(parseCommandInput(token).errors, token).toEqual([])
    }
  })

  it('parses boolean flags in both directions', () => {
    const parsed = parseCommandInput('zip --thinking --no-tools --system --injected --no-usage --timestamps')
    expect(parsed.errors).toEqual([])
    expect(parsed.options).toMatchObject({
      format: 'zip',
      thinking: true,
      tools: false,
      system: true,
      injected: true,
      usage: false,
      timestamps: true,
    })
  })

  it('parses value flags', () => {
    const parsed = parseCommandInput('html --images=assets --scope=surface --limit=500')
    expect(parsed.errors).toEqual([])
    expect(parsed.options).toMatchObject({ format: 'html', images: 'assets', scope: 'surface', toolResultLimit: 500 })
  })

  it('treats --surface as the scope switch', () => {
    expect(parseCommandInput('--surface').options.scope).toBe('surface')
    expect(parseCommandInput('--no-surface').options.scope).toBe('full')
  })

  it('collects a save directory, with and without a value', () => {
    expect(parseCommandInput('md --save=/tmp/out').save).toBe('/tmp/out')
    expect(parseCommandInput('md --save').save).toBe('')
    expect(parseCommandInput('md --no-save').save).toBe(null)
  })

  it('rejects an unknown format', () => {
    const parsed = parseCommandInput('pdf')
    expect(parsed.options.format).toBe('md')
    expect(parsed.errors[0]).toMatch(/unknown format/)
  })

  it('rejects an unknown flag', () => {
    expect(parseCommandInput('--nope').errors[0]).toMatch(/unknown option --nope/)
  })

  it('rejects a value on a boolean flag', () => {
    expect(parseCommandInput('--thinking=yes').errors[0]).toMatch(/does not take a value/)
  })

  it('rejects a missing value', () => {
    expect(parseCommandInput('--images').errors[0]).toMatch(/needs a value/)
  })

  it('rejects an out-of-range enum value', () => {
    expect(parseCommandInput('--images=huge').errors[0]).toMatch(/--images must be one of/)
    expect(parseCommandInput('--scope=everything').errors[0]).toMatch(/--scope must be one of/)
  })

  it('rejects a non-numeric limit', () => {
    expect(parseCommandInput('--limit=abc').errors[0]).toMatch(/non-negative number/)
    expect(parseCommandInput('--limit=-5').errors[0]).toMatch(/non-negative number/)
  })

  it('rejects negating a value flag', () => {
    expect(parseCommandInput('--no-images').errors[0]).toMatch(/not a valid flag/)
  })

  it('reports every problem on the line rather than the first', () => {
    expect(parseCommandInput('pdf --wat').errors).toHaveLength(2)
  })

  it('accepts every flag the advertised hint shows', () => {
    // The hint is display copy, not a grammar, so the check is that each flag
    // it advertises is actually accepted.
    for (const token of ['--thinking', '--no-tools', '--surface', '--images=embed', '--save=/tmp/x']) {
      expect(parseCommandInput(token).errors, token).toEqual([])
    }
    expect(COMMAND_HINT).toContain('--surface')
    expect(COMMAND_HINT).toContain('--save')
  })
})

describe('optionsFromQuery', () => {
  it('keeps defaults for absent keys', () => {
    const { options, errors } = optionsFromQuery(new URLSearchParams())
    expect(errors).toEqual([])
    expect(options).toEqual(defaultOptions())
  })

  it('reads booleans in both spellings', () => {
    const { options } = optionsFromQuery(new URLSearchParams('thinking=1&tools=false'))
    expect(options.thinking).toBe(true)
    expect(options.tools).toBe(false)
  })

  it('rejects a non-boolean boolean', () => {
    expect(optionsFromQuery(new URLSearchParams('thinking=maybe')).errors[0]).toMatch(/must be 1 or 0/)
  })

  it('reads enums and rejects bad ones', () => {
    expect(optionsFromQuery(new URLSearchParams('scope=surface&images=none')).options).toMatchObject({
      scope: 'surface',
      images: 'none',
    })
    expect(optionsFromQuery(new URLSearchParams('format=pdf')).errors).toHaveLength(1)
  })

  it('round-trips through optionsToQuery without losing anything', () => {
    const original = { ...defaultOptions(), format: 'zip', thinking: true, scope: 'surface', toolResultLimit: 250 }
    const query = optionsToQuery(original, '/tmp/exports')
    const parsed = optionsFromQuery(query)
    expect(parsed.errors).toEqual([])
    expect(parsed.options).toEqual(original)
    expect(parsed.save).toBe('/tmp/exports')
  })

  it('omits values left at their default', () => {
    const query = optionsToQuery(defaultOptions())
    expect([...query.keys()]).toEqual(['format'])
  })
})

describe('format helpers', () => {
  it('maps every format to an extension and a content type', () => {
    expect(extensionFor('md')).toBe('md')
    expect(extensionFor('html')).toBe('html')
    expect(extensionFor('txt')).toBe('txt')
    expect(extensionFor('zip')).toBe('zip')
    expect(contentTypeFor('txt')).toBe('text/plain; charset=utf-8')
    expect(contentTypeFor('md')).toMatch(/^text\/markdown/)
    expect(contentTypeFor('html')).toMatch(/^text\/html/)
    expect(contentTypeFor('zip')).toBe('application/zip')
  })

  it('treats the three text formats as savable and the bundle as not', () => {
    expect(isTextFormat('md')).toBe(true)
    expect(isTextFormat('html')).toBe(true)
    expect(isTextFormat('txt')).toBe(true)
    expect(isTextFormat('zip')).toBe(false)
  })

  it('builds a .txt filename', () => {
    const created = new Date(2026, 0, 2).getTime()
    expect(exportFilename('txt', '我的会话', created)).toBe('dsh-chat-我的会话-2026-01-02.txt')
  })

  it('round-trips txt through the query', () => {
    const { options, errors } = optionsFromQuery(new URLSearchParams('format=txt'))
    expect(errors).toEqual([])
    expect(options.format).toBe('txt')
    expect(optionsToQuery(options).get('format')).toBe('txt')
  })
})

describe('effectiveImageMode', () => {
  it('embeds for a lone document and references assets in a bundle', () => {
    const options = defaultOptions()
    expect(effectiveImageMode('md', options)).toBe('embed')
    expect(effectiveImageMode('html', options)).toBe('embed')
    expect(effectiveImageMode('zip', options)).toBe('assets')
  })

  it('honours an explicit choice over the automatic one', () => {
    expect(effectiveImageMode('zip', { ...defaultOptions(), images: 'embed' })).toBe('embed')
    expect(effectiveImageMode('md', { ...defaultOptions(), images: 'none' })).toBe('none')
  })
})

describe('slugifyTitle', () => {
  it('keeps CJK intact', () => {
    expect(slugifyTitle('开发 DSH 插件 dsh-chat-export')).toBe('开发-DSH-插件-dsh-chat-export')
  })

  it('neutralizes path separators and traversal', () => {
    expect(slugifyTitle('../../etc/passwd')).toBe('etc-passwd')
    expect(slugifyTitle('a\\b:c*d?e"f<g>h|i')).toBe('a-b-c-d-e-f-g-h-i')
  })

  it('collapses whitespace runs, including ideographic spaces', () => {
    expect(slugifyTitle('a   b\u3000c')).toBe('a-b-c')
  })

  it('strips control characters', () => {
    expect(slugifyTitle('a\u0000b\u001fc')).toBe('a-b-c')
  })

  it('falls back when nothing usable remains', () => {
    expect(slugifyTitle('')).toBe('session')
    expect(slugifyTitle('///')).toBe('session')
    expect(slugifyTitle(undefined)).toBe('session')
    expect(slugifyTitle('', 'abc')).toBe('abc')
  })

  it('caps the length by code points, not UTF-16 units', () => {
    const slug = slugifyTitle('汉'.repeat(200))
    expect(Array.from(slug)).toHaveLength(60)
    expect(slug).not.toContain('\ufffd')
  })
})

describe('filenames', () => {
  it('stamps the local date', () => {
    expect(dateStamp(new Date(2026, 8, 21, 23, 59).getTime())).toBe('2026-09-21')
  })

  it('builds the documented base name', () => {
    const created = new Date(2026, 0, 2, 3, 4).getTime()
    expect(exportBaseName('我的会话', created)).toBe('dsh-chat-我的会话-2026-01-02')
  })

  it('appends the format extension', () => {
    const created = new Date(2026, 0, 2).getTime()
    expect(exportFilename('md', 't', created)).toBe('dsh-chat-t-2026-01-02.md')
    expect(exportFilename('html', 't', created)).toBe('dsh-chat-t-2026-01-02.html')
    expect(exportFilename('zip', 't', created)).toBe('dsh-chat-t-2026-01-02.zip')
  })

  it('maps content types', () => {
    expect(contentTypeFor('md')).toMatch(/^text\/markdown/)
    expect(contentTypeFor('html')).toMatch(/^text\/html/)
    expect(contentTypeFor('zip')).toBe('application/zip')
  })
})
