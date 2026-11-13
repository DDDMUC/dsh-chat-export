import { describe, expect, it } from 'vitest'
import {
  convertDeepseekSession,
  fileEntriesOf,
  mediaTypeOf,
  syntheticFileRef,
  looksLikeDeepseekExport,
  rankSessions,
  readDeepseekExport,
  selectBranch,
} from '../src/deepseek.js'

/** One export message node. */
function msg(id, parentId, role, fragments, status = 'FINISHED', at = '2026-01-01T00:00:00Z') {
  return { id, parent_id: parentId, role, status, inserted_at: at, fragments }
}

/** A conversation file with one question and one answer. */
function conversation(fragments = [{ type: 'RESPONSE', content: '好的' }], extra = {}) {
  return {
    id: 'c1',
    title: '一次对话',
    current_message_id: 2,
    inserted_at: '2026-01-01T00:00:00Z',
    messages: [
      msg(1, null, 'USER', [{ type: 'REQUEST', content: '你好' }]),
      msg(2, 1, 'ASSISTANT', fragments),
    ],
    ...extra,
  }
}

/** The events of one converted conversation. */
function eventsOf(file, images) {
  return convertDeepseekSession(file, images === undefined ? {} : { images }).events
}

/** A conversation whose question carries one file. */
function attachedConversation(fileName = 'report.pdf', isImage = false) {
  return {
    messages: [
      msg(1, null, 'USER', [
        { type: 'REQUEST', content: '看这个' },
        {
          type: 'FILE',
          files: [{ id: 'f1', file_name: fileName, file_size: 2048, is_image: isImage, export_path: 'files/f1' }],
        },
      ]),
      msg(2, 1, 'ASSISTANT', [{ type: 'RESPONSE', content: '收到' }]),
    ],
    current_message_id: 2,
  }
}

