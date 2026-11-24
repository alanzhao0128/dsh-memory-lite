/**
 * Catalog-summary primitives: the verdict parser, the stale marker, and the
 * store methods that settle an index summary after a body change.
 * @module dsh-memory-lite/tests/summary
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory-store.js'
import { isStale, parseSummaryField, STALE_MARK, stripStale } from '../src/summary.js'
import { parseSummaryAnswer } from '../src/extract/decision.js'

async function makeStore(): Promise<{ store: MemoryStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-summary-'))
  return { store: new MemoryStore(root), root }
}

// ---- parseSummaryField / stale helpers ------------------------------------

test('parseSummaryField maps keep (any case) and "=" to a keep verdict', () => {
  for (const value of ['keep', 'KEEP', '  Keep  ', '=', ' = ']) {
    assert.deepEqual(parseSummaryField(value), { kind: 'keep' }, value)
  }
})

test('parseSummaryField flattens whitespace and newlines into one line', () => {
  assert.deepEqual(parseSummaryField('  CPA\n  handbook \t v2 '), { kind: 'set', text: 'CPA handbook v2' })
})

test('parseSummaryField cuts text longer than 160 chars to 159 plus an ellipsis', () => {
  const verdict = parseSummaryField('x'.repeat(300))
  assert.ok(verdict?.kind === 'set')
  assert.equal(verdict.text.length, 160)
  assert.ok(verdict.text.endsWith('…'))
  assert.equal((parseSummaryField('y'.repeat(160)) as { text: string }).text.length, 160)
})

test('parseSummaryField strips a trailing stale marker and returns undefined for empty input', () => {
  assert.deepEqual(parseSummaryField(`handbook${STALE_MARK}`), { kind: 'set', text: 'handbook' })
  assert.equal(parseSummaryField(STALE_MARK), undefined)
  for (const value of ['', '   ', '\n', undefined, null, 7, {}, []]) assert.equal(parseSummaryField(value), undefined)
})

test('stripStale / isStale only look at the trailing marker', () => {
  assert.equal(STALE_MARK, ' ⚠stale')
  assert.equal(stripStale('a b ⚠stale'), 'a b')
  assert.equal(stripStale('a b'), 'a b')
  assert.equal(isStale('a b ⚠stale'), true)
  assert.equal(isStale('⚠stale in the middle'), false)
})

test('parseSummaryAnswer reads {"summary":...} and rejects answers without one', () => {
  assert.deepEqual(parseSummaryAnswer('{"summary":"keep"}'), { kind: 'keep' })
  assert.deepEqual(parseSummaryAnswer('```json\n{"summary":"new line"}\n```'), { kind: 'set', text: 'new line' })
  assert.throws(() => parseSummaryAnswer('{"decision":"create"}'), /no usable/)
  assert.throws(() => parseSummaryAnswer('{"summary":"  "}'), /no usable/)
  assert.throws(() => parseSummaryAnswer('prose only'))
})

// ---- store.applySummaryVerdict ---------------------------------------------

test('applySummaryVerdict set overwrites the summary and reports before/after', async () => {
  const { store, root } = await makeStore()
  try {
    await store.refreshIndexEntry('infra/a.md', 'old')
    const result = await store.applySummaryVerdict('infra/a.md', { kind: 'set', text: 'new' }, 'fallback')
    assert.deepEqual(result, { before: 'old', after: 'new', action: 'changed' })
    assert.equal((await store.readIndexEntry('infra/a.md'))!.summary, 'new')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applySummaryVerdict set equal to the old summary counts as keep and clears a stale flag', async () => {
  const { store, root } = await makeStore()
  try {
    await store.refreshIndexEntry('infra/a.md', `same${STALE_MARK}`)
    const result = await store.applySummaryVerdict('infra/a.md', { kind: 'set', text: 'same' }, 'fallback')
    assert.deepEqual(result, { before: `same${STALE_MARK}`, after: 'same', action: 'kept' })
    assert.equal((await store.readIndexEntry('infra/a.md'))!.summary, 'same')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('applySummaryVerdict keep retains the summary, strips stale, and writes the fallback when there is no entry', async () => {
  const { store, root } = await makeStore()
  try {
    await store.refreshIndexEntry('infra/a.md', `kept one${STALE_MARK}`)
    assert.deepEqual(await store.applySummaryVerdict('infra/a.md', { kind: 'keep' }, 'fallback'), {
      before: `kept one${STALE_MARK}`, after: 'kept one', action: 'kept',
    })
    assert.equal((await store.readIndexEntry('infra/a.md'))!.summary, 'kept one')
    const fresh = await store.applySummaryVerdict('infra/b.md', { kind: 'keep' }, 'fallback text')
    assert.deepEqual(fresh, { after: 'fallback text', action: 'changed' })
    assert.equal('before' in fresh, false)
    assert.equal((await store.readIndexEntry('infra/b.md'))!.summary, 'fallback text')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- store.markIndexStale / readIndexEntry ---------------------------------

test('markIndexStale appends the marker once and gives a missing entry fallback plus marker', async () => {
  const { store, root } = await makeStore()
  try {
    await store.refreshIndexEntry('infra/a.md', 'summary A')
    await store.markIndexStale('infra/a.md', 'fallback')
    await store.markIndexStale('infra/a.md', 'fallback')
    assert.equal((await store.readIndexEntry('infra/a.md'))!.summary, `summary A${STALE_MARK}`)
    await store.markIndexStale('infra/new.md', 'fallback')
    assert.equal((await store.readIndexEntry('infra/new.md'))!.summary, `fallback${STALE_MARK}`)
    // The marker survives the on-disk round trip through parseIndex.
    const raw = await readFile(join(root, 'memories', '_index.md'), 'utf8')
    assert.match(raw, /- infra\/a\.md: summary A ⚠stale/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readIndexEntry returns undefined for unknown paths and hides private entries from restricted trust', async () => {
  const { store, root } = await makeStore()
  try {
    await store.refreshIndexEntry('private/health/x.md', 'secret')
    assert.equal(await store.readIndexEntry('infra/none.md'), undefined)
    assert.equal((await store.readIndexEntry('private/health/x.md'))!.summary, 'secret')
    assert.equal(await store.readIndexEntry('private/health/x.md', { restricted: true, reason: 'hidePrivate' }), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent verdicts serialize through the mutation queue without losing entries', async () => {
  const { store, root } = await makeStore()
  try {
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.applySummaryVerdict(`infra/f${i}.md`, { kind: 'set', text: `s${i}` }, 'fb')))
    const entries = await store.readIndex()
    assert.equal(entries.length, 8)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
