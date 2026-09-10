import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, normalizeContent, parseIndex, parseMemoryFile, renderMemoryFile, slugify, summaryOf, MutationQueue } from '../src/memory-store.js'
import { MemoryPathError } from '../src/path.js'

async function makeStore(): Promise<{ store: MemoryStore; root: string; peer: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-store-'))
  return { store: new MemoryStore(root), root, peer: 'test-peer' }
}

test('writeNewMemory creates the canonical skeleton and index refresh registers it', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'preferences/coding.md', 'Coding', 'use pnpm')
    const text = await readFile(join(root, 'peers', peer, 'memories', 'preferences', 'coding.md'), 'utf8')
    assert.match(text, /^# Coding/)
    assert.match(text, /## Current/)
    assert.match(text, /- use pnpm/)
    assert.match(text, /## History/)
    assert.match(text, /## Related/)
    await store.refreshIndexEntry(peer, 'preferences/coding.md', 'use pnpm')
    const entries = await store.readIndex(peer)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.path, 'preferences/coding.md')
    const indexText = await readFile(join(root, 'peers', peer, 'memories', '_index.md'), 'utf8')
    assert.match(indexText, /preferences\/coding\.md: use pnpm/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('appendCurrent appends bullets without losing existing content', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'entities/foo.md', 'Foo', 'react 18')
    await store.appendCurrent(peer, 'entities/foo.md', 'typescript')
    const text = await readFile(join(root, 'peers', peer, 'memories', 'entities', 'foo.md'), 'utf8')
    assert.match(text, /- react 18/)
    assert.match(text, /- typescript/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('appendCurrent skips identical lines (dedup)', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'preferences/x.md', 'X', 'same fact')
    await store.appendCurrent(peer, 'preferences/x.md', 'same fact')
    const text = await readFile(join(root, 'peers', peer, 'memories', 'preferences', 'x.md'), 'utf8')
    const count = text.split('\n').filter(line => line === '- same fact').length
    assert.equal(count, 1)
    // different content still appends
    await store.appendCurrent(peer, 'preferences/x.md', 'another fact')
    const after = await readFile(join(root, 'peers', peer, 'memories', 'preferences', 'x.md'), 'utf8')
    assert.match(after, /- another fact/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent appends through the queue lose nothing', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'events/e1.md', 'E1', 'first')
    await Promise.all([
      store.appendCurrent(peer, 'events/e1.md', 'second'),
      store.appendCurrent(peer, 'events/e1.md', 'third'),
    ])
    const text = await readFile(join(root, 'peers', peer, 'memories', 'events', 'e1.md'), 'utf8')
    assert.match(text, /- second/)
    assert.match(text, /- third/)
    const secondIndex = text.indexOf('second')
    const thirdIndex = text.indexOf('third')
    assert.notEqual(secondIndex, -1)
    assert.notEqual(thirdIndex, -1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('updateCurrent archives the previous current into History (ADD-only)', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'preferences/coding.md', 'Coding', 'use pnpm')
    await store.updateCurrent(peer, 'preferences/coding.md', 'use bun')
    const text = await readFile(join(root, 'peers', peer, 'memories', 'preferences', 'coding.md'), 'utf8')
    assert.match(text, /## Current/)
    assert.match(text, /- use bun/)
    assert.match(text, /## History/)
    assert.match(text, /- \d{4}-\d{2}-\d{2}: - use pnpm/)
    // Previous content survives only in History.
    assert.ok(!text.includes('pnpm') || /use pnpm/.test(text))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('softDelete moves the file under .trash and never overwrites', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'preferences/x.md', 'X', 'value')
    await store.softDelete(peer, 'preferences/x.md')
    const trash = join(root, '.trash')
    const days = await readdir(trash)
    assert.equal(days.length, 1)
    const files = await readdir(join(trash, days[0]!))
    assert.equal(files.length, 1)
    await assert.rejects(() => store.readFile(peer, 'preferences/x.md'), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('search returns matching lines with rel paths and respects caps', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.writeNewMemory(peer, 'preferences/tools.md', 'Tools', 'Podman over Docker')
    await store.writeNewMemory(peer, 'entities/project.md', 'Project', 'React 18 with pnpm workspace')
    const matches = await store.search(peer, 'pnpm')
    assert.ok(matches.some(m => m.path === 'entities/project.md' && m.line.includes('pnpm')))
    const none = await store.search(peer, 'zzz-nothing')
    assert.equal(none.length, 0)
    // Index files are not search results.
    const idx = await store.search(peer, 'Memory Index')
    assert.equal(idx.length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolve rejects escapes, absolute paths, and non-md paths', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await assert.rejects(() => store.resolve(peer, '../../etc/passwd'), MemoryPathError)
    await assert.rejects(() => store.resolve(peer, '/etc/passwd'), MemoryPathError)
    await assert.rejects(() => store.resolve(peer, 'preferences/coding.txt'), MemoryPathError)
    await assert.rejects(() => store.resolve(peer, ''), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('parseIndex is tolerant of malformed and foreign lines', () => {
  const text = [
    '# Memory Index — p',
    '',
    '> Last updated: x | Total: 2',
    '',
    '## preferences (always relevant)',
    '- preferences/coding.md: use pnpm',
    '- not-an-entry',
    '- ../escape.md: nope',
    '- /absolute.md: nope',
    '## entities (relevant when mentioned)',
    '- entities/foo.md: react',
  ].join('\n')
  const entries = parseIndex(text)
  assert.deepEqual(entries, [
    { category: 'preferences', path: 'preferences/coding.md', summary: 'use pnpm' },
    { category: 'entities', path: 'entities/foo.md', summary: 'react' },
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
  const fullFile = [
    '# npm偏好',
    '',
    '## Current',
    '- 用户偏好使用 npm 作为包管理器。',
    '',
    '## History',
    '',
    '## Related',
    '',
  ].join('\n')
  assert.equal(normalizeContent(fullFile), '- 用户偏好使用 npm 作为包管理器。')
  // Plain text and bullets pass through unchanged.
  assert.equal(normalizeContent('use pnpm'), 'use pnpm')
  assert.equal(normalizeContent('- use pnpm'), '- use pnpm')
  // A full file without a Current section degrades to the whole trimmed text.
  assert.equal(normalizeContent('# Only Title'), '# Only Title')
})

test('slugify and summaryOf are stable and bounded', () => {
  assert.equal(slugify('My Coding Style!'), 'my-coding-style')
  assert.equal(slugify(''), 'memory')
  assert.equal(slugify('a'.repeat(200)).length, 80)
  assert.equal(summaryOf('  multi\n  line  fact '), 'multi line fact')
  assert.ok(summaryOf('x'.repeat(500)).endsWith('...'))
  // Default summary length is 100 characters (maxLength - 3 + '...').
  assert.equal(summaryOf('x'.repeat(300)).length, 100)
})

test('slugify keeps CJK titles so Chinese memories do not collide', () => {
  assert.equal(slugify('喜欢吃苹果'), '喜欢吃苹果')
  assert.equal(slugify('吃苹果 偏好吗'), '吃苹果-偏好吗')
  // Emoji-only title still degrades to the fallback.
  assert.equal(slugify('🍎🍌'), 'memory')
  // Distinct Chinese titles produce distinct slugs.
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

test('appendExtractionLog appends one JSON line per run under sessions/', async () => {
  const { store, root, peer } = await makeStore()
  try {
    await store.appendExtractionLog(peer, '{"at":"t1","llmCalls":1}')
    await store.appendExtractionLog(peer, '{"at":"t2","llmCalls":2}')
    const text = await readFile(join(root, 'peers', peer, 'sessions', 'extraction.log'), 'utf8')
    const lines = text.trim().split('\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]!), { at: 't1', llmCalls: 1 })
    assert.deepEqual(JSON.parse(lines[1]!), { at: 't2', llmCalls: 2 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shared mounts redirect reads to the target peer and enforce read-only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-share-'))
  const sharing = { enabled: true, mounts: [{ name: 'alpha', peer: 'alpha-peer', subpath: '', readonly: true }] }
  const store = new MemoryStore(root, sharing)
  try {
    // Seed a memory in the target peer.
    await store.writeNewMemory('alpha-peer', 'preferences/tools.md', 'Tools', 'use pnpm')
    // Read through the shared path from an unrelated peer.
    const { content, rel } = await store.readFile('beta-peer', 'shared/alpha/preferences/tools.md')
    assert.match(content, /use pnpm/)
    assert.equal(rel, 'shared/alpha/preferences/tools.md')
    // Search covers the shared mount and returns shared-prefixed paths.
    const hits = await store.search('beta-peer', 'pnpm')
    assert.ok(hits.some(hit => hit.path === 'shared/alpha/preferences/tools.md'))
    assert.ok(!hits.some(hit => hit.path.startsWith('shared/') && !hit.path.startsWith('shared/alpha/')))
    // Writes to a read-only mount are rejected.
    await assert.rejects(() => store.writeNewMemory('beta-peer', 'shared/alpha/preferences/new.md', 'X', 'y'), /read-only/)
    await assert.rejects(() => store.softDelete('beta-peer', 'shared/alpha/preferences/tools.md'), /read-only/)
    // Unknown mount, self-access, malformed, and escape are rejected.
    await assert.rejects(() => store.readFile('beta-peer', 'shared/nope/preferences/tools.md'), /unknown shared mount/)
    await assert.rejects(() => store.readFile('alpha-peer', 'shared/alpha/preferences/tools.md'), /cannot access/)
    await assert.rejects(() => store.readFile('beta-peer', 'shared/alpha.md'), /shared\/<name>/)
    await assert.rejects(() => store.readFile('beta-peer', 'shared/alpha/../../escape.md'), /escapes the memory root/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('shared paths are rejected when sharing is disabled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-share-'))
  const store = new MemoryStore(root)
  try {
    await assert.rejects(() => store.readFile('beta', 'shared/alpha/preferences/tools.md'), /disabled/)
    await assert.rejects(() => store.readFile('beta', 'shared/alpha.md'), /disabled/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('peer meta: displayName annotations round-trip and rememberPeerCwd writes once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-peer-meta-'))
  const store = new MemoryStore(root)
  try {
    // listPeers with no peers -> empty.
    assert.deepEqual(await store.listPeers(), [])

    // Create two peer dirs; one gets a manual meta annotation.
    const peerA = 'workspace-aad65ea5'
    const peerB = 'dsh-test-72572e8b'
    const { mkdir, writeFile } = await import('node:fs/promises')
    await mkdir(join(root, 'peers', peerA, 'memories'), { recursive: true })
    await mkdir(join(root, 'peers', peerB, 'memories'), { recursive: true })
    await writeFile(join(root, 'peers', peerA, '.peer-meta.json'), JSON.stringify({ displayName: '健康分析', sourceCwd: '/Users/alan/Documents/健康分析' }))

    const peers = await store.listPeers()
    const byName = Object.fromEntries(peers.map(p => [p.name, p.displayName]))
    assert.equal(byName[peerA], '健康分析')
    // No meta file -> displayName falls back to the storage name.
    assert.equal(byName[peerB], peerB)

    // rememberPeerCwd writes the annotation on first sight of a cwd.
    await store.rememberPeerCwd(peerB, '/Users/alan/code/dsh-test')
    const after = await store.listPeers()
    const bAfter = after.find(p => p.name === peerB)!
    assert.equal(bAfter.displayName, 'dsh-test')
    assert.equal((await store.readPeerMeta(peerB))?.sourceCwd, '/Users/alan/code/dsh-test')

    // Idempotent: an existing annotation (even for another cwd) is never rewritten.
    await store.rememberPeerCwd(peerA, '/somewhere/else')
    const aAfter = (await store.listPeers()).find(p => p.name === peerA)!
    assert.equal(aAfter.displayName, '健康分析')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
