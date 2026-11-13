/**
 * Phase 1 (store hygiene) and Phase 2 (reconcile) behaviour: list-marker
 * normalisation, History cap + sidecar archive, stable index summaries,
 * line-targeted patches, and applyDecision with a reconcile hook.
 * @module dsh-memory-lite/tests/memory-hygiene
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, parseMemoryFile } from '../src/memory-store.js'
import { applyPatch, bulletLines, lineKey, numberedView, PatchError } from '../src/patch.js'
import { parseDecision, parseReconcile } from '../src/extract/decision.js'
import { buildReconcileUser, extractionSystem, reconcileSystem } from '../src/extract/prompt.js'
import { applyDecision, applyDecisionDetailed, type ReconcileAnswer } from '../src/extract/index.js'
import { resolveConfig } from '../src/config.js'

const PEER = 'test-peer'

async function makeStore(history?: { maxEntries: number; entryMaxChars: number; archiveKeep: number }): Promise<{ store: MemoryStore; root: string; file: (rel: string) => Promise<string> }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-hygiene-'))
  const store = new MemoryStore(root, { enabled: false, mounts: [] }, history)
  return { store, root, file: rel => readFile(join(root, 'peers', PEER, 'memories', rel), 'utf8') }
}

// ---- bulletLines / lineKey -------------------------------------------------

test('bulletLines wraps plain lines but keeps list items, headings and indentation', () => {
  assert.deepEqual(bulletLines('plain\n- already\n  - nested\n### H\n1. one\n| a | b |\n\n'), [
    '- plain', '- already', '  - nested', '### H', '1. one', '| a | b |',
  ])
})

test('lineKey ignores list markers and whitespace', () => {
  assert.equal(lineKey('- - foo bar '), 'foo bar')
  assert.equal(lineKey('  * foo bar'), 'foo bar')
  assert.equal(lineKey('2) foo bar'), 'foo bar')
  assert.equal(lineKey('   '), '')
})

test('appendCurrent never nests markers and skips lines that exist under another marker', async () => {
  const { store, file, root } = await makeStore()
  try {
    await store.writeNewMemory(PEER, 'entities/x.md', 'X', '- alpha\n- beta')
    await store.appendCurrent(PEER, 'entities/x.md', '- beta\nalpha\n- gamma\n  - detail')
    const text = await file('entities/x.md')
    assert.ok(!text.includes('- - '), text)
    assert.equal(text.split('\n').filter(l => l === '- beta').length, 1)
    assert.equal(text.split('\n').filter(l => l === '- alpha').length, 1)
    assert.match(text, /\n- gamma\n {2}- detail/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- History cap + archive -------------------------------------------------

test('updateCurrent keeps only the newest History lines, truncated, and archives the full previous file', async () => {
  const { store, file, root } = await makeStore({ maxEntries: 3, entryMaxChars: 40, archiveKeep: 5 })
  try {
    await store.writeNewMemory(PEER, 'entities/h.md', 'H', 'v0')
    for (let i = 1; i <= 5; i += 1) {
      await store.updateCurrent(PEER, 'entities/h.md', `version ${i} ${'x'.repeat(100)}\nsecond line of v${i}`)
    }
    const parsed = parseMemoryFile(await file('entities/h.md'))
    const history = parsed.history.split('\n')
    assert.equal(history.length, 3)
    assert.ok(history.every(line => line.length <= 40), history.join('|'))
    assert.ok(history.every(line => line.startsWith('- ')))
    // The newest entry describes version 4 (the content replaced by the last update).
    assert.match(history[2]!, /version 4/)
    // Full previous files live outside memories/.
    const dir = join(root, 'peers', PEER, '.history', 'entities', 'h.md')
    const snapshots = (await readdir(dir)).sort()
    assert.equal(snapshots.length, 5)
    const last = await readFile(join(dir, snapshots[snapshots.length - 1]!), 'utf8')
    assert.match(last, /second line of v4/)
    // And never inside the searchable memories tree.
    assert.deepEqual(await store.search(PEER, 'second line of v1'), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('archiveKeep prunes old snapshots and archiveKeep 0 disables archiving', async () => {
  const a = await makeStore({ maxEntries: 5, entryMaxChars: 240, archiveKeep: 2 })
  const b = await makeStore({ maxEntries: 5, entryMaxChars: 240, archiveKeep: 0 })
  try {
    for (const { store } of [a, b]) {
      await store.writeNewMemory(PEER, 'entities/p.md', 'P', 'v0')
      for (let i = 1; i <= 4; i += 1) await store.updateCurrent(PEER, 'entities/p.md', `v${i}`)
    }
    assert.equal((await readdir(join(a.root, 'peers', PEER, '.history', 'entities', 'p.md'))).length, 2)
    await assert.rejects(readdir(join(b.root, 'peers', PEER, '.history')))
  } finally {
    await rm(a.root, { recursive: true, force: true })
    await rm(b.root, { recursive: true, force: true })
  }
})

test('a legacy bloated History is trimmed on the next update without losing the file (snapshot keeps it)', async () => {
  const { store, root, file } = await makeStore()
  try {
    const legacy = ['# L', '', '## Current', '- now', '', '## History',
      ...Array.from({ length: 8 }, (_, i) => `- 2026-10-0${i + 1}: entry ${i}\n  - continuation a\n  - continuation b`), ''].join('\n')
    await mkdir(join(root, 'peers', PEER, 'memories', 'entities'), { recursive: true })
    await writeFile(join(root, 'peers', PEER, 'memories', 'entities', 'l.md'), legacy)
    await store.updateCurrent(PEER, 'entities/l.md', 'next')
    const history = parseMemoryFile(await file('entities/l.md')).history.split('\n')
    assert.equal(history.length, 5)
    assert.ok(history.every(line => !line.startsWith(' ')))
    const snap = (await readdir(join(root, 'peers', PEER, '.history', 'entities', 'l.md')))[0]!
    assert.match(await readFile(join(root, 'peers', PEER, '.history', 'entities', 'l.md', snap), 'utf8'), /continuation b/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- index summaries -------------------------------------------------------

test('ensureIndexEntry keeps an existing summary and adds a missing one', async () => {
  const { store, root } = await makeStore()
  try {
    await store.refreshIndexEntry(PEER, 'entities/a.md', 'describes A')
    await store.ensureIndexEntry(PEER, 'entities/a.md', 'a fragment of new fact')
    await store.ensureIndexEntry(PEER, 'entities/b.md', 'fallback B')
    const entries = await store.readIndex(PEER)
    assert.equal(entries.find(e => e.path === 'entities/a.md')!.summary, 'describes A')
    assert.equal(entries.find(e => e.path === 'entities/b.md')!.summary, 'fallback B')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- patch.ts --------------------------------------------------------------

const LINES = ['- one', '- two', '', '- three', '- four']

test('applyPatch replace/delete/insert/append with original numbering', () => {
  const result = applyPatch(LINES, [
    { op: 'replace', line: 2, content: 'TWO' },
    { op: 'delete', line: 4 },
    { op: 'insert', after: 1, content: 'one-and-a-half' },
    { op: 'insert', after: 0, content: 'top' },
    { op: 'append', content: 'tail' },
  ])
  assert.deepEqual(result.lines, ['- top', '- one', '- one-and-a-half', '- TWO', '', '- four', '- tail'])
  assert.equal(result.replaced, 1)
  assert.equal(result.deleted, 1)
  assert.equal(result.added, 3)
})

test('applyPatch keeps nesting when replacing a nested bullet with plain text', () => {
  const result = applyPatch(['- parent', '  - child old'], [{ op: 'replace', line: 2, content: 'child new' }])
  assert.deepEqual(result.lines, ['- parent', '  - child new'])
})

test('applyPatch skips appended lines that already exist under another marker', () => {
  const result = applyPatch(['- keep me'], [{ op: 'append', content: 'keep me\nbrand new' }])
  assert.deepEqual(result.lines, ['- keep me', '- brand new'])
  assert.equal(result.added, 1)
})

test('applyPatch rejects bad references, double edits, empty content and mass deletion', () => {
  assert.throws(() => applyPatch(LINES, [{ op: 'replace', line: 9, content: 'x' }]), PatchError)
  assert.throws(() => applyPatch(LINES, [{ op: 'delete', line: 0 }]), PatchError)
  assert.throws(() => applyPatch(LINES, [{ op: 'insert', after: 6, content: 'x' }]), PatchError)
  assert.throws(() => applyPatch(LINES, [{ op: 'replace', line: 1, content: 'a' }, { op: 'delete', line: 1 }]), PatchError)
  assert.throws(() => applyPatch(LINES, [{ op: 'append', content: '   ' }]), PatchError)
  const ten = Array.from({ length: 10 }, (_, i) => `- l${i}`)
  assert.throws(() => applyPatch(ten, [1, 2, 3, 4, 5, 6].map(line => ({ op: 'delete', line }) as const)), /refusing/)
  assert.throws(() => applyPatch(['- a'], Array.from({ length: 21 }, () => ({ op: 'append', content: 'x' }) as const)), /max/)
})

test('applyPatch rejects a replace that throws away most of a long line but allows short edits', () => {
  const long = '- ' + 'fact '.repeat(60)
  assert.throws(() => applyPatch([long], [{ op: 'replace', line: 1, content: 'only the headline' }]), /shrinks/)
  const ok = applyPatch([long], [{ op: 'replace', line: 1, content: long.replace('fact', 'FACT') }])
  assert.equal(ok.replaced, 1)
  assert.equal(applyPatch(['- short'], [{ op: 'replace', line: 1, content: 'x' }]).replaced, 1)
})

test('numberedView numbers non-blank lines, shortens long lines, and gives up when still too big', () => {
  const full = numberedView('- a\n\n- b', 1000)!
  assert.equal(full.text, '1| - a\n3| - b')
  assert.equal(full.truncated, false)
  const long = '- ' + 'y'.repeat(500)
  const shortened = numberedView(`${long}\n${long}`, 500)!
  assert.equal(shortened.truncated, true)
  assert.ok(shortened.text.includes('…'))
  assert.equal(numberedView(Array.from({ length: 200 }, () => long).join('\n'), 500), undefined)
})

test('store.patchCurrent applies a patch, archives, notes History, and leaves the file alone on rejection', async () => {
  const { store, root, file } = await makeStore()
  try {
    await store.writeNewMemory(PEER, 'entities/p.md', 'P', 'alpha\nbeta\ngamma')
    const result = await store.patchCurrent(PEER, 'entities/p.md', [
      { op: 'replace', line: 2, content: 'beta v2' },
      { op: 'append', content: 'delta' },
    ])
    assert.deepEqual(result, { changed: true, replaced: 1, deleted: 0, added: 1 })
    const parsed = parseMemoryFile(await file('entities/p.md'))
    assert.equal(parsed.current, '- alpha\n- beta v2\n- gamma\n- delta')
    assert.match(parsed.history, /patch（替换 1 \/ 删除 0 \/ 新增 1 行）/)
    const before = await file('entities/p.md')
    await assert.rejects(store.patchCurrent(PEER, 'entities/p.md', [{ op: 'delete', line: 99 }]), PatchError)
    assert.equal(await file('entities/p.md'), before)
    const noop = await store.patchCurrent(PEER, 'entities/p.md', [{ op: 'append', content: 'delta' }])
    assert.equal(noop.changed, false)
    assert.equal((await readdir(join(root, 'peers', PEER, '.history', 'entities', 'p.md'))).length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---- decision parsing + prompts -------------------------------------------

test('parseDecision carries an optional one-line summary on create and update', () => {
  const create = parseDecision('{"decision":"create","category":"entities","title":"T","summary":"  whole\\nfile  topic ","content":"c"}')
  assert.equal(create.kind === 'create' && create.summary, 'whole file topic')
  const update = parseDecision('{"decision":"update","path":"entities/t.md","content":"c","summary":"s"}')
  assert.equal(update.kind === 'update' && update.summary, 's')
  const none = parseDecision('{"decision":"merge","path":"entities/t.md","content":"c"}')
  assert.equal('summary' in none, false)
  const long = parseDecision(`{"decision":"create","category":"entities","title":"T","summary":"${'z'.repeat(300)}","content":"c"}`)
  assert.ok(long.kind === 'create' && long.summary!.length <= 160)
})

test('parseReconcile accepts noop and every patch op, and rejects malformed answers', () => {
  assert.deepEqual(parseReconcile('{"decision":"noop","reason":"covered"}'), { kind: 'noop', reason: 'covered' })
  const patch = parseReconcile('```json\n{"decision":"patch","summary":"s","ops":[{"op":"replace","line":3,"content":"a"},{"op":"delete","line":4},{"op":"insert","after":0,"content":"b"},{"op":"append","content":"c"}]}\n```')
  assert.equal(patch.kind, 'patch')
  assert.equal(patch.kind === 'patch' && patch.ops.length, 4)
  assert.throws(() => parseReconcile('{"decision":"merge"}'), /noop or patch/)
  assert.throws(() => parseReconcile('{"decision":"patch","ops":[]}'), /non-empty/)
  assert.throws(() => parseReconcile('{"decision":"patch","ops":[{"op":"replace","line":"3","content":"a"}]}'), /integer/)
  assert.throws(() => parseReconcile('{"decision":"patch","ops":[{"op":"explode"}]}'), /unknown op/)
  assert.throws(() => parseReconcile('{"decision":"patch","ops":[{"op":"append","content":" "}]}'), /non-empty/)
})

test('extraction prompt asks for a summary and plain lines; reconcile prompts are strict', () => {
  const system = extractionSystem()
  assert.ok(system.includes('"summary"'))
  assert.ok(system.includes('CONTENT FORMAT'))
  assert.ok(system.includes('Do NOT prefix lines'))
  const reconcile = reconcileSystem()
  for (const word of ['noop', 'replace', 'delete', 'insert', 'append', 'STRICT OUTPUT RULES', 'half-width']) assert.ok(reconcile.includes(word), word)
  const user = buildReconcileUser('My file', '1| - a', true, 'update', 'new fact')
  assert.ok(user.includes('My file'))
  assert.ok(user.includes('1| - a'))
  assert.ok(user.includes('OUTDATED'))
  assert.ok(user.includes('shortened'))
  assert.ok(buildReconcileUser('t', '1| x', false, 'merge', 'p').includes('proposes adding'))
})

test('config defaults and validation for history and reconcile', () => {
  const config = resolveConfig({})
  assert.deepEqual(config.history, { maxEntries: 5, entryMaxChars: 240, archiveKeep: 5 })
  assert.equal(config.extraction.reconcile, true)
  assert.equal(config.extraction.reconcileMaxBytes, 24576)
  assert.throws(() => resolveConfig({ history: { maxEntries: -1 } }), /history\.maxEntries/)
  assert.throws(() => resolveConfig({ history: { entryMaxChars: 5 } }), /entryMaxChars/)
  assert.throws(() => resolveConfig({ extraction: { reconcileMaxBytes: 1.5 } }), /reconcileMaxBytes/)
})

// ---- applyDecision with reconcile hook -------------------------------------

async function seeded(): Promise<{ store: MemoryStore; root: string; file: (rel: string) => Promise<string> }> {
  const ctx = await makeStore()
  await ctx.store.writeNewMemory(PEER, 'entities/cpa.md', 'CPA', 'port 8317\nGoogle pool = 1')
  await ctx.store.refreshIndexEntry(PEER, 'entities/cpa.md', 'CPA reverse proxy handbook')
  return ctx
}

test('merge: reconcile patch replaces the contradicted line and keeps the index summary', async () => {
  const { store, root, file } = await seeded()
  try {
    let seen: { current: string; kind: string } | undefined
    const answer: ReconcileAnswer = { kind: 'patch', ops: [{ op: 'replace', line: 2, content: 'Google pool = 0 (2026-11-12)' }] }
    const applied = await applyDecisionDetailed(store, PEER, { kind: 'merge', path: 'entities/cpa.md', content: 'Google pool is now 0' }, {
      reconcile: async request => { seen = { current: request.current, kind: request.kind }; return answer },
    })
    assert.equal(applied.applied, 'patch')
    assert.deepEqual(seen, { current: '- port 8317\n- Google pool = 1', kind: 'merge' })
    const parsed = parseMemoryFile(await file('entities/cpa.md'))
    assert.equal(parsed.current, '- port 8317\n- Google pool = 0 (2026-11-12)')
    assert.equal((await store.readIndex(PEER))[0]!.summary, 'CPA reverse proxy handbook')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('merge: reconcile noop writes nothing', async () => {
  const { store, root, file } = await seeded()
  try {
    const before = await file('entities/cpa.md')
    const applied = await applyDecisionDetailed(store, PEER, { kind: 'merge', path: 'entities/cpa.md', content: 'port 8317' }, {
      reconcile: async () => ({ kind: 'noop', reason: 'covered' }),
    })
    assert.equal(applied.applied, 'noop')
    assert.equal(await file('entities/cpa.md'), before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('merge: a failed reconcile falls back to append; a rejected patch does too', async () => {
  const { store, root, file } = await seeded()
  try {
    const failed = await applyDecisionDetailed(store, PEER, { kind: 'merge', path: 'entities/cpa.md', content: 'fact A' }, {
      reconcile: async () => ({ kind: 'fallback', reason: 'llm-error: boom' }),
    })
    assert.equal(failed.applied, 'merge')
    assert.equal(failed.fallback, 'llm-error: boom')
    const rejected = await applyDecisionDetailed(store, PEER, { kind: 'merge', path: 'entities/cpa.md', content: 'fact B' }, {
      reconcile: async () => ({ kind: 'patch', ops: [{ op: 'delete', line: 77 }] }),
    })
    assert.match(rejected.fallback ?? '', /patch-rejected/)
    const text = await file('entities/cpa.md')
    assert.match(text, /- fact A/)
    assert.match(text, /- fact B/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('update: with reconcile active an unreconcilable update appends instead of replacing blindly', async () => {
  const { store, root, file } = await seeded()
  try {
    const applied = await applyDecisionDetailed(store, PEER, { kind: 'update', path: 'entities/cpa.md', content: 'totally new text' }, {
      reconcile: async () => ({ kind: 'fallback', reason: 'current-too-large' }),
    })
    assert.equal(applied.fallback, 'current-too-large')
    const text = await file('entities/cpa.md')
    assert.match(text, /- port 8317/)
    assert.match(text, /- totally new text/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('update without a reconcile hook still replaces Current (archived) and honours an explicit summary', async () => {
  const { store, root, file } = await seeded()
  try {
    await applyDecision(store, PEER, { kind: 'update', path: 'entities/cpa.md', content: 'rewritten', summary: 'new scope' })
    const parsed = parseMemoryFile(await file('entities/cpa.md'))
    assert.equal(parsed.current, '- rewritten')
    assert.match(parsed.history, /port 8317/)
    assert.equal((await store.readIndex(PEER))[0]!.summary, 'new scope')
    await applyDecision(store, PEER, { kind: 'update', path: 'entities/cpa.md', content: 'again' })
    assert.equal((await store.readIndex(PEER))[0]!.summary, 'new scope')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('create sets the model-written summary; a later merge never overwrites it', async () => {
  const { store, root } = await makeStore()
  try {
    await applyDecision(store, PEER, { kind: 'create', category: 'entities', title: 'Thing', content: 'first fact', summary: 'About the Thing system' })
    await applyDecision(store, PEER, { kind: 'merge', path: 'entities/thing.md', content: 'second fact that must not become the summary' })
    await applyDecision(store, PEER, { kind: 'create', category: 'entities', title: 'Thing', content: 'third fact', summary: 'ignored for existing file' })
    assert.equal((await store.readIndex(PEER))[0]!.summary, 'About the Thing system')
    // Without a model summary a new file falls back to its first content.
    await applyDecision(store, PEER, { kind: 'create', category: 'entities', title: 'Other', content: 'only fact' })
    assert.equal((await store.readIndex(PEER)).find(e => e.path === 'entities/other.md')!.summary, 'only fact')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
