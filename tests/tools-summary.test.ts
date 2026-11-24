/**
 * The write tools' summary contract: `update_memory` and `remember` require a
 * summary (a new line or "keep"), validate it BEFORE any write, report
 * before/after/action, and keep the privacy gates intact.
 * @module dsh-memory-lite/tests/tools-summary
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryStore, parseMemoryFile } from '../src/memory-store.js'
import { resolveConfig } from '../src/config.js'
import type { MemoryDeps } from '../src/tool-utils.js'
import { applyUpdateMemoryTool } from '../src/tools/update-memory.js'
import { applyRememberTool } from '../src/tools/remember.js'

interface Harness {
  readonly store: MemoryStore
  readonly root: string
  readonly update: (args: Record<string, unknown>) => Promise<any>
  readonly remember: (args: Record<string, unknown>) => Promise<any>
  readonly definitions: Map<string, any>
}

async function makeHarness(privacy: Record<string, unknown> = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tools-summary-'))
  const store = new MemoryStore(root)
  const config = resolveConfig({ root, privacy })
  const deps: MemoryDeps = { config: () => config, store }
  const definitions = new Map<string, any>()
  const ctx = { tools: { register: (definition: any) => { definitions.set(definition.name, definition) } } } as unknown as Context
  applyUpdateMemoryTool(ctx, deps)
  applyRememberTool(ctx, deps)
  const run = (name: string) => (args: Record<string, unknown>) => definitions.get(name).execute(args, {})
  return { store, root, update: run('update_memory'), remember: run('remember'), definitions }
}

const file = (h: Harness, rel: string): Promise<string> => readFile(join(h.root, 'memories', rel), 'utf8')

// ---- schema ----------------------------------------------------------------

test('update_memory and remember declare a required summary parameter', async () => {
  const h = await makeHarness()
  try {
    for (const name of ['update_memory', 'remember']) {
      const parameters = h.definitions.get(name).parameters
      assert.ok(parameters.required.includes('summary'), name)
      assert.equal(parameters.properties.summary.type, 'string', name)
    }
    assert.match(h.definitions.get('update_memory').parameters.properties.summary.description, /MUST write a new one/)
    assert.match(h.definitions.get('remember').parameters.properties.summary.description, /"keep"/)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

// ---- update_memory ---------------------------------------------------------

async function seeded(h: Harness): Promise<void> {
  await h.store.writeNewMemory('infra/cpa.md', 'CPA', 'Google pool = 1')
  await h.store.refreshIndexEntry('infra/cpa.md', 'CPA handbook, Google pool = 1')
}

test('update_memory without a summary throws before touching the body', async () => {
  const h = await makeHarness()
  try {
    await seeded(h)
    const before = await file(h, 'infra/cpa.md')
    // Absent: rejected by argument validation; blank: rejected by the tool's own pre-write check.
    await assert.rejects(h.update({ path: 'infra/cpa.md', content: 'Google pool = 0' }), /summary/)
    for (const summary of ['', '   ']) {
      await assert.rejects(h.update({ path: 'infra/cpa.md', content: 'Google pool = 0', summary }), /summary is required/)
    }
    assert.equal(await file(h, 'infra/cpa.md'), before)
    assert.equal((await h.store.readIndexEntry('infra/cpa.md'))!.summary, 'CPA handbook, Google pool = 1')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('update_memory keep retains the summary and reports kept', async () => {
  const h = await makeHarness()
  try {
    await seeded(h)
    const result = await h.update({ path: 'infra/cpa.md', content: 'Google pool = 1, port 8317', summary: 'keep' })
    assert.deepEqual(result.summary, { before: 'CPA handbook, Google pool = 1', after: 'CPA handbook, Google pool = 1', action: 'kept' })
    assert.equal(parseMemoryFile(await file(h, 'infra/cpa.md')).current, '- Google pool = 1, port 8317')
    const rendered = h.definitions.get('update_memory').output.render({}, result)[0].text as string
    assert.match(rendered, /Index summary: kept «CPA handbook, Google pool = 1»/)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('update_memory with a new summary replaces it and renders before → after', async () => {
  const h = await makeHarness()
  try {
    await seeded(h)
    const result = await h.update({ path: 'infra/cpa.md', content: 'Google pool = 0', summary: 'CPA handbook, Google pool exhausted' })
    assert.deepEqual(result.summary, { before: 'CPA handbook, Google pool = 1', after: 'CPA handbook, Google pool exhausted', action: 'changed' })
    assert.equal((await h.store.readIndexEntry('infra/cpa.md'))!.summary, 'CPA handbook, Google pool exhausted')
    const rendered = h.definitions.get('update_memory').output.render({}, result)[0].text as string
    assert.match(rendered, /Index summary: «CPA handbook, Google pool = 1» → «CPA handbook, Google pool exhausted»/)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('update_memory keep clears a stale flag; a file with no entry gets the content fallback', async () => {
  const h = await makeHarness()
  try {
    await seeded(h)
    await h.store.markIndexStale('infra/cpa.md', 'x')
    const cleared = await h.update({ path: 'infra/cpa.md', content: 'still one', summary: 'KEEP' })
    assert.equal(cleared.summary.after, 'CPA handbook, Google pool = 1')
    await h.store.writeNewMemory('infra/orphan.md', 'Orphan', 'a')
    const orphan = await h.update({ path: 'infra/orphan.md', content: 'b fact', summary: 'keep' })
    assert.deepEqual(orphan.summary, { after: 'b fact', action: 'changed' })
    const rendered = h.definitions.get('update_memory').output.render({}, orphan)[0].text as string
    assert.match(rendered, /Index summary: «\(none\)» → «b fact»/)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('update_memory is still blocked on private paths in restricted mode, summary or not', async () => {
  const h = await makeHarness({ hidePrivate: true })
  try {
    await h.store.writeNewMemory('private/health/x.md', 'X', 'secret')
    await h.store.refreshIndexEntry('private/health/x.md', 'secret summary')
    const before = await file(h, 'private/health/x.md')
    await assert.rejects(h.update({ path: 'private/health/x.md', content: 'leak', summary: 'new' }), /private namespace/)
    assert.equal(await file(h, 'private/health/x.md'), before)
    assert.equal((await h.store.readIndexEntry('private/health/x.md'))!.summary, 'secret summary')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

// ---- remember --------------------------------------------------------------

test('remember with a missing summary throws and writes nothing', async () => {
  const h = await makeHarness()
  try {
    await assert.rejects(h.remember({ topic: 'dev', title: 'Proj', content: 'react 18' }), /summary/)
    for (const summary of ['', '  ']) {
      await assert.rejects(h.remember({ topic: 'dev', title: 'Proj', content: 'react 18', summary }), /summary is required/)
    }
    assert.equal(await h.store.fileExists('dev/proj.md'), false)
    assert.deepEqual(await h.store.readIndex(), [])
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('remember creating a new file with keep throws before writing', async () => {
  const h = await makeHarness()
  try {
    await assert.rejects(h.remember({ topic: 'dev', title: 'Proj', content: 'react 18', summary: 'keep' }), /new memory file has no existing summary/)
    assert.equal(await h.store.fileExists('dev/proj.md'), false)
    assert.deepEqual(await h.store.readIndex(), [])
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('remember creates a new file with the given summary and renders the index line', async () => {
  const h = await makeHarness()
  try {
    const result = await h.remember({ topic: 'dev', title: 'Proj', content: 'react 18', summary: 'Frontend project stack' })
    assert.deepEqual(result, { path: 'dev/proj.md', appended: false, summary: { after: 'Frontend project stack', action: 'changed' } })
    assert.equal((await h.store.readIndexEntry('dev/proj.md'))!.summary, 'Frontend project stack')
    const rendered = h.definitions.get('remember').output.render({}, result)[0].text as string
    assert.match(rendered, /^Remembered dev\/proj\.md\nIndex summary: «\(none\)» → «Frontend project stack»$/)
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('remember appending honours keep and a rewritten summary', async () => {
  const h = await makeHarness()
  try {
    await h.remember({ topic: 'dev', title: 'Proj', content: 'react 18', summary: 'Frontend project stack' })
    const kept = await h.remember({ topic: 'dev', title: 'Proj', content: 'vite 6', summary: 'keep' })
    assert.equal(kept.appended, true)
    assert.deepEqual(kept.summary, { before: 'Frontend project stack', after: 'Frontend project stack', action: 'kept' })
    assert.match(h.definitions.get('remember').output.render({}, kept)[0].text, /^Appended to dev\/proj\.md\nIndex summary: kept «Frontend project stack»$/)
    const changed = await h.remember({ topic: 'dev', title: 'Proj', content: 'next 15', summary: 'Frontend stack: react, vite, next' })
    assert.deepEqual(changed.summary, { before: 'Frontend project stack', after: 'Frontend stack: react, vite, next', action: 'changed' })
    assert.equal(parseMemoryFile(await file(h, 'dev/proj.md')).current, '- react 18\n- vite 6\n- next 15')
  } finally {
    await rm(h.root, { recursive: true, force: true })
  }
})

test('remember keeps the privacy gates: restricted private topics throw, forced private topic still applies', async () => {
  const restricted = await makeHarness({ hidePrivate: true })
  try {
    await assert.rejects(restricted.remember({ topic: 'private/health', title: 'Exam', content: 'x', summary: 's' }), /restricted mode/)
    assert.deepEqual(await restricted.store.readIndex(), [])
  } finally {
    await rm(restricted.root, { recursive: true, force: true })
  }
})
