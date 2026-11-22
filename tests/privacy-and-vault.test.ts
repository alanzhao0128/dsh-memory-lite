/**
 * Comprehensive v1.0 tests for the Unified Topic Vault:
 * - Trust-boundary gate (hidePrivate, restrictedProviders, restrictedPaths, privatePaths)
 * - Topic validation & `read_memory("<topic>/")` directory listing
 * - Automatic `TopicAffinityStore` learning & hot-topic ranking
 * - End-to-end extraction dual trust gate (session provider + extraction model provider)
 * - Cross-topic personal linkage (insurance <-> health) vs corporate isolation
 * @module dsh-memory-lite/tests/privacy-and-vault
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.js'
import { evaluateTrust, isPrivatePath, matchPathPattern, normalizeTopic, topicOfPath } from '../src/privacy.js'
import { MemoryStore } from '../src/memory-store.js'
import { TopicAffinityStore } from '../src/affinity.js'
import { applyDecisionDetailed } from '../src/extract/index.js'
import { extractionSystem } from '../src/extract/prompt.js'
import { MemoryPathError } from '../src/path.js'

test('privacy: normalizeTopic, isPrivatePath, topicOfPath, and matchPathPattern', () => {
  assert.equal(normalizeTopic('infra'), 'infra')
  assert.equal(normalizeTopic('private/health'), 'private/health')
  assert.equal(normalizeTopic('/private/insurance/'), 'private/insurance')
  assert.throws(() => normalizeTopic('private'), /subtopic/)
  assert.throws(() => normalizeTopic('private/health/deep'), /<subtopic>/)
  assert.throws(() => normalizeTopic('../etc'), /invalid topic/)

  assert.equal(isPrivatePath('private/health/zhao.md'), true)
  assert.equal(isPrivatePath('private'), true)
  assert.equal(isPrivatePath('infra/cpa.md'), false)
  assert.equal(topicOfPath('private/health/zhao.md'), 'private/health')
  assert.equal(topicOfPath('infra/cpa.md'), 'infra')

  const home = homedir()
  assert.equal(matchPathPattern(join(home, 'Documents/G7'), '~/Documents/G7/**'), true)
  assert.equal(matchPathPattern(join(home, 'Documents/G7/双胞胎'), '~/Documents/G7/**'), true)
  assert.equal(matchPathPattern(join(home, 'Documents/G7项目'), '~/Documents/G7/**'), false)
})

test('privacy: evaluateTrust enforces hidePrivate, restrictedProviders, restrictedPaths, and privatePaths', () => {
  const home = homedir()
  const privacy = resolveConfig({
    privacy: {
      restrictedProviders: ['llm-g7', 'g7e6ai'],
      restrictedPaths: ['~/Documents/G7/**'],
      privatePaths: [
        { pattern: '~/Documents/健康分析/**', topic: 'private/health' },
        { pattern: '~/Documents/保险分析/**', topic: 'private/insurance' },
      ],
    },
  }).privacy

  // Personal provider + personal dir -> unrestricted (insurance <-> health freely connected)
  assert.deepEqual(
    evaluateTrust({ cwd: join(home, 'Documents/保险分析'), provider: 'cliproxy', privacy }),
    { restricted: false, forcedPrivateTopic: 'private/insurance' },
  )

  // Corporate provider in ANY dir (even inside 保险分析!) -> restricted!
  assert.deepEqual(
    evaluateTrust({ cwd: join(home, 'Documents/保险分析'), provider: 'llm-g7', privacy }),
    { restricted: true, reason: 'provider' },
  )

  // Personal provider in corporate dir -> restricted!
  assert.deepEqual(
    evaluateTrust({ cwd: join(home, 'Documents/G7/双胞胎'), provider: 'cliproxy', privacy }),
    { restricted: true, reason: 'path' },
  )

  // Extra provider (extraction LLM route) being restricted -> restricted!
  assert.deepEqual(
    evaluateTrust({ cwd: join(home, 'code/dsh-test'), provider: 'cliproxy', extraProviders: ['g7e6ai'], privacy }),
    { restricted: true, reason: 'provider' },
  )

  // One-click hidePrivate -> always restricted!
  assert.deepEqual(
    evaluateTrust({ cwd: join(home, 'code/dsh-test'), provider: 'cliproxy', privacy: { ...privacy, hidePrivate: true } }),
    { restricted: true, reason: 'hidePrivate' },
  )
})

test('MemoryStore: hard trust boundary blocks private/ across index, listTopic, read, search, and writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vault-trust-'))
  try {
    const store = new MemoryStore(root)
    await store.writeNewMemory('g7/gateway.md', 'G7 Gateway', 'aicoding.chinawayltd.com')
    await store.refreshIndexEntry('g7/gateway.md', 'G7 corporate model gateway')
    await store.writeNewMemory('private/health/zhao.md', 'Zhao Health', '2026 blood test normal')
    await store.refreshIndexEntry('private/health/zhao.md', 'Zhao 2026 medical exam')
    await store.writeNewMemory('private/insurance/aia.md', 'AIA Policy', 'C894 critical illness contract')
    await store.refreshIndexEntry('private/insurance/aia.md', 'AIA C894 policy')

    // Personal mode: insurance & health & g7 are all visible and cross-searchable!
    const allIndex = await store.readIndex({ restricted: false })
    assert.equal(allIndex.length, 3)
    const healthList = await store.listTopic('private/health', { restricted: false })
    assert.equal(healthList.entries.length, 1)
    assert.equal((await store.search('blood', { trust: { restricted: false } })).length, 1)

    // Restricted mode: private/* disappears from index, search, listTopic, read, and write!
    const restricted = { restricted: true as const, reason: 'provider' as const }
    const pubIndex = await store.readIndex(restricted)
    assert.deepEqual(pubIndex.map(e => e.path), ['g7/gateway.md'])
    assert.deepEqual(await store.search('blood', { trust: restricted }), [])
    assert.deepEqual(await store.search('C894', { trust: restricted }), [])
    await assert.rejects(() => store.readFile('private/health/zhao.md', restricted), MemoryPathError)
    await assert.rejects(() => store.listTopic('private/health', restricted), MemoryPathError)
    await assert.rejects(() => store.listTopic('private', restricted), MemoryPathError)
    await assert.rejects(() => store.search('exam', { topic: 'private/health', trust: restricted }), MemoryPathError)
    await assert.rejects(() => store.writeNewMemory('private/health/new.md', 'X', 'y', restricted), MemoryPathError)
    await assert.rejects(() => store.softDelete('private/health/zhao.md', restricted), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('TopicAffinityStore: learns cross-topic affinity per cwd automatically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-affinity-'))
  try {
    const affinity = new TopicAffinityStore(root)
    const dir = '/Users/alan/Documents/保险分析'
    await affinity.record(dir, 'private/insurance')
    await affinity.record(dir, 'private/insurance')
    await affinity.record(dir, 'private/health')
    const hot = await affinity.hotTopicsFor(dir)
    assert.deepEqual(hot, ['private/insurance', 'private/health'])
    assert.deepEqual(await affinity.hotTopicsFor('/Users/alan/unknown'), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('extract: applyDecisionDetailed enforces restricted skip and privatePaths forced routing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-extract-trust-'))
  try {
    const store = new MemoryStore(root)

    // 1. Restricted mode prompt explicitly forbids private/
    assert.ok(extractionSystem({ restricted: true }).includes('RESTRICTED MODE ACTIVE'))
    assert.ok(extractionSystem({ restricted: false }).includes('TOPIC & PRIVACY ROUTING'))

    // 2. Restricted mode drops any create/merge targeting private/
    const skippedCreate = await applyDecisionDetailed(store, {
      kind: 'create', topic: 'private/health', title: 'Exam', content: 'sensitive',
    }, { trust: { restricted: true, reason: 'provider' } })
    assert.equal(skippedCreate.applied, 'skip')

    // 3. Inside privatePaths (unrestricted), a misclassified non-private topic is auto-routed to forcedPrivateTopic!
    const forced = await applyDecisionDetailed(store, {
      kind: 'create', topic: 'dev', title: 'Checkup', content: 'cholesterol 4.2', summary: '2026 checkup',
    }, { trust: { restricted: false, forcedPrivateTopic: 'private/health' } })
    assert.equal(forced.applied, 'create')
    assert.equal(forced.path, 'private/health/checkup.md')
    assert.equal((await store.readIndex())[0]!.topic, 'private/health')

    // 4. Inside privatePaths, an explicit private subtopic (e.g. private/insurance while in 保险分析 reading health) is respected!
    const keptPrivate = await applyDecisionDetailed(store, {
      kind: 'create', topic: 'private/insurance', title: 'Policy', content: 'H169 medical',
    }, { trust: { restricted: false, forcedPrivateTopic: 'private/health' } })
    assert.equal(keptPrivate.path, 'private/insurance/policy.md')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
