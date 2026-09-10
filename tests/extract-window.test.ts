import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  SURFACE_TYPES, isSurfaceType, takeTail, selectWindow, truncateBytes,
  messageBlocksOf, blockText, renderBlocks, renderEventText, isConversationEvent,
  DEFAULT_MESSAGE_SCOPE, scopeOfType, inScope,
} from '../src/extract/window.js'

function ev(type: string, seq: number, data: Record<string, unknown> = {}): any {
  return { type, seq, data }
}

test('isSurfaceType accepts exactly the three surface event types', () => {
  assert.deepEqual(SURFACE_TYPES, ['user/message', 'assistant/message', 'tool/result'])
  for (const t of SURFACE_TYPES) assert.equal(isSurfaceType(t), true)
  for (const t of ['turn/start', 'step/start', 'assistant/chunk', 'request/header', 'session/title', 'tool/call']) {
    assert.equal(isSurfaceType(t), false)
  }
})

test('takeTail keeps the trailing items', () => {
  assert.deepEqual(takeTail([1, 2, 3], 2), [2, 3])
  assert.deepEqual(takeTail([1, 2, 3], 5), [1, 2, 3])
  assert.deepEqual(takeTail([1, 2, 3], 0), [])
})

test('selectWindow default scope excludes tool results (conversation only)', () => {
  const events = [
    ev('turn/start', 1),
    ev('user/message', 2, { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }),
    ev('assistant/message', 3, { message: { content: [{ type: 'text', text: 'yo' }] } }),
    ev('tool/result', 4, { message: { content: [] } }),
    ev('assistant/chunk', 5),
    ev('user/message', 6, { content: [], source: { kind: 'user' } }),
  ]
  assert.deepEqual(DEFAULT_MESSAGE_SCOPE, ['user', 'assistant'])
  // Default scope: tool/result (seq 4) excluded; seq > 1 drops turn/start (seq 1).
  const win = selectWindow(events, 1, 10)
  assert.deepEqual(win.map(e => e.seq), [2, 3, 6])
  // seq boundary excludes messages at or before it.
  assert.deepEqual(selectWindow(events, 3, 10).map(e => e.seq), [6])
  // Explicit full scope (incl. tool_result) restores the legacy behavior.
  assert.deepEqual(selectWindow(events, 1, 10, ['user', 'assistant', 'tool_result']).map(e => e.seq), [2, 3, 4, 6])
  // tail cap keeps the most recent (conversation only by default).
  assert.deepEqual(selectWindow(events, 0, 2).map(e => e.seq), [3, 6])
  // zero cap yields nothing.
  assert.deepEqual(selectWindow(events, 0, 0), [])
})

test('selectWindow excludes system-injected user messages regardless of scope', () => {
  const events = [
    ev('user/message', 1, { content: [{ type: 'text', text: 'real' }], source: { kind: 'user' } }),
    ev('user/message', 2, { content: [{ type: 'text', text: 'runtime context...' }], source: { kind: 'plugin' } }),
    ev('user/message', 3, { content: [{ type: 'text', text: 'skill list' }], source: { kind: 'skill-catalog' } }),
    ev('user/message', 4, { content: [{ type: 'text', text: 'memory index' }], source: { kind: 'memory-catalog' } }),
    ev('user/message', 5, { content: [{ type: 'text', text: 'agent instructions' }], source: { kind: 'agent-instructions' } }),
    ev('user/message', 6, { content: [{ type: 'text', text: 'goal' }], source: { kind: 'goal' } }),
    ev('assistant/message', 7, { message: { content: [{ type: 'text', text: 'ok' }] } }),
    ev('tool/result', 8, { message: { content: [] } }),
  ]
  // Default: real user message + assistant (tool results excluded).
  assert.deepEqual(selectWindow(events, 0, 10).map(e => e.seq), [1, 7])
  // Injections stay excluded even when tool_result is explicitly enabled.
  assert.deepEqual(selectWindow(events, 0, 10, ['user', 'assistant', 'tool_result']).map(e => e.seq), [1, 7, 8])
  // Tail cap applies after exclusion.
  assert.deepEqual(selectWindow(events, 0, 2).map(e => e.seq), [1, 7])
})

