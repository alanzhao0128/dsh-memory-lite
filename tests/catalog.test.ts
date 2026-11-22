import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { IndexEntry } from '../src/types.js'
import {
  MEMORY_CATALOG_PLUGIN, isCurrentCatalogText, isMemoryCatalogSource,
  renderCatalogMessage, renderCatalogUpdate, catalogMessage, catalogHistory,
} from '../src/catalog.js'
import { applyCatalogDecision, planCatalogLayout } from '../src/inject.js'

const entries: readonly IndexEntry[] = [
  { topic: 'preferences', path: 'preferences/coding.md', summary: 'use pnpm' },
  { topic: 'infra', path: 'infra/cpa.md', summary: 'CPA v8.0.80' },
]

const textOf = (message: UserMessage): string =>
  message.content.map(block => (block.type === 'text' ? block.text : '')).join('')

const changedEntries = (): readonly IndexEntry[] => {
  const changed = [...entries]
  changed[0] = { ...changed[0]!, summary: 'use bun' }
  return changed
}

test('the catalog source uses the producer-owned plugin:dsh-memory-lite kind with catalog form', () => {
  const message = renderCatalogMessage({ entries })
  assert.deepEqual(message.source, { kind: 'plugin:dsh-memory-lite', form: 'catalog' })
  assert.equal(isMemoryCatalogSource(message.source), true)
  assert.equal(isMemoryCatalogSource({ kind: 'memory-catalog', form: 'catalog', entries }), true)
  assert.equal(isMemoryCatalogSource({ kind: 'plugin', plugin: MEMORY_CATALOG_PLUGIN, form: 'catalog' }), true)
  assert.equal(isMemoryCatalogSource({ kind: 'plugin:dsh-memory-lite', form: 'catalog' }), true)
  assert.equal(isMemoryCatalogSource({ kind: 'user' }), false)
  assert.equal(isMemoryCatalogSource({ kind: 'plugin', plugin: 'other', form: 'catalog' }), false)
  assert.equal(isMemoryCatalogSource({ kind: 'plugin:other', form: 'catalog' }), false)
  assert.equal(isMemoryCatalogSource({ kind: 'plugin:dsh-memory-lite', form: 'instructions' }), false)
  assert.equal(isMemoryCatalogSource(undefined), false)
})

