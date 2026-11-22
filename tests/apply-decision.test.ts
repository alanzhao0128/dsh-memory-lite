import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../src/memory-store.js'
import { applyDecision } from '../src/extract/index.js'

async function makeStore(): Promise<{ store: MemoryStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-apply-'))
  return { store: new MemoryStore(root), root }
}

test('create merges into an existing memory instead of overwriting it', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('preferences/alan.md', 'Alan', '用户要求称呼他为 Alan')
    const path = await applyDecision(store, {
      kind: 'create', topic: 'preferences', title: 'Alan', content: '用户做量化研究',
    })
    assert.equal(path, 'preferences/alan.md')
    const text = await readFile(join(root, 'memories', 'preferences', 'alan.md'), 'utf8')
    assert.match(text, /用户要求称呼他为 Alan/)
    assert.match(text, /用户做量化研究/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('repeated create with identical content does not duplicate bullets', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('preferences/pnpm.md', 'pnpm', '用 pnpm')
    await applyDecision(store, { kind: 'create', topic: 'preferences', title: 'pnpm', content: '用 pnpm' })
    await applyDecision(store, { kind: 'create', topic: 'preferences', title: 'pnpm', content: '用 pnpm' })
    const text = await readFile(join(root, 'memories', 'preferences', 'pnpm.md'), 'utf8')
    const count = text.split('\n').filter(line => line === '- 用 pnpm').length
    assert.equal(count, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('create writes a new file when none exists', async () => {
  const { store, root } = await makeStore()
  try {
    const path = await applyDecision(store, { kind: 'create', topic: 'dev', title: 'Proj', content: 'react 18' })
    assert.equal(path, 'dev/proj.md')
    const text = await readFile(join(root, 'memories', 'dev', 'proj.md'), 'utf8')
    assert.match(text, /- react 18/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('create strips a trailing .md from the title (no double extension)', async () => {
  const { store, root } = await makeStore()
  try {
    const path = await applyDecision(store, {
      kind: 'create', topic: 'dev', title: 'officecli 说明.md', content: '官方原版',
    })
    assert.equal(path, 'dev/officecli-说明.md')
    const text = await readFile(join(root, 'memories', 'dev', 'officecli-说明.md'), 'utf8')
    assert.match(text, /- 官方原版/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
