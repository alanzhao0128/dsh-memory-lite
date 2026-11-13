/**
 * REAL-composition integration for the reconcile pass: a merge decision on an
 * existing file triggers a second LLM call that sees the numbered Current and
 * answers with a patch, a noop, or garbage (append fallback).
 * @module dsh-memory-lite/tests/extract-reconcile-boot
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { MemoryStore, parseMemoryFile } from '../src/memory-store.js'
import { resolveConfig, type MemoryConfig } from '../src/config.js'
import { extractOnce, type ExtractionSessionLike } from '../src/extract/index.js'
import { createStatusTracker } from '../src/status.js'

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const PLUGIN_ENTRY = join(PROJECT_ROOT, 'lib', 'index.js')
const FAKE_CONNECTION_ENTRY = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-connection.ts')

function sessionLike(id: string, seq: number): ExtractionSessionLike {
  return {
    id,
    header: {},
    events: [
      { type: 'user/message', seq: seq - 1, data: { content: [{ type: 'text', text: 'CPA 的 Google 池现在是 0 了' }], role: 'user', id: 'u1', source: { kind: 'user' } } },
      { type: 'assistant/message', seq, data: { message: { role: 'assistant', content: [{ type: 'text', text: '已记录。' }], source: { kind: 'model' } } } },
    ],
    requestHeader: () => ({ config: { provider: 'huoshan', model: 'deepseek-v4-flash' } }),
  }
}

async function bootCtx(memoryRoot: string): Promise<Awaited<ReturnType<typeof boot>>> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-reconcile-boot-'))
  const configPath = join(cwd, 'cordis.yml')
  await writeFile(configPath, [
    '- name: "@deepseek-ai/dsh-system-prompt"',
    '- name: "@deepseek-ai/dsh-tools"',
    '- name: "@deepseek-ai/dsh-agent"',
    '- name: "@deepseek-ai/dsh-llm"',
    '- name: "@deepseek-ai/cordis-plugin-timer"',
    '- id: fake-connection',
    `  name: "${FAKE_CONNECTION_ENTRY}"`,
    '- id: memory-lite',
    '  name: "' + PLUGIN_ENTRY + '"',
    '  config:',
    '    root: ' + memoryRoot,
    '    defaultPeer: test-peer',
    '',
  ].join('\n'))
  return boot('dsh-reconcile-boot', configPath, [], undefined, PROJECT_ROOT)
}

function mockStreamText(text: string): AsyncIterable<any> {
  return (async function* () {
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10 } }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

const MERGE = '{"decision":"merge","path":"entities/cpa.md","content":"Google 池 = 0（2026-11-12）"}'

async function run(
  reconcileAnswer: string | undefined,
  extraction: MemoryConfig['extraction'] = {},
): Promise<{ calls: { system: string; user: string }[]; text: string; audit: any; log: any; index: string; tmp: string; cleanup: () => Promise<void> }> {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-reconcile-mem-'))
  const ctx = await bootCtx(tmp)
  const store = new MemoryStore(tmp)
  await store.writeNewMemory('test-peer', 'entities/cpa.md', 'CPA', 'port 8317\nGoogle 池 = 1')
  await store.refreshIndexEntry('test-peer', 'entities/cpa.md', 'CPA 反代手册')
  const calls: { system: string; user: string }[] = []
  ctx.on('llm/stream', (options: any) => {
    const system = String(options.system)
    const user = String(options.messages?.[0]?.content?.[0]?.text ?? '')
    calls.push({ system, user })
    if (system.includes('ONE existing memory file')) return mockStreamText(reconcileAnswer ?? '{"decision":"noop"}')
    return mockStreamText(MERGE)
  })
  const config = resolveConfig({ root: tmp, defaultPeer: 'test-peer', extraction: { messageScope: ['user', 'assistant', 'tool_result'], ...extraction } })
  await extractOnce(sessionLike('session-rec1', 30), { pending: 2, lastExtractAt: null, inFlight: true, checkpoint: { version: 1, checkpoint: { seq: 0 }, digest: '', audit: [] }, idleDispose: null, cancel: null }, ctx, { config: () => config, store }, new AbortController().signal, createStatusTracker())
  const base = join(tmp, 'peers', 'test-peer')
  const checkpoint = JSON.parse(await readFile(join(base, 'sessions', 'session-rec1.json'), 'utf8'))
  const log = JSON.parse((await readFile(join(base, 'sessions', 'extraction.log'), 'utf8')).trim().split('\n')[0]!)
  return {
    calls,
    text: await readFile(join(base, 'memories', 'entities', 'cpa.md'), 'utf8'),
    audit: checkpoint.audit[0],
    log,
    index: await readFile(join(base, 'memories', '_index.md'), 'utf8'),
    tmp,
    cleanup: async () => { await ctx.fiber.dispose(); await rm(tmp, { recursive: true, force: true }) },
  }
}

test('merge on an existing file runs a reconcile call that sees numbered lines and patches in place', async () => {
  const r = await run('{"decision":"patch","ops":[{"op":"replace","line":2,"content":"Google 池 = 0（2026-11-12）"}]}')
  try {
    assert.equal(r.calls.length, 2)
    assert.ok(r.calls[1]!.user.includes('1| - port 8317'))
    assert.ok(r.calls[1]!.user.includes('2| - Google 池 = 1'))
    assert.ok(r.calls[1]!.user.includes('Google 池 = 0（2026-11-12）'))
    assert.equal(parseMemoryFile(r.text).current, '- port 8317\n- Google 池 = 0（2026-11-12）')
    assert.equal(r.audit.decision, 'patch')
    assert.equal(r.audit.llmCalls, 2)
    assert.equal(r.audit.inputTokens, 200)
    assert.equal(r.log.outcome, 'patch')
    assert.match(r.index, /entities\/cpa\.md: CPA 反代手册/)
  } finally {
    await r.cleanup()
  }
})

test('reconcile noop leaves the file untouched and is recorded as noop', async () => {
  const r = await run('{"decision":"noop","reason":"already covered"}')
  try {
    assert.equal(parseMemoryFile(r.text).current, '- port 8317\n- Google 池 = 1')
    assert.equal(r.log.outcome, 'noop')
    assert.equal(r.audit.llmCalls, 2)
  } finally {
    await r.cleanup()
  }
})

test('an unparsable reconcile answer falls back to append and logs why', async () => {
  const r = await run('I would replace line two, honestly.')
  try {
    const current = parseMemoryFile(r.text).current
    assert.match(current, /- Google 池 = 1/)
    assert.match(current, /- Google 池 = 0（2026-11-12）/)
    assert.equal(r.audit.decision, 'merge')
    assert.match(r.audit.reconcileFallback, /parse-error/)
    assert.match(r.log.reconcileFallback, /parse-error/)
    assert.equal(r.log.outcome, 'merge')
    await access(join(r.tmp, 'peers', 'test-peer', 'sessions', 'failed-answers.log'), constants.F_OK)
  } finally {
    await r.cleanup()
  }
})

test('reconcile: false keeps the single-call append behaviour', async () => {
  const r = await run(undefined, { reconcile: false })
  try {
    assert.equal(r.calls.length, 1)
    assert.equal(parseMemoryFile(r.text).current, '- port 8317\n- Google 池 = 1\n- Google 池 = 0（2026-11-12）')
    assert.equal(r.audit.llmCalls, 1)
  } finally {
    await r.cleanup()
  }
})

test('a Current larger than reconcileMaxBytes skips the second call and appends', async () => {
  const r = await run(undefined, { reconcileMaxBytes: 10 })
  try {
    assert.equal(r.calls.length, 1)
    assert.equal(r.audit.reconcileFallback, 'current-too-large')
    assert.match(r.text, /Google 池 = 0（2026-11-12）/)
  } finally {
    await r.cleanup()
  }
})
