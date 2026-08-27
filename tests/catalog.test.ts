import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { IndexEntry } from '../src/types.js'
import { digestIndexEntries, readCatalogEntries, renderCatalogMessage, renderCatalogUpdate, catalogMessage, catalogHistory } from '../src/catalog.js'
import { applyCatalogDecision, capCatalogEntries } from '../src/inject.js'

const entries: readonly IndexEntry[] = [
  { category: 'preferences', path: 'preferences/coding.md', summary: 'use pnpm' },
  { category: 'entities', path: 'entities/foo.md', summary: 'react 18' },
]

test('digest is stable and order-independent', () => {
  assert.equal(digestIndexEntries(entries), digestIndexEntries([...entries].reverse()))
  const changed = [...entries]
  changed[0] = { ...changed[0]!, summary: 'use bun' }
  assert.notEqual(digestIndexEntries(entries), digestIndexEntries(changed))
})

test('renderCatalogMessage carries entries, guidance, and peer', () => {
  const message = renderCatalogMessage(entries, 'demo')
  assert.equal(message.source.kind, 'memory-catalog')
  assert.equal(message.source.form, 'catalog')
  assert.equal(message.source.update, undefined)
  assert.equal(message.source.entries.length, 2)
  const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(text, /memory index for the demo project/)
  assert.match(text, /## preferences \(always relevant\)/)
  assert.match(text, /preferences\/coding\.md: use pnpm/)
  assert.match(text, /call remember only when the user explicitly asks/i)
  assert.match(text, /<system-reminder>/)
})

test('renderCatalogUpdate marks the replacement', () => {
  const message = renderCatalogUpdate(entries, 'demo')
  assert.equal(message.source.update, true)
  const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(text, /replaces every earlier memory catalog/)
})

test('readCatalogEntries tolerates malformed records', () => {
  assert.equal(readCatalogEntries({ kind: 'memory-catalog', form: 'catalog', entries: 'nope' }), undefined)
  assert.equal(readCatalogEntries({ entries: [{ category: 'a', path: 'b.md' }] }), undefined)
  assert.deepEqual(readCatalogEntries({ entries }), [...entries])
})

test('catalogMessage finds the catalog in an entering batch', () => {
  const catalog = renderCatalogMessage(entries, 'demo')
  const plain = createUserMessage({ content: [{ type: 'text', text: 'hi' }] })
  const found = catalogMessage([plain, catalog])
  assert.ok(found)
  assert.equal(found!.message.id, catalog.id)
  assert.equal(catalogMessage([plain]), undefined)
})

test('catalogHistory reads visibility from the surface', () => {
  const published = renderCatalogMessage(entries, 'demo')
  const event = { type: 'user/message', seq: 42, data: { ...published } }
  // Published and visible -> visibleDigest present.
  const agent = { session: { events: [event], surface: { nodes: new Set([42]) } } } as unknown as Agent
  const history = catalogHistory(agent)
  assert.equal(history.published, true)
  assert.equal(history.visibleDigest, digestIndexEntries(entries))
  // Published but compacted off the surface -> published, no visible digest.
  const compacted = { session: { events: [event], surface: { nodes: new Set([]) } } } as unknown as Agent
  const compactedHistory = catalogHistory(compacted)
  assert.equal(compactedHistory.published, true)
  assert.equal(compactedHistory.visibleDigest, undefined)
  // Nothing published.
  const empty = { session: { events: [], surface: { nodes: new Set() } } } as unknown as Agent
  assert.deepEqual(catalogHistory(empty), { published: false })
})

function decision(messages: UserMessage[]): PreStepDecision {
  return { kind: 'enter', messages }
}

test('applyCatalogDecision publishes on first sight', () => {
  const base = decision([createUserMessage({ content: [{ type: 'text', text: 'hi' }] })])
  const result = applyCatalogDecision({ decision: base, history: { published: false }, existing: undefined, entries, peer: 'demo' })
  assert.equal(result.kind, 'enter')
  const catalog = catalogMessage(result.messages)
  assert.ok(catalog)
  assert.equal(catalog!.message.source.kind, 'memory-catalog')
  assert.equal(catalog!.message.source.update, undefined)
})

test('applyCatalogDecision republishes as an update when visible digest changed', () => {
  const base = decision([])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleDigest: 'old-digest' },
    existing: undefined,
    entries,
    peer: 'demo',
  })
  const catalog = catalogMessage(result.messages)
  assert.ok(catalog)
  assert.equal(catalog!.message.source.update, true)
})

test('applyCatalogDecision skips when the visible digest already matches', () => {
  const base = decision([])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleDigest: digestIndexEntries(entries) },
    existing: undefined,
    entries,
    peer: 'demo',
  })
  assert.equal(result, base)
})

