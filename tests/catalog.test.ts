import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { IndexEntry } from '../src/types.js'
import {
  MEMORY_CATALOG_PLUGIN, isCurrentCatalogText, isMemoryCatalogSource,
  renderCatalogMessage, renderCatalogUpdate, catalogMessage, catalogHistory,
} from '../src/catalog.js'
import { applyCatalogDecision, capCatalogEntries } from '../src/inject.js'

const entries: readonly IndexEntry[] = [
  { category: 'preferences', path: 'preferences/coding.md', summary: 'use pnpm' },
  { category: 'entities', path: 'entities/foo.md', summary: 'react 18' },
]

const mounts = [{ name: 'dsh-test', peer: 'dsh-test-72572e8b', readonly: true }] as const

/** The model-facing text one rendered catalog message publishes. */
const textOf = (message: UserMessage): string =>
  message.content.map(block => (block.type === 'text' ? block.text : '')).join('')

const changedEntries = (): readonly IndexEntry[] => {
  const changed = [...entries]
  changed[0] = { ...changed[0]!, summary: 'use bun' }
  return changed
}

test('the catalog source uses the official plugin kind with the catalog form', () => {
  const message = renderCatalogMessage(entries, 'demo')
  assert.deepEqual(message.source, { kind: 'plugin', plugin: MEMORY_CATALOG_PLUGIN, form: 'catalog' })
  assert.equal(isMemoryCatalogSource(message.source), true)
  // The private kind written before 0.2.3 stays readable for old sessions.
  assert.equal(isMemoryCatalogSource({ kind: 'memory-catalog', form: 'catalog', entries }), true)
  assert.equal(isMemoryCatalogSource({ kind: 'user' }), false)
  assert.equal(isMemoryCatalogSource({ kind: 'plugin', plugin: 'other', form: 'catalog' }), false)
  assert.equal(isMemoryCatalogSource({ kind: 'plugin', plugin: MEMORY_CATALOG_PLUGIN, form: 'instructions' }), false)
  assert.equal(isMemoryCatalogSource(undefined), false)
})

test('renderCatalogMessage carries entries, guidance, and peer', () => {
  const message = renderCatalogMessage(entries, 'demo')
  const text = textOf(message)
  assert.match(text, /memory index for the demo project/)
  assert.match(text, /## preferences \(always relevant\)/)
  assert.match(text, /preferences\/coding\.md: use pnpm/)
  assert.match(text, /call remember only when the user explicitly asks/i)
  assert.match(text, /<system-reminder>/)
})

test('renderCatalogUpdate marks the replacement framing', () => {
  const update = renderCatalogUpdate(entries, 'demo')
  assert.match(textOf(update), /replaces every earlier memory catalog/)
  assert.equal(update.source.kind, 'plugin')
})

test('isCurrentCatalogText matches either framing and detects real change', () => {
  const first = textOf(renderCatalogMessage(entries, 'demo'))
  const update = textOf(renderCatalogUpdate(entries, 'demo'))
  assert.equal(isCurrentCatalogText(first, entries, 'demo'), true)
  assert.equal(isCurrentCatalogText(update, entries, 'demo'), true, 'an update framing with the same entries is current')
  assert.equal(isCurrentCatalogText(first, changedEntries(), 'demo'), false)
  assert.equal(isCurrentCatalogText(first, entries, 'other'), false, 'a different peer renders different text')
  assert.equal(isCurrentCatalogText(textOf(renderCatalogMessage(entries, 'demo', mounts)), entries, 'demo'), false, 'mounts change the text')
  assert.equal(isCurrentCatalogText(textOf(renderCatalogMessage(entries, 'demo', mounts)), entries, 'demo', mounts), true)
})

test('catalogMessage finds the catalog in an entering batch', () => {
  const catalog = renderCatalogMessage(entries, 'demo')
  const plain = createUserMessage({ content: [{ type: 'text', text: 'hi' }] })
  const found = catalogMessage([plain, catalog])
  assert.ok(found)
  assert.equal(found!.message.id, catalog.id)
  assert.equal(found!.text, textOf(catalog))
  assert.equal(catalogMessage([plain]), undefined)
})

test('catalogHistory reads visibility from the surface (new and legacy sources)', () => {
  const published = renderCatalogMessage(entries, 'demo')
  const event = { type: 'user/message', seq: 42, data: { ...published } }
  const agent = { session: { events: [event], surface: { nodes: new Set([42]) } } } as unknown as Agent
  const history = catalogHistory(agent)
  assert.equal(history.published, true)
  assert.equal(history.visibleText, textOf(published))
  // Published but compacted off the surface -> published, no visible text.
  const compacted = { session: { events: [event], surface: { nodes: new Set([]) } } } as unknown as Agent
  const compactedHistory = catalogHistory(compacted)
  assert.equal(compactedHistory.published, true)
  assert.equal(compactedHistory.visibleText, undefined)
  // A session written before 0.2.3 still carries the private kind.
  const legacyEvent = {
    type: 'user/message', seq: 43,
    data: { ...published, source: { kind: 'memory-catalog', form: 'catalog', entries } },
  }
  const legacy = { session: { events: [legacyEvent], surface: { nodes: new Set([43]) } } } as unknown as Agent
  assert.equal(catalogHistory(legacy).visibleText, textOf(published))
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
  assert.equal(catalog!.message.source.kind, 'plugin')
  assert.match(catalog!.text, /memory index for the demo project/)
})

test('applyCatalogDecision republishes as an update when the published text changed', () => {
  const base = decision([])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleText: 'an older catalog' },
    existing: undefined,
    entries,
    peer: 'demo',
  })
  const catalog = catalogMessage(result.messages)
  assert.ok(catalog)
  assert.match(catalog!.text, /replaces every earlier memory catalog/)
})