describe('looksLikeDeepseekExport', () => {
  it('recognises a manifest with a numeric version', () => {
    const entries = new Map([['manifest.json', Buffer.from('{"export_format_version":3}')]])
    expect(looksLikeDeepseekExport(entries)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(looksLikeDeepseekExport(new Map())).toBe(false)
    expect(looksLikeDeepseekExport(new Map([['manifest.json', Buffer.from('{oops')]]))).toBe(false)
    expect(looksLikeDeepseekExport(new Map([['assets.json', Buffer.from('[]')]]))).toBe(false)
  })
})

describe('readDeepseekExport', () => {
  const entries = new Map([
    ['manifest.json', Buffer.from('{"export_format_version":3}')],
    ['chat_session_index.json', Buffer.from(JSON.stringify([{ id: 'c1', updated_at: '2026-01-02T00:00:00Z' }]))],
    ['chat_sessions/c1.json', Buffer.from(JSON.stringify(conversation()))],
    ['chat_sessions/broken.json', Buffer.from('{oops')],
  ])

  it('reads the index and every conversation that parses', () => {
    const parsed = readDeepseekExport(entries)
    expect(parsed.version).toBe(3)
    expect(parsed.index).toHaveLength(1)
    expect([...parsed.sessions.keys()]).toEqual(['c1'])
  })

  it('refuses a version it does not understand', () => {
    const other = new Map([['manifest.json', Buffer.from('{"export_format_version":4}')]])
    expect(() => readDeepseekExport(other)).toThrow(/unsupported-version/u)
  })

  it('refuses a missing manifest or index', () => {
    expect(() => readDeepseekExport(new Map())).toThrow(/missing-manifest/u)
    expect(() =>
      readDeepseekExport(new Map([['manifest.json', Buffer.from('{"export_format_version":3}')]])),
    ).toThrow(/missing-index/u)
  })
})

describe('rankSessions', () => {
  it('puts the most recently updated first', () => {
    const ranked = rankSessions([
      { id: 'old', updated_at: '2026-01-01T00:00:00Z' },
      { id: 'new', updated_at: '2026-03-01T00:00:00Z' },
      { id: 'mid', updated_at: '2026-02-01T00:00:00Z' },
    ])
    expect(ranked.map((row) => row.id)).toEqual(['new', 'mid', 'old'])
  })

  it('sorts a row without a usable time last', () => {
    const ranked = rankSessions([{ id: 'none' }, { id: 'dated', updated_at: '2026-01-01T00:00:00Z' }])
    expect(ranked.map((row) => row.id)).toEqual(['dated', 'none'])
  })

  it('ignores rows without an id', () => {
    expect(rankSessions([{ updated_at: '2026-01-01T00:00:00Z' }, null])).toEqual([])
  })
})

describe('selectBranch', () => {
  it('follows current_message_id back to the root', () => {
    const file = {
      messages: [
        msg(1, null, 'USER', []),
        msg(2, 1, 'ASSISTANT', []),
        msg(3, 2, 'USER', []),
        msg(4, 3, 'ASSISTANT', []),
        // A second branch off message 2 that the website was not showing.
        msg(5, 2, 'USER', []),
      ],
      current_message_id: 4,
    }
    expect(selectBranch(file).map((message) => message.id)).toEqual([1, 2, 3, 4])
  })

  it('falls back to the greatest id when current_message_id is absent or unknown', () => {
    const base = { messages: [msg(1, null, 'USER', []), msg(2, 1, 'ASSISTANT', [])] }
    expect(selectBranch({ ...base, current_message_id: null }).map((m) => m.id)).toEqual([1, 2])
    expect(selectBranch({ ...base, current_message_id: 99 }).map((m) => m.id)).toEqual([1, 2])
  })

  it('refuses a missing parent and a cycle', () => {
    expect(() => selectBranch({ messages: [msg(2, 1, 'USER', [])], current_message_id: 2 })).toThrow(/does not exist/u)
    expect(() =>
      selectBranch({ messages: [msg(1, 2, 'USER', []), msg(2, 1, 'ASSISTANT', [])], current_message_id: 1 }),
    ).toThrow(/cycle/u)
  })
})

describe('convertDeepseekSession', () => {
  it('opens with a protected system head', () => {
    const head = eventsOf(conversation()).find((event) => event.surfaceOp !== undefined)
    expect(head.type).toBe('system/message')
    expect(head.data.message).toMatchObject({ role: 'system', content: [], source: { kind: 'system-prompt' } })
  })

  it('turns one question and answer into one turn', () => {
    const events = eventsOf(conversation())
    const user = events.find((event) => event.type === 'user/message')
    const assistant = events.find((event) => event.type === 'assistant/message')
    expect(user.data.content[0].text).toBe('你好')
    expect(assistant.data.message.content[0].text).toBe('好的')
    expect(events.at(-1).data.reason.kind).toBe('completed')
  })

  it('keeps the title', () => {
    expect(convertDeepseekSession(conversation()).title).toBe('一次对话')
  })

  it('maps THINK to a reasoning block', () => {
    const events = eventsOf(conversation([{ type: 'THINK', content: '先想一想' }, { type: 'RESPONSE', content: '答案' }]))
    const assistant = events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content).toEqual([
      { type: 'reasoning', text: '先想一想' },
      { type: 'text', text: '答案' },
    ])
  })

  it('replays a search as a web_search call with its results', () => {
    const events = eventsOf(
      conversation([
        {
          type: 'TOOL_SEARCH',
          queries: ['deepseek'],
          results: [{ url: 'https://example.com', title: '例子', snippet: '片段' }],
          status: 'FINISHED',
        },
        { type: 'RESPONSE', content: '查到了' },
      ]),
    )
    const call = events.find((event) => event.type === 'tool/call')
    const result = events.find((event) => event.type === 'tool/result')
    expect(call.data.name).toBe('web_search')
    expect(JSON.parse(call.data.arguments)).toEqual({ queries: ['deepseek'] })
    expect(result.data.message.content[0].text).toContain('https://example.com')
    expect(result.data.message.isError).toBe(false)
  })

  it('replays an opened page as web_fetch', () => {
    const events = eventsOf(
      conversation([
        { type: 'TOOL_OPEN', status: 'FINISHED', url: 'https://example.com/a', title: '页面' },
        { type: 'RESPONSE', content: '读完了' },
      ]),
    )
    const call = events.find((event) => event.type === 'tool/call')
    expect(call.data.name).toBe('web_fetch')
    const result = events.find((event) => event.type === 'tool/result')
    expect(result.data.message.content[0].text).toContain('not included')
  })

  it('marks a failed search as an error result', () => {
    const events = eventsOf(conversation([{ type: 'TOOL_SEARCH', queries: ['x'], results: [], status: 'FAILED' }]))
    expect(events.find((event) => event.type === 'tool/result').data.message.isError).toBe(true)
  })

  it('drops a question whose reply was withdrawn by content filtering', () => {
    const file = {
      messages: [
        msg(1, null, 'USER', [{ type: 'REQUEST', content: '违规问题' }]),
        msg(2, 1, 'ASSISTANT', [], 'CONTENT_FILTER'),
        msg(3, 2, 'USER', [{ type: 'REQUEST', content: '正常问题' }]),
        msg(4, 3, 'ASSISTANT', [{ type: 'RESPONSE', content: '正常回答' }]),
      ],
      current_message_id: 4,
    }
    const events = eventsOf(file)
    const texts = events.filter((event) => event.type === 'user/message').map((event) => event.data.content[0].text)
    expect(texts).toEqual(['正常问题'])
  })

  it('ends the turn with an error when the reply never finished', () => {
    const events = eventsOf(conversation([{ type: 'RESPONSE', content: '半截' }], { }))
    expect(events.at(-1).data.reason.kind).toBe('completed')

    const unfinished = {
      messages: [
        msg(1, null, 'USER', [{ type: 'REQUEST', content: '问' }]),
        msg(2, 1, 'ASSISTANT', [{ type: 'RESPONSE', content: '半截' }], 'TIMEOUT'),
      ],
      current_message_id: 2,
    }
    const failed = eventsOf(unfinished)
    expect(failed.at(-1).data.reason.kind).toBe('error')
    expect(failed.at(-1).data.reason.error.code).toBe('DEEPSEEK_EXPORT_TIMEOUT')
  })

  it('keeps an attached file as a card with its name and size', () => {
    const user = eventsOf(attachedConversation()).find((event) => event.type === 'user/message')
    expect(user.data.content[0]).toEqual({
      type: 'file',
      attachment: expect.objectContaining({ name: 'report.pdf', bytes: 2048 }),
    })
    expect(user.data.content[1].text).toBe('看这个')
  })

  it('uses a stored image reference when the host has one', () => {
    const ref = { attachmentId: 'sha256:abc', name: 'photo.png', mediaType: 'image/png' }
    const user = eventsOf(attachedConversation('photo.png', true), new Map([['f1', ref]])).find(
      (event) => event.type === 'user/message',
    )
    expect(user.data.content[0]).toEqual({ type: 'image', attachment: ref })
  })

  it('falls back to a file card when the image was not stored', () => {
    const user = eventsOf(attachedConversation('photo.png', true)).find((event) => event.type === 'user/message')
    expect(user.data.content[0].type).toBe('file')
    expect(user.data.content[0].attachment.name).toBe('photo.png')
  })

  it('throws when nothing survives', () => {
    const file = {
      messages: [msg(1, null, 'USER', [{ type: 'REQUEST', content: 'q' }]), msg(2, 1, 'ASSISTANT', [], 'CONTENT_FILTER')],
      current_message_id: 2,
    }
    expect(() => convertDeepseekSession(file)).toThrow(/withdrawn/u)
  })
})


