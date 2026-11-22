import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryStore, normalizeContent, parseIndex, parseMemoryFile,
  renderMemoryFile, renderIndex, slugify, summaryOf, MutationQueue,
} from '../src/memory-store.js'
import { MemoryPathError } from '../src/path.js'

async function makeStore(): Promise<{ store: MemoryStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-store-'))
  return { store: new MemoryStore(root), root }
}

test('writeNewMemory creates the canonical skeleton and index refresh registers it', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('preferences/coding.md', 'Coding', 'use pnpm')
    const text = await readFile(join(root, 'memories', 'preferences', 'coding.md'), 'utf8')
    assert.match(text, /^# Coding/)
    assert.match(text, /## Current/)
    assert.match(text, /- use pnpm/)
    assert.match(text, /## History/)
    assert.match(text, /## Related/)
    await store.refreshIndexEntry('preferences/coding.md', 'use pnpm')
    const entries = await store.readIndex()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.path, 'preferences/coding.md')
    assert.equal(entries[0]!.topic, 'preferences')
    const indexText = await readFile(join(root, 'memories', '_index.md'), 'utf8')
    assert.match(indexText, /preferences\/coding\.md: use pnpm/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('appendCurrent appends bullets without losing existing content', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('dev/foo.md', 'Foo', 'react 18')
    await store.appendCurrent('dev/foo.md', 'typescript')
    const text = await readFile(join(root, 'memories', 'dev', 'foo.md'), 'utf8')
    assert.match(text, /- react 18/)
    assert.match(text, /- typescript/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('appendCurrent skips identical lines (dedup)', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('preferences/x.md', 'X', 'same fact')
    await store.appendCurrent('preferences/x.md', 'same fact')
    const text = await readFile(join(root, 'memories', 'preferences', 'x.md'), 'utf8')
    const count = text.split('\n').filter(line => line === '- same fact').length
    assert.equal(count, 1)
    await store.appendCurrent('preferences/x.md', 'another fact')
    const after = await readFile(join(root, 'memories', 'preferences', 'x.md'), 'utf8')
    assert.match(after, /- another fact/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent appends through the queue lose nothing', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('infra/e1.md', 'E1', 'first')
    await Promise.all([
      store.appendCurrent('infra/e1.md', 'second'),
      store.appendCurrent('infra/e1.md', 'third'),
    ])
    const text = await readFile(join(root, 'memories', 'infra', 'e1.md'), 'utf8')
    assert.match(text, /- second/)
    assert.match(text, /- third/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateCurrent archives the previous current into History (ADD-only)', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('preferences/coding.md', 'Coding', 'use pnpm')
    await store.updateCurrent('preferences/coding.md', 'use bun')
    const text = await readFile(join(root, 'memories', 'preferences', 'coding.md'), 'utf8')
    assert.match(text, /## Current/)
    assert.match(text, /- use bun/)
    assert.match(text, /## History/)
    assert.match(text, /- \d{4}-\d{2}-\d{2}: use pnpm/)
    assert.ok(!text.includes('- - '), 'no nested double bullets')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('softDelete moves the file under .trash and never overwrites', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('preferences/x.md', 'X', 'value')
    await store.softDelete('preferences/x.md')
    const trash = join(root, '.trash')
    const days = await readdir(trash)
    assert.equal(days.length, 1)
    const files = await readdir(join(trash, days[0]!))
    assert.equal(files.length, 1)
    await assert.rejects(() => store.readFile('preferences/x.md'), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('search matches titles, summaries, and bodies with topic scoping', async () => {
  const { store, root } = await makeStore()
  try {
    await store.writeNewMemory('preferences/tools.md', 'Tools', 'Podman over Docker')
    await store.refreshIndexEntry('preferences/tools.md', 'container tools')
    await store.writeNewMemory('dev/project.md', 'Project', 'React 18 with pnpm workspace')
    await store.refreshIndexEntry('dev/project.md', 'frontend stack summary')
    const matches = await store.search('pnpm')
    assert.ok(matches.some(m => m.path === 'dev/project.md' && m.line.includes('pnpm')))
    // Matches summary even when keyword is not in body
    const bySummary = await store.search('frontend stack')
    assert.ok(bySummary.some(m => m.path === 'dev/project.md' && m.line.includes('[summary]')))
    // Topic filter narrows hits
    assert.equal((await store.search('pnpm', { topic: 'preferences' })).length, 0)
    assert.ok((await store.search('pnpm', { topic: 'dev' })).length >= 1)
    // Index files are not body hits
    assert.equal((await store.search('Memory Index')).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolve rejects escapes, absolute paths, and non-md paths', async () => {
  const { store, root } = await makeStore()
  try {
    await assert.rejects(() => store.resolve('../../etc/passwd'), MemoryPathError)
    await assert.rejects(() => store.resolve('/etc/passwd'), MemoryPathError)
    await assert.rejects(() => store.resolve('preferences/coding.txt'), MemoryPathError)
    await assert.rejects(() => store.resolve(''), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parseIndex is tolerant of malformed and foreign lines and supports nested private topics', () => {
  const text = [
    '# Memory Index',
    '',
    '> Last updated: x | Total: 2',
    '',
    '## preferences (always relevant)',
    '- preferences/coding.md: use pnpm',
    '- not-an-entry',
    '- ../escape.md: nope',
    '- /absolute.md: nope',
    '## private/health',
    '- private/health/checkup.md: annual exam',
  ].join('\n')
  const entries = parseIndex(text)
  assert.deepEqual(entries, [
    { topic: 'preferences', path: 'preferences/coding.md', summary: 'use pnpm' },
    { topic: 'private/health', path: 'private/health/checkup.md', summary: 'annual exam' },
  ])
})

test('parseMemoryFile and renderMemoryFile round-trip all sections', () => {
  const text = '# Title\n\n## Current\n- a\n\n## History\n- 2026-01-01: old\n\n## Related\n- other.md\n'
  const parsed = parseMemoryFile(text)
  assert.equal(parsed.title, 'Title')
  assert.equal(parsed.current, '- a')
  assert.equal(parsed.history, '- 2026-01-01: old')
  assert.equal(parsed.related, '- other.md')
  assert.equal(renderMemoryFile(parsed), text)
})

test('normalizeContent unwraps a full-file payload into its Current body', () => {
  const fullFile = '# npm偏好\n\n## Current\n- 用户偏好使用 npm 作为包管理器。\n\n## History\n\n## Related\n'
  assert.equal(normalizeContent(fullFile), '- 用户偏好使用 npm 作为包管理器。')
  assert.equal(normalizeContent('use pnpm'), 'use pnpm')
  assert.equal(normalizeContent('- use pnpm'), '- use pnpm')
  assert.equal(normalizeContent('# Only Title'), '# Only Title')
})

test('slugify and summaryOf are stable and bounded', () => {
  assert.equal(slugify('My Coding Style!'), 'my-coding-style')
  assert.equal(slugify(''), 'memory')
  assert.equal(slugify('a'.repeat(200)).length, 80)
  assert.equal(summaryOf('  multi\n  line  fact '), 'multi line fact')
  assert.ok(summaryOf('x'.repeat(500)).endsWith('...'))
  assert.equal(summaryOf('x'.repeat(300)).length, 100)
})

test('slugify keeps CJK titles so Chinese memories do not collide', () => {
  assert.equal(slugify('喜欢吃苹果'), '喜欢吃苹果')
  assert.equal(slugify('吃苹果 偏好吗'), '吃苹果-偏好吗')
  assert.equal(slugify('🍎🍌'), 'memory')
  assert.notEqual(slugify('吃苹果'), slugify('跑步习惯'))
})

test('MutationQueue serializes and isolates failures', async () => {
  const queue = new MutationQueue()
  const order: string[] = []
  const first = queue.enqueue(async () => { await new Promise(r => setTimeout(r, 20)); order.push('first') })
  const second = queue.enqueue(async () => { order.push('second') })
  const failing = queue.enqueue(async () => { throw new Error('boom') })
  const after = queue.enqueue(async () => { order.push('after') })
  await Promise.all([first, second, after])
  await assert.rejects(() => failing, /boom/)
  assert.deepEqual(order, ['first', 'second', 'after'])
})

test('appendExtractionLog appends one JSON line per run under unified sessions/', async () => {
  const { store, root } = await makeStore()
  try {
    await store.appendExtractionLog('{"at":"t1","llmCalls":1}')
    await store.appendExtractionLog('{"at":"t2","llmCalls":2}')
    const text = await readFile(join(root, 'sessions', 'extraction.log'), 'utf8')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]!), { at: 't1', llmCalls: 1 })
    assert.deepEqual(JSON.parse(lines[1]!), { at: 't2', llmCalls: 2 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('readGlobalCharter returns content when AGENTS.md exists and undefined when absent', async () => {
  const { store, root } = await makeStore()
  try {
    assert.equal(await store.readGlobalCharter(), undefined)
    await writeFile(join(root, 'AGENTS.md'), '# Global Charter\n- Rule 1\n', 'utf8')
    assert.equal(await store.readGlobalCharter(), '# Global Charter\n- Rule 1')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renderIndex enforces stable ordering: preferences -> public topics -> private topics', () => {
  const entries = [
    { topic: 'private/health', path: 'private/health/exam.md', summary: 'annual exam' },
    { topic: 'infra', path: 'infra/cpa.md', summary: 'cpa service' },
    { topic: 'preferences', path: 'preferences/style.md', summary: 'plan first' },
    { topic: 'g7', path: 'g7/gateway.md', summary: 'g7 gateway' },
  ]
  const rendered = renderIndex(entries, new Date('2026-11-22T00:00:00Z'))
  const pIdx = rendered.indexOf('## preferences (always relevant)')
  const iIdx = rendered.indexOf('## infra')
  const gIdx = rendered.indexOf('## g7')
  const hIdx = rendered.indexOf('## private/health')
  assert.ok(pIdx !== -1 && iIdx !== -1 && gIdx !== -1 && hIdx !== -1)
  assert.ok(pIdx < iIdx && iIdx < gIdx && gIdx < hIdx)
})
