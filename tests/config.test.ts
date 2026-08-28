import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig, DEFAULT_MEMORY_ROOT, DEFAULT_PEER, DEFAULT_INDEX_MAX_TOKENS } from '../src/config.js'

test('empty config resolves to documented defaults', () => {
  const config = resolveConfig({})
  assert.equal(config.defaultPeer, DEFAULT_PEER)
  assert.equal(config.root, join(homedir(), '.agent-memory'))
  assert.equal(config.workspacePeers.enabled, true)
  assert.equal(config.workspacePeers.excludeSubagents, true)
  assert.equal(config.workspacePeers.cwdFallback, 'default_peer')
  assert.equal(config.index.maxTokens, DEFAULT_INDEX_MAX_TOKENS)
  assert.equal(config.index.sortBy, 'mtime')
  assert.equal(config.tools.schemaMinimal, true)
  assert.equal(config.extraction.mode, 'incremental')
  assert.equal(config.extraction.parseRetry, true)
  assert.equal(config.sharing.enabled, false)
  assert.deepEqual(config.sharing.mounts, [])
})

test('root expands ~ and resolves to absolute', () => {
  const config = resolveConfig({ root: '~/mem' })
  assert.equal(config.root, join(homedir(), 'mem'))
  const relative = resolveConfig({ root: 'relative/path' })
  assert.ok(relative.root.startsWith('/'))
})

test('partial nested configs merge with defaults', () => {
  const config = resolveConfig({ workspacePeers: { enabled: false }, index: { maxTokens: 600 } })
  assert.equal(config.workspacePeers.enabled, false)
  assert.equal(config.workspacePeers.excludeSubagents, true)
  assert.equal(config.index.maxTokens, 600)
  assert.equal(resolveConfig({ extraction: { parseRetry: false } }).extraction.parseRetry, false)
})

test('invalid values fail loud', () => {
  assert.throws(() => resolveConfig({ defaultPeer: 'a/b' }), /defaultPeer/)
  assert.throws(() => resolveConfig({ defaultPeer: '..' }), /defaultPeer/)
  assert.throws(() => resolveConfig({ defaultPeer: '' }), /defaultPeer/)
  assert.throws(() => resolveConfig({ index: { maxTokens: 10 } }), /maxTokens/)
  assert.throws(() => resolveConfig({ index: { maxTokens: 1.5 } }), /maxTokens/)
})

test('sharing mounts resolve with readonly default and validate', () => {
  const config = resolveConfig({
    sharing: {
      enabled: true,
      mounts: [{ name: 'dsh-test', peer: 'dsh-test-72572e8b', subpath: '', readonly: true }],
    },
  })
  assert.equal(config.sharing.enabled, true)
  assert.equal(config.sharing.mounts.length, 1)
  assert.equal(config.sharing.mounts[0].name, 'dsh-test')
  assert.equal(config.sharing.mounts[0].peer, 'dsh-test-72572e8b')
  // readonly defaults to true when omitted.
  const implicit = resolveConfig({ sharing: { enabled: true, mounts: [{ name: 'a', peer: 'b' }] } })
  assert.equal(implicit.sharing.mounts[0].readonly, true)
  // invalid mounts fail loud.
  assert.throws(() => resolveConfig({ sharing: { mounts: [{ name: 'a/b', peer: 'p', subpath: '', readonly: true }] } }), /mount name/)
  assert.throws(() => resolveConfig({ sharing: { mounts: [{ name: '..', peer: 'p', subpath: '', readonly: true }] } }), /mount name/)
  assert.throws(() => resolveConfig({ sharing: { mounts: [{ name: 'a', peer: 'p/q', subpath: '', readonly: true }] } }), /mount peer/)
  assert.throws(() => resolveConfig({ sharing: { mounts: [{ name: 'a', peer: 'p', subpath: '../x', readonly: true }] } }), /subpath/)
})

test('ui.headerOrder defaults to -1 and validates', () => {
  // Default: memory-lite renders left of the built-in "Session log" capsule.
  assert.equal(resolveConfig({}).ui.headerOrder, -1)
  // Explicit value is honored.
  assert.equal(resolveConfig({ ui: { headerOrder: 2 } }).ui.headerOrder, 2)
  // Non-integers fail loud.
  assert.throws(() => resolveConfig({ ui: { headerOrder: 1.5 } }), /headerOrder/)
})


test('extraction.llm.route and reasoningEffort default empty and validate', () => {
  // Defaults: empty route = follow the global default model.
  const config = resolveConfig({})
  assert.equal(config.extraction.llm.route, '')
  assert.equal(config.extraction.llm.reasoningEffort, '')

  // Explicit route resolves and effort passes through.
  const explicit = resolveConfig({
    extraction: { llm: { route: 'deepseek-official/deepseek-v4-flash', reasoningEffort: 'low' } },
  })
  assert.equal(explicit.extraction.llm.route, 'deepseek-official/deepseek-v4-flash')
  assert.equal(explicit.extraction.llm.reasoningEffort, 'low')

  // Legacy provider/model fields still resolve for pre-§17 configs.
  const legacy = resolveConfig({
    extraction: { llm: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } },
  })
  assert.equal(legacy.extraction.llm.provider, 'deepseek-official')
  assert.equal(legacy.extraction.llm.model, 'deepseek-v4-flash')
  assert.equal(legacy.extraction.llm.route, '')

  // Model ids may contain a slash (pi-ai routes like commandcode/deepseek/deepseek-v4-flash),
  // so 'provider/model-with/slash' is legal; only provider-less or empty-segment routes fail.
  assert.equal(resolveConfig({ extraction: { llm: { route: 'a/b/c' } } }).extraction.llm.route, 'a/b/c')
  // Invalid routes fail loud.
  assert.throws(() => resolveConfig({ extraction: { llm: { route: 'nope' } } }), /route/)
  assert.throws(() => resolveConfig({ extraction: { llm: { route: '/model' } } }), /route/)
  assert.throws(() => resolveConfig({ extraction: { llm: { route: 'provider/' } } }), /route/)
  assert.throws(() => resolveConfig({ extraction: { llm: { route: 'a\\b/c' } } }), /route/)
})