describe('attachment helpers', () => {
  it('knows which names are images', () => {
    expect(mediaTypeOf('a.PNG')).toBe('image/png')
    expect(mediaTypeOf('a.jpeg')).toBe('image/jpeg')
    expect(mediaTypeOf('a.webp')).toBe('image/webp')
    expect(mediaTypeOf('a.pdf')).toBeUndefined()
    expect(mediaTypeOf('noext')).toBeUndefined()
  })

  it('builds a stable synthetic reference', () => {
    const one = syntheticFileRef({ id: 'f1', file_name: 'dir/report.pdf', file_size: 10 })
    const two = syntheticFileRef({ id: 'f1', file_name: 'dir/report.pdf', file_size: 10 })
    expect(one).toEqual(two)
    expect(one.name).toBe('report.pdf')
    expect(one.bytes).toBe(10)
    expect(one.attachmentId).toMatch(/^sha256:[0-9a-f]{64}$/u)
    expect(syntheticFileRef({ id: 'f2', file_name: 'x' }).attachmentId).not.toBe(one.attachmentId)
  })

  it('lists only the files of the selected branch', () => {
    const file = attachedConversation()
    file.messages.push({
      id: 3,
      parent_id: 1,
      role: 'USER',
      status: 'FINISHED',
      inserted_at: '2026-01-01T00:00:02Z',
      fragments: [{ type: 'FILE', files: [{ id: 'f2', file_name: 'other.png', is_image: true, export_path: 'files/f2' }] }],
    })
    const entries = fileEntriesOf(file)
    expect(entries.map((entry) => entry.id)).toEqual(['f1'])
    expect(entries[0].isImage).toBe(false)
  })

  it('marks an image entry as one', () => {
    const entries = fileEntriesOf(attachedConversation('photo.png', true))
    expect(entries[0]).toMatchObject({ isImage: true, mediaType: 'image/png', exportPath: 'files/f1' })
  })
})