test('renderCatalogMessage carries topic sections, collapsed topics, charter, and restricted mode', () => {
  const message = renderCatalogMessage({
    entries,
    collapsedTopics: [{ topic: 'private/health', count: 2, previewTitles: ['zhao', 'chen'] }],
    globalCharter: '# Charter',
    restricted: false,
  })
  const text = textOf(message)
  assert.match(text, /Global Agent Charter/)
  assert.match(text, /## preferences \(always relevant\)/)
  assert.match(text, /preferences\/coding\.md: use pnpm/)
  assert.match(text, /## infra/)
  assert.match(text, /## Collapsed Topics/)
  assert.match(text, /- private\/health \(2\): zhao, chen/)
  assert.match(text, /call remember only when the user explicitly asks/i)
  assert.match(text, /<system-reminder>/)

  const restrictedText = textOf(renderCatalogMessage({ entries, restricted: true }))
  assert.match(restrictedText, /restricted mode: private memories are hidden/)
})

test('renderCatalogUpdate marks the replacement framing', () => {
  const update = renderCatalogUpdate({ entries })
  assert.match(textOf(update), /replaces every earlier memory catalog/)
  assert.equal(update.source.kind, 'plugin:dsh-memory-lite')
})

test('isCurrentCatalogText matches either framing and detects real change', () => {
  const first = textOf(renderCatalogMessage({ entries }))
  const update = textOf(renderCatalogUpdate({ entries }))
  assert.equal(isCurrentCatalogText(first, { entries }), true)
  assert.equal(isCurrentCatalogText(update, { entries }), true)
  assert.equal(isCurrentCatalogText(first, { entries: changedEntries() }), false)
  assert.equal(isCurrentCatalogText(first, { entries, restricted: true }), false)
})

test('catalogMessage and catalogHistory track visibility on surface', () => {
  const catalog = renderCatalogMessage({ entries })
  const plain = createUserMessage({ content: [{ type: 'text', text: 'hi' }] })
  const found = catalogMessage([plain, catalog])
  assert.ok(found)
  assert.equal(found!.message.id, catalog.id)

  const event = { type: 'user/message', seq: 42, data: { ...catalog } }
  const agent = { session: { events: [event], surface: { nodes: new Set([42]) } } } as unknown as Agent
  assert.equal(catalogHistory(agent).visibleText, textOf(catalog))
  const compacted = { session: { events: [event], surface: { nodes: new Set([]) } } } as unknown as Agent
  assert.deepEqual(catalogHistory(compacted), { published: true })
})

function decision(messages: UserMessage[]): PreStepDecision {
  return { kind: 'enter', messages }
}

test('applyCatalogDecision handles publish, skip, update, empty vault, and charter-only', () => {
  const base = decision([createUserMessage({ content: [{ type: 'text', text: 'hi' }] })])
  const published = applyCatalogDecision({ decision: base, history: { published: false }, existing: undefined, entries })
  assert.equal(published.kind, 'enter')
  const cat = catalogMessage(published.messages)
  assert.ok(cat)

  // Already visible and unchanged -> no re-publish.
  const skipped = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleText: cat!.text },
    existing: undefined,
    entries,
  })
  assert.equal(skipped.messages.length, 1)

  // Trust flip -> republishes immediately.
  const flipped = applyCatalogDecision({
    decision: base,
    history: { published: true, visibleText: cat!.text },
    existing: undefined,
    entries,
    restricted: true,
  })
  assert.equal(flipped.messages.length, 2)
  assert.match(catalogMessage(flipped.messages)!.text, /restricted mode/)

  // Fresh empty vault -> publishes nothing.
  const empty = applyCatalogDecision({ decision: base, history: { published: false }, existing: undefined, entries: [] })
  assert.equal(empty.messages.length, 1)

  // Charter only -> still publishes.
  const charterOnly = applyCatalogDecision({
    decision: base,
    history: { published: false },
    existing: undefined,
    entries: [],
    globalCharter: '# Charter',
  })
  assert.equal(charterOnly.messages.length, 2)
})

test('planCatalogLayout expands everything under budget and switches to adaptive map over budget', () => {
  // Small vault fits completely -> zero collapsed topics.
  const full = planCatalogLayout(entries, 3500)
  assert.equal(full.expanded.length, 2)
  assert.equal(full.collapsed.length, 0)

  // Large vault exceeding budget -> preferences + hot topic expanded, cold topics collapsed.
  const big: IndexEntry[] = [
    { topic: 'preferences', path: 'preferences/rule.md', summary: 'always keep concise' },
    ...Array.from({ length: 8 }, (_, i) => ({
      topic: 'infra',
      path: `infra/item-${i}.md`,
      summary: 'A detailed infrastructure note describing servers, proxies, and deployments number ' + i,
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      topic: 'g7',
      path: `g7/proj-${i}.md`,
      summary: 'G7 enterprise project specification and protocol documentation item number ' + i,
    })),
    ...Array.from({ length: 8 }, (_, i) => ({
      topic: 'private/insurance',
      path: `private/insurance/policy-${i}.md`,
      summary: 'Family insurance policy coverage details and contract clauses number ' + i,
    })),
  ]
  // Hot topic is private/insurance: should be prioritized over infra/g7!
  const adaptive = planCatalogLayout(big, 650, ['private/insurance'], 0.7)
  assert.ok(adaptive.expanded.some(e => e.topic === 'preferences'), 'preferences always expanded')
  assert.ok(adaptive.expanded.some(e => e.topic === 'private/insurance'), 'hot topic expanded first')
  assert.ok(adaptive.collapsed.length >= 1, 'remaining cold topics collapsed into 1-line map')
  assert.ok(adaptive.collapsed.some(c => c.topic === 'infra' || c.topic === 'g7'))
})
