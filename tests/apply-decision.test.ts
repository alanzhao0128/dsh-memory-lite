import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory-store.js'
import { applyDecision } from '../src/extract/index.js'

async function makeStore(): Promise<{ store: MemoryStore; root: string; peer: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-apply-'))
  return { store: new MemoryStore(root), root, peer: 'test-peer' }
}

test('create merges into an existing memory instead of overwriting it', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'preferences/alan.md', 'Alan', '用户要求称呼他为 Alan')
    const path = await applyDecision(store, peer, {
      kind: 'create', category: 'preferences', title: 'Alan', content: '用户做量化研究',
    })
    assert.equal(path, 'preferences/alan.md')
    const text = await readFile(join(root, 'peers', peer, 'memories', 'preferences', 'alan.md'), 'utf8')
    // the explicit content survives and the new fact is appended (not overwritten)
    assert.match(text, /用户要求称呼他为 Alan/)
    assert.match(text, /用户做量化研究/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repeated create with identical content does not duplicate bullets', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'preferences/pnpm.md', 'pnpm', '用 pnpm')
    await applyDecision(store, peer, { kind: 'create', category: 'preferences', title: 'pnpm', content: '用 pnpm' })
    await applyDecision(store, peer, { kind: 'create', category: 'preferences', title: 'pnpm', content: '用 pnpm' })
    const text = await readFile(join(root, 'peers', peer, 'memories', 'preferences', 'pnpm.md'), 'utf8')
    const count = text.split('\n').filter(line => line === '- 用 pnpm').length
    assert.equal(count, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('create writes a new file when none exists', async () => {
  const { store, root, peer } = await makeStore()
  try {
    const path = await applyDecision(store, peer, { kind: 'create', category: 'entities', title: 'Proj', content: 'react 18' })
    assert.equal(path, 'entities/proj.md')
    const text = await readFile(join(root, 'peers', peer, 'memories', 'entities', 'proj.md'), 'utf8')
    assert.match(text, /- react 18/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