test('scopeOfType and inScope map surface types to messageScope keys', () => {
  assert.equal(scopeOfType('user/message'), 'user')
  assert.equal(scopeOfType('assistant/message'), 'assistant')
  assert.equal(scopeOfType('tool/result'), 'tool_result')
  assert.equal(scopeOfType('turn/start'), undefined)
  assert.equal(inScope('tool/result', DEFAULT_MESSAGE_SCOPE), false)
  assert.equal(inScope('tool/result', ['user', 'assistant', 'tool_result']), true)
  assert.equal(inScope('user/message', ['user']), true)
  assert.equal(inScope('assistant/message', ['user']), false)
})

test('isConversationEvent accepts only real user input for user/message', () => {
  const real = { type: 'user/message', seq: 1, data: { source: { kind: 'user' } } }
  const injected = { type: 'user/message', seq: 2, data: { source: { kind: 'memory-catalog' } } }
  const sourceless = { type: 'user/message', seq: 3, data: {} }
  assert.equal(isConversationEvent(real), true)
  assert.equal(isConversationEvent(injected), false)
  assert.equal(isConversationEvent(sourceless), false)
  assert.equal(isConversationEvent({ type: 'assistant/message', seq: 4, data: {} }), true)
  assert.equal(isConversationEvent({ type: 'tool/result', seq: 5, data: {} }), true)
})

test('truncateBytes is byte-aware and never splits UTF-8', () => {
  assert.equal(truncateBytes('hello', 10), 'hello')
  assert.equal(truncateBytes('hello', 3), 'hel')
  // '中' is 3 bytes; 4 bytes must keep the full '中' plus the next byte.
  const out = truncateBytes('中abc', 4)
  assert.equal(Buffer.byteLength(out, 'utf8'), 4)
  assert.equal(out, '中a')
  assert.ok(!out.includes('�'))
  assert.equal(truncateBytes('x', 0), '')
})

test('messageBlocksOf reads both data shapes', () => {
  const direct = { content: [{ type: 'text', text: 'a' }] }
  assert.equal((messageBlocksOf(direct) as any[]).length, 1)
  const nested = { message: { content: [{ type: 'text', text: 'b' }] } }
  assert.equal((messageBlocksOf(nested) as any[]).length, 1)
  assert.equal((messageBlocksOf({}) as any[]).length, 0)
})

test('blockText renders text, tool-call, and truncated tool-result', () => {
  assert.equal(blockText({ type: 'text', text: 'hello' }, 100), 'hello')
  assert.equal(blockText({ type: 'tool-call', name: 'search_memory', id: 'c1' }, 100), '[tool-call search_memory]')
  const result = blockText({ type: 'tool-result', id: 'c1', content: [{ type: 'text', text: 'hit line' }] }, 100)
  assert.ok(result!.includes('hit line'))
  assert.ok(result!.startsWith('[tool-result c1]'))
  // long tool result truncated
  const long = blockText({ type: 'tool-result', id: 'c2', content: [{ type: 'text', text: 'x'.repeat(500) }] }, 50)
  assert.ok(long!.length < 200)
})

test('renderEventText prefixes roles and skips unknown blocks', () => {
  assert.equal(renderEventText(ev('user/message', 1, { content: [{ type: 'text', text: '你好' }] }), 100), '[user] 你好')
  assert.equal(renderEventText(ev('assistant/message', 2, { message: { content: [{ type: 'text', text: 'ok' }] } }), 100), '[assistant] ok')
  assert.equal(renderEventText(ev('tool/result', 3, { message: { content: [] } }), 100), '[tool (no text)]')
  // non-surface event renders with assistant fallback prefix
  assert.equal(renderEventText(ev('turn/start', 4), 100), '[assistant (no text)]')
})