test('applyCatalogDecision publishes nothing for a fresh empty index', () => {
  const base = decision([])
  const result = applyCatalogDecision({ decision: base, history: { published: false }, existing: undefined, entries: [], peer: 'demo' })
  assert.equal(result, base)
})

test('applyCatalogDecision replaces a stale in-batch catalog with the update', () => {
  // The index changed (summary differs); an older catalog with the old entries
  // is still in the entering batch and must be replaced by the update.
  const staleEntries: readonly IndexEntry[] = [
    { category: 'preferences', path: 'preferences/coding.md', summary: 'use bun' },
    { category: 'entities', path: 'entities/foo.md', summary: 'react 18' },
  ]
  const oldCatalog = renderCatalogMessage(staleEntries, 'demo')
  const base = decision([oldCatalog])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleDigest: 'stale' },
    existing: { message: oldCatalog, entries: staleEntries },
    entries,
    peer: 'demo',
  })
  assert.equal(result.kind, 'enter')
  const replacement = catalogMessage(result.messages)
  assert.ok(replacement)
  assert.notEqual(replacement!.message.id, oldCatalog.id)
  assert.equal(replacement!.message.source.update, true)
  assert.equal(replacement!.message.source.entries[0]!.summary, 'use pnpm')
})

test('renderCatalogMessage advertises shared mounts', () => {
  const message = renderCatalogMessage(entries, 'demo', [{ name: 'dsh-test', peer: 'dsh-test-72572e8b', readonly: true }])
  const text = message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(text, /## shared/)
  assert.match(text, /shared\/dsh-test\//)
  assert.match(text, /read-only mirror of peer 'dsh-test-72572e8b'/)
  // Shared mounts are not part of the digest entries.
  assert.equal(message.source.entries.length, 2)
})

test('applyCatalogDecision publishes a shared-only catalog for an empty index', () => {
  const base = decision([])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: false },
    existing: undefined,
    entries: [],
    sharedMounts: [{ name: 'dsh-test', peer: 'dsh-test-72572e8b', readonly: true }],
    peer: 'demo',
  })
  assert.equal(result.kind, 'enter')
  const catalog = catalogMessage(result.messages)
  assert.ok(catalog)
  const text = catalog!.message.content.map(block => (block.type === 'text' ? block.text : '')).join('')
  assert.match(text, /## shared/)
  // Still no local entries; the shared notice is the only content.
  assert.equal(catalog!.message.source.entries.length, 0)
})

test('applyCatalogDecision does not republish a shared-only catalog once visible', () => {
  const base = decision([])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleDigest: digestIndexEntries([]) },
    existing: undefined,
    entries: [],
    sharedMounts: [{ name: 'dsh-test', peer: 'dsh-test-72572e8b', readonly: true }],
    peer: 'demo',
  })
  assert.equal(result, base)
})

test('applyCatalogDecision drops an in-batch catalog when the visible one matches', () => {
  const staleCatalog = renderCatalogMessage(entries, 'demo')
  const base = decision([createUserMessage({ content: [{ type: 'text', text: 'hi' }] }), staleCatalog])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleDigest: digestIndexEntries(entries) },
    existing: { message: staleCatalog, entries },
    entries,
    peer: 'demo',
  })
  assert.equal(result.kind, 'enter')
  assert.equal(catalogMessage(result.messages), undefined)
})

test('capCatalogEntries keeps everything under budget and drops oldest over it', () => {
  const small = [{ category: 'preferences', path: 'preferences/a.md', summary: 'short' }]
  assert.deepEqual(capCatalogEntries(small, 1200), small)
  const entries = [
    { category: 'events', path: 'events/1.md', summary: 'x'.repeat(200) },
    { category: 'events', path: 'events/2.md', summary: 'x'.repeat(200) },
    { category: 'events', path: 'events/3.md', summary: 'x'.repeat(200) },
    { category: 'events', path: 'events/4.md', summary: 'x'.repeat(200) },
  ]
  // Each ~215-char line ≈ 72 tokens; 4 lines ≈ 288 tokens, under a 1200 budget.
  assert.equal(capCatalogEntries(entries, 1200).length, 4)
  // Tight budget keeps only the newest (head) entries.
  const capped = capCatalogEntries(entries, 350)
  assert.ok(capped.length < 4)
  assert.equal(capped[0]!.path, 'events/1.md')
  // The index file itself is untouched by the injection cap.
  assert.equal(entries.length, 4)
})

test('capCatalogEntries returns empty for a non-positive budget', () => {
  const one = [{ category: 'a', path: 'a/x.md', summary: 's' }]
  assert.deepEqual(capCatalogEntries(one, 100), [])
  assert.deepEqual(capCatalogEntries([], 1200), [])
})