test('applyCatalogDecision skips when the visible catalog is already current', () => {
  const base = decision([])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleText: textOf(renderCatalogUpdate(entries, 'demo')) },
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
  const oldCatalog = renderCatalogMessage(changedEntries(), 'demo')
  const base = decision([oldCatalog])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleText: 'a stale catalog' },
    existing: { message: oldCatalog, text: textOf(oldCatalog) },
    entries,
    peer: 'demo',
  })
  assert.equal(result.kind, 'enter')
  const replacement = catalogMessage(result.messages)
  assert.ok(replacement)
  assert.notEqual(replacement!.message.id, oldCatalog.id)
  assert.match(replacement!.text, /use pnpm/)
})

test('renderCatalogMessage advertises shared mounts', () => {
  const message = renderCatalogMessage(entries, 'demo', [...mounts])
  const text = textOf(message)
  assert.match(text, /## shared/)
  assert.match(text, /shared\/dsh-test\//)
  assert.match(text, /read-only mirror of peer 'dsh-test-72572e8b'/)
})

test('applyCatalogDecision publishes a shared-only catalog for an empty index', () => {
  const base = decision([])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: false },
    existing: undefined,
    entries: [],
    sharedMounts: [...mounts],
    peer: 'demo',
  })
  assert.equal(result.kind, 'enter')
  const catalog = catalogMessage(result.messages)
  assert.ok(catalog)
  assert.match(catalog!.text, /## shared/)
})

test('applyCatalogDecision does not republish a shared-only catalog once visible', () => {
  const base = decision([])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleText: textOf(renderCatalogMessage([], 'demo', [...mounts])) },
    existing: undefined,
    entries: [],
    sharedMounts: [...mounts],
    peer: 'demo',
  })
  assert.equal(result, base)
})

test('applyCatalogDecision drops an in-batch catalog when the visible one matches', () => {
  const catalog = renderCatalogMessage(entries, 'demo')
  const base = decision([createUserMessage({ content: [{ type: 'text', text: 'hi' }] }), catalog])
  const result = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleText: textOf(catalog) },
    existing: { message: catalog, text: textOf(catalog) },
    entries,
    peer: 'demo',
  })
  assert.equal(result.kind, 'enter')
  assert.equal(catalogMessage(result.messages), undefined)
})

test('capCatalogEntries keeps everything under budget and drops oldest over it', () => {
  const small = [{ category: 'preferences', path: 'preferences/a.md', summary: 'short' }]
  assert.deepEqual(capCatalogEntries(small, 1200), small)
  const many = [
    { category: 'events', path: 'events/1.md', summary: 'x'.repeat(200) },
    { category: 'events', path: 'events/2.md', summary: 'x'.repeat(200) },
    { category: 'events', path: 'events/3.md', summary: 'x'.repeat(200) },
    { category: 'events', path: 'events/4.md', summary: 'x'.repeat(200) },
  ]
  assert.equal(capCatalogEntries(many, 1200).length, 4)
  const capped = capCatalogEntries(many, 350)
  assert.ok(capped.length < 4)
  assert.equal(capped[0]!.path, 'events/1.md')
  assert.equal(many.length, 4)
})

test('capCatalogEntries returns empty for a non-positive budget', () => {
  const one = [{ category: 'a', path: 'a/x.md', summary: 's' }]
  assert.deepEqual(capCatalogEntries(one, 100), [])
  assert.deepEqual(capCatalogEntries([], 1200), [])
})
