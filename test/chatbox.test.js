import { describe, expect, it } from 'vitest'
import { looksLikeChatboxJson, readChatbox } from '../src/chatbox.js'
import { eventsFromMarkdown } from '../src/import.js'
import { detectImportKind } from '../src/index.js'

// Shaped like a real Chatbox HTML export: one wrapper per message, a bold role
// label, and the body inside a `break-words` element that may hold its own
// markup.
const html = `<!doctype html><html><head><title>与依芙的对话</title></head><body>
<div class="chatbox-export-message flex-row-reverse">
  <b>USER</b>
  <div class="break-words whitespace-pre-wrap">你好，<br>在吗？</div>
</div>
<div class="chatbox-export-message">
  <b>ASSISTANT</b>
  <div class="break-words whitespace-pre-wrap"><p>在的。</p><ul><li>要点一</li><li>要点二</li></ul></div>
</div>
</body></html>`

const backup = {
  name: '与依芙的对话',
  messages: [
    { role: 'user', contentParts: [{ type: 'text', text: '你好' }] },
    {
      role: 'assistant',
      contentParts: [
        { type: 'reasoning', text: '先打个招呼。' },
        { type: 'text', text: '你好呀！' },
      ],
    },
  ],
}

describe('readChatbox', () => {
  it('reads an HTML export', () => {
    const parsed = readChatbox(html)
    expect(parsed.title).toBe('与依芙的对话')
    expect(parsed.turns).toHaveLength(1)
    const [user, assistant] = parsed.turns[0].blocks
    expect(user.label).toBe('用户')
    expect(user.text).toBe('你好，\n在吗？')
    expect(assistant.label).toBe('助手')
    // The nested list survives; only the tags are stripped.
    expect(assistant.text).toContain('在的。')
    expect(assistant.text).toContain('要点一')
    expect(assistant.text).toContain('要点二')
  })

  it('decodes entities in an HTML export', () => {
    const parsed = readChatbox('<div class="chatbox-export-message"><b>USER</b><div class="break-words">a &lt;b&gt; &amp; c</div></div>')
    expect(parsed.turns[0].blocks[0].text).toBe('a <b> & c')
  })

  it('reads a JSON backup, keeping the reasoning', () => {
    const parsed = readChatbox(JSON.stringify(backup))
    expect(parsed.title).toBe('与依芙的对话')
    const [user, assistant] = parsed.turns[0].blocks
    expect(user.text).toBe('你好')
    expect(assistant.reasoning).toBe('先打个招呼。')
    expect(assistant.text).toBe('你好呀！')
  })

  it('starts a new turn at every user message', () => {
    const two = {
      messages: [
        { role: 'user', contentParts: [{ type: 'text', text: 'a' }] },
        { role: 'assistant', contentParts: [{ type: 'text', text: 'b' }] },
        { role: 'user', contentParts: [{ type: 'text', text: 'c' }] },
        { role: 'assistant', contentParts: [{ type: 'text', text: 'd' }] },
      ],
    }
    expect(readChatbox(JSON.stringify(two)).turns).toHaveLength(2)
  })

  it('ignores reasoning a backup carries on a user message', () => {
    const odd = {
      messages: [
        { role: 'user', contentParts: [{ type: 'reasoning', text: '不该有' }, { type: 'text', text: 'hi' }] },
        { role: 'assistant', contentParts: [{ type: 'text', text: 'hello' }] },
      ],
    }
    const parsed = readChatbox(JSON.stringify(odd))
    expect(parsed.turns[0].blocks[0].reasoning).toBe('')
    expect(parsed.turns[0].blocks[0].text).toBe('hi')
  })

  it('returns null for anything that is not a Chatbox export', () => {
    expect(readChatbox('# 标题\n\n用户：你好')).toBeNull()
    expect(readChatbox(JSON.stringify({ messages: [] }))).toBeNull()
    expect(readChatbox('{"seq":1,"type":"turn/start"}')).toBeNull()
    expect(readChatbox('<html><body><p>普通网页</p></body></html>')).toBeNull()
  })
})

describe('looksLikeChatboxJson', () => {
  it('recognises a backup', () => {
    expect(looksLikeChatboxJson(JSON.stringify(backup))).toBe(true)
  })

  it('rejects a session log and broken JSON', () => {
    expect(looksLikeChatboxJson('{"seq":1,"type":"turn/start"}')).toBe(false)
    expect(looksLikeChatboxJson('{not json')).toBe(false)
    expect(looksLikeChatboxJson('plain text')).toBe(false)
  })
})

describe('import routing', () => {
  it('sends a Chatbox HTML file down the dialogue path', () => {
    expect(detectImportKind('chat.html', html)).toBe('markdown')
  })

  it('sends a Chatbox JSON backup down the dialogue path, not the log path', () => {
    expect(detectImportKind('backup.json', JSON.stringify(backup))).toBe('markdown')
  })

  it('still sends a real session log to the log path', () => {
    expect(detectImportKind('session.jsonl', '{"seq":0,"type":"turn/start"}')).toBe('log')
  })
})

describe('a Chatbox export becomes a session', () => {
  it('turns the HTML export into user and assistant events', () => {
    const built = eventsFromMarkdown(html, { now: 1000 })
    expect(built.turns).toBe(1)
    expect(built.messages).toBe(2)
    expect(built.title).toBe('与依芙的对话')
    const assistant = built.events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content[0].text).toContain('要点一')
  })

  it('carries the reasoning of a JSON backup into the assistant message', () => {
    const built = eventsFromMarkdown(JSON.stringify(backup), { now: 1000 })
    const assistant = built.events.find((event) => event.type === 'assistant/message')
    expect(assistant.data.message.content).toEqual([
      { type: 'reasoning', text: '先打个招呼。' },
      { type: 'text', text: '你好呀！' },
    ])
  })
})
