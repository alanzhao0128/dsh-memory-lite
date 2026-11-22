import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  resolveConfig, Config, DEFAULT_INDEX_MAX_TOKENS, DEFAULT_HOT_BUDGET_RATIO,
} from '../src/config.js'

test('resolveConfig cleanly unwraps Schemastery volatile-parsed empty and populated configs', () => {
  const parsedEmpty = Config({})
  const resolvedFromEmpty = resolveConfig(parsedEmpty)
  assert.equal(resolvedFromEmpty.root, join(homedir(), '.agent-memory'))
  assert.equal(resolvedFromEmpty.privacy.namespace, 'private')
  assert.equal(resolvedFromEmpty.privacy.hidePrivate, false)
  assert.equal(resolvedFromEmpty.extraction.mode, 'incremental')

  const parsedPopulated = Config({
    root: '~/custom-memory',
    privacy: {
      hidePrivate: true,
      restrictedProviders: ['llm-g7'],
      restrictedPaths: ['~/Documents/G7/**'],
      privatePaths: [{ pattern: '~/Documents/健康分析/**', topic: 'private/health' }],
    },
    extraction: { mode: 'explicit_only', windowTurns: 10 },
  })
  const resolvedFromPopulated = resolveConfig(parsedPopulated)
  assert.equal(resolvedFromPopulated.root, join(homedir(), 'custom-memory'))
  assert.equal(resolvedFromPopulated.privacy.hidePrivate, true)
  assert.deepEqual(resolvedFromPopulated.privacy.restrictedProviders, ['llm-g7'])
  assert.deepEqual(resolvedFromPopulated.privacy.restrictedPaths, ['~/Documents/G7/**'])
  assert.equal(resolvedFromPopulated.privacy.privatePaths.length, 1)
  assert.equal(resolvedFromPopulated.extraction.mode, 'explicit_only')
  assert.equal(resolvedFromPopulated.extraction.windowTurns, 10)
})

test('empty config resolves to documented v1.0 defaults', () => {
  const config = resolveConfig({})
  assert.equal(config.root, join(homedir(), '.agent-memory'))
  assert.equal(config.privacy.namespace, 'private')
  assert.equal(config.privacy.hidePrivate, false)
  assert.deepEqual(config.privacy.restrictedProviders, [])
  assert.deepEqual(config.privacy.restrictedPaths, [])
  assert.deepEqual(config.privacy.privatePaths, [])
  assert.equal(config.index.maxTokens, DEFAULT_INDEX_MAX_TOKENS)
  assert.equal(config.index.hotBudgetRatio, DEFAULT_HOT_BUDGET_RATIO)
  assert.equal(config.index.sortBy, 'mtime')
  assert.equal(config.tools.schemaMinimal, true)
  assert.equal(config.extraction.mode, 'incremental')
  assert.equal(config.extraction.parseRetry, true)
})

test('root expands ~ and resolves to absolute', () => {
  assert.equal(resolveConfig({ root: '~/mem' }).root, join(homedir(), 'mem'))
  assert.ok(resolveConfig({ root: 'relative/path' }).root.startsWith('/'))
})

test('invalid values fail loud', () => {
  assert.throws(() => resolveConfig({ privacy: { namespace: 'a/b' } }), /privacy\.namespace/)
  assert.throws(() => resolveConfig({ privacy: { namespace: '..' } }), /privacy\.namespace/)
  assert.throws(() => resolveConfig({ privacy: { privatePaths: [{ pattern: '~/x', topic: 'public/x' }] } }), /private\/<subtopic>/)
  assert.throws(() => resolveConfig({ privacy: { privatePaths: [{ pattern: '', topic: 'private/x' }] } }), /pattern/)
  assert.throws(() => resolveConfig({ index: { maxTokens: 10 } }), /maxTokens/)
  assert.throws(() => resolveConfig({ index: { maxTokens: 1.5 } }), /maxTokens/)
  assert.throws(() => resolveConfig({ index: { hotBudgetRatio: 0.1 } }), /hotBudgetRatio/)
  assert.throws(() => resolveConfig({ index: { hotBudgetRatio: 0.99 } }), /hotBudgetRatio/)
})

test('ui.headerOrder defaults to -1 and validates', () => {
  assert.equal(resolveConfig({}).ui.headerOrder, -1)
  assert.equal(resolveConfig({ ui: { headerOrder: 2 } }).ui.headerOrder, 2)
  assert.throws(() => resolveConfig({ ui: { headerOrder: 1.5 } }), /headerOrder/)
})

test('extraction.llm.route, windowTurns, and messageScope validate', () => {
  const config = resolveConfig({})
  assert.equal(config.extraction.llm.route, '')
  assert.equal(config.extraction.windowTurns, 50)
  assert.deepEqual(config.extraction.messageScope, ['user', 'assistant'])
  assert.equal(resolveConfig({ extraction: { llm: { route: 'a/b/c' } } }).extraction.llm.route, 'a/b/c')
  assert.throws(() => resolveConfig({ extraction: { llm: { route: 'nope' } } }), /route/)
  assert.throws(() => resolveConfig({ extraction: { messageScope: ['bogus'] as never } }), /messageScope/)
})
