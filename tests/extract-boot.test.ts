/**
 * REAL-composition integration for the Phase 2 extraction executor: boots the
 * built plugin through the Loader, mocks `llm/stream`, drives extractOnce with
 * a structural session, and asserts the memory file, index, and checkpoint.
 * @module dsh-memory-lite/tests/extract-boot
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { MemoryStore } from '../src/memory-store.js'
import { resolveConfig } from '../src/config.js'
import { extractOnce, type ExtractionSessionLike } from '../src/extract/index.js'
import { createStatusTracker } from '../src/status.js'
import { FakeConnectionService } from './fixtures/fake-connection.js'

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const PLUGIN_ENTRY = join(PROJECT_ROOT, 'lib', 'index.js')
const FAKE_CONNECTION_ENTRY = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-connection.ts')

function sessionLike(id: string, seq: number): ExtractionSessionLike {
  return {
    id,
    // No cwd: the peer falls back to defaultPeer (test-peer) for deterministic paths.
    header: {},
    events: [
      { type: 'user/message', seq: seq - 2, data: { content: [{ type: 'text', text: '我用 pnpm 管理依赖' }], role: 'user', id: 'u1', source: { kind: 'user' } } },
      { type: 'assistant/message', seq: seq - 1, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，已了解。' }], source: { kind: 'model' } } } },
      { type: 'tool/result', seq, data: { message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }], isError: false }], source: { kind: 'tool' } } } },
    ],
    requestHeader: () => ({ config: { provider: 'huoshan', model: 'deepseek-v4-flash' } }),
  }
}

/** Drive one registered fetch route as the browser rpc.call would. */
async function callRpc(conn: FakeConnectionService, endpoint: string, payload: unknown): Promise<any> {
  const route = conn.fetchRoutes.get('/api/' + endpoint)
  assert.ok(route, 'memory-lite registered /api/' + endpoint)
  const response = await route!.fetch(new Request('http://host/api/' + endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'test-rpc', method: endpoint, payload }),
  }))
  const body = await response.json() as { result: unknown }
  return body.result
}
async function bootCtx(memoryRoot: string): Promise<Awaited<ReturnType<typeof boot>>> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-extract-boot-'))
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
    '    extraction:',
    '      windowTurns: 20',
    '',
  ].join('\n'))
  return boot('dsh-extract-boot', configPath, [], undefined, PROJECT_ROOT)
}

/** Mock llm/stream to emit an optional usage chunk, text, then a stop finish. */
function mockStreamText(text: string, usage?: { inputTokens: number; outputTokens: number }): AsyncIterable<any> {
  return (async function* () {
    if (usage !== undefined) yield { type: 'usage', usage }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })()
}

test('extractOnce writes a create decision, index, and checkpoint through a mocked llm', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    ctx.on('llm/stream', () => mockStreamText(
      '{"decision":"create","category":"preferences","title":"pnpm","content":"用户使用 pnpm 作为包管理器"}',
      { inputTokens: 1234, outputTokens: 42 },
    ))
    const store = new MemoryStore(tmp)
    const config = resolveConfig({ root: tmp, defaultPeer: 'test-peer', extraction: { messageScope: ['user', 'assistant', 'tool_result'] } })
    const session = sessionLike('session-abc123', 30)
    await extractOnce(session, { pending: 3, lastExtractAt: null, inFlight: true, checkpoint: { version: 1, checkpoint: { seq: 0 }, digest: '', audit: [] }, idleDispose: null, cancel: null }, ctx, { config: () => config, store }, new AbortController().signal, createStatusTracker())

    const memoryPath = join(tmp, 'peers', 'test-peer', 'memories', 'preferences', 'pnpm.md')
    const memory = await readFile(memoryPath, 'utf8')
    assert.match(memory, /# pnpm/)
    assert.match(memory, /## Current/)
    assert.match(memory, /用户使用 pnpm/)

    const index = await readFile(join(tmp, 'peers', 'test-peer', 'memories', '_index.md'), 'utf8')
    assert.match(index, /preferences\/pnpm\.md/)

    const checkpointText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'session-abc123.json'), 'utf8')
    const checkpoint = JSON.parse(checkpointText)
    assert.equal(checkpoint.checkpoint.seq, 30)
    assert.equal(checkpoint.audit.length, 1)
    assert.equal(checkpoint.audit[0].decision, 'create')
    assert.deepEqual(checkpoint.audit[0].route, { provider: 'huoshan', model: 'deepseek-v4-flash' })
    // Per-run metrics: real usage from the stream, one call, a wall-clock duration.
    assert.equal(checkpoint.audit[0].llmCalls, 1)
    assert.equal(checkpoint.audit[0].inputTokens, 1234)
    assert.equal(checkpoint.audit[0].outputTokens, 42)
    assert.ok(typeof checkpoint.audit[0].durationMs === 'number' && checkpoint.audit[0].durationMs >= 0)

    // Peer-level summary log records the same run as one JSON line.
    const logText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'extraction.log'), 'utf8')
    const logLine = JSON.parse(logText.trim().split('\n')[0])
    assert.equal(logLine.session, 'session-abc123')
    assert.equal(logLine.outcome, 'create')
    assert.equal(logLine.decision, 'create')
    assert.equal(logLine.llmCalls, 1)
    assert.equal(logLine.inputTokens, 1234)
    assert.equal(logLine.outputTokens, 42)
    assert.deepEqual(logLine.route, { provider: 'huoshan', model: 'deepseek-v4-flash' })
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('extractOnce recovers a prose answer via one bounded repair call', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    let calls = 0
    ctx.on('llm/stream', () => {
      calls += 1
      return calls === 1
        ? mockStreamText('I think Alan uses pnpm as his package manager. Decision: create a preferences memory.')
        : mockStreamText('{"decision":"create","category":"preferences","title":"pnpm","content":"用户使用 pnpm"}')
    })
    const store = new MemoryStore(tmp)
    const config = resolveConfig({ root: tmp, defaultPeer: 'test-peer', extraction: { messageScope: ['user', 'assistant', 'tool_result'] } })
    const session = sessionLike('session-abc789', 30)
    await extractOnce(session, { pending: 3, lastExtractAt: null, inFlight: true, checkpoint: { version: 1, checkpoint: { seq: 0 }, digest: '', audit: [] }, idleDispose: null, cancel: null }, ctx, { config: () => config, store }, new AbortController().signal, createStatusTracker())

    // One repair call on top of the original call; the memory is written.
    assert.equal(calls, 2)
    await access(join(tmp, 'peers', 'test-peer', 'memories', 'preferences', 'pnpm.md'), constants.F_OK)
    const checkpointText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'session-abc789.json'), 'utf8')
    const checkpoint = JSON.parse(checkpointText)
    assert.equal(checkpoint.audit[0].decision, 'create')
    assert.equal(checkpoint.audit[0].note, 'parse-error-recovered')
    assert.equal(checkpoint.audit[0].llmCalls, 2)
    const logText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'extraction.log'), 'utf8')
    const logLine = JSON.parse(logText.trim().split('\n')[0])
    assert.equal(logLine.outcome, 'parse-error-recovered')
    assert.equal(logLine.decision, 'create')
    assert.equal(logLine.llmCalls, 2)
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('extractOnce records a parse-error audit and advances the checkpoint', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    ctx.on('llm/stream', () => mockStreamText('not json at all'))
    const store = new MemoryStore(tmp)
    const config = resolveConfig({ root: tmp, defaultPeer: 'test-peer', extraction: { messageScope: ['user', 'assistant', 'tool_result'] } })
    const session = sessionLike('session-abc456', 30)
    await extractOnce(session, { pending: 3, lastExtractAt: null, inFlight: true, checkpoint: { version: 1, checkpoint: { seq: 0 }, digest: '', audit: [] }, idleDispose: null, cancel: null }, ctx, { config: () => config, store }, new AbortController().signal, createStatusTracker())

    const checkpointText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'session-abc456.json'), 'utf8')
    const checkpoint = JSON.parse(checkpointText)
    assert.equal(checkpoint.checkpoint.seq, 30)
    assert.match(checkpoint.audit[0].note, /parse-error/)
    // Main call + one bounded repair call both failed to parse.
    assert.equal(checkpoint.audit[0].llmCalls, 2)
    assert.ok(checkpoint.audit[0].inputTokens > 0)
    // No memory file was written.
    await assert.rejects(() => access(join(tmp, 'peers', 'test-peer', 'memories', 'preferences', 'pnpm.md'), constants.F_OK))
    const logText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'extraction.log'), 'utf8')
    const logLine = JSON.parse(logText.trim().split('\n')[0])
    assert.equal(logLine.outcome, 'parse-error')
    assert.equal(logLine.llmCalls, 2)
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('session/event window trigger fires extraction through the plugin listener (timer inject)', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    ctx.on('llm/stream', () => mockStreamText('{"decision":"skip"}', { inputTokens: 5, outputTokens: 3 }))
    // A live-ish session: 20 surface events in the log; no cwd -> defaultPeer test-peer.
    const events: any[] = []
    for (let i = 0; i < 20; i++) {
      events.push({ type: 'user/message', seq: i, data: { content: [{ type: 'text', text: 'msg ' + i }], role: 'user', id: 'u' + i, source: { kind: 'user' } } })
    }
    const session = {
      id: 'session-listener-test',
      header: {},
      events,
      requestHeader: () => ({ config: { provider: 'huoshan', model: 'deepseek-v4-flash' } }),
    }
    // Replay the events through the session/event firehose: the plugin listener
    // must bump pending and schedule an extraction on the 20th (which exercises
    // resetIdle -> ctx.timeout, i.e. the 'timer' inject that was previously missing).
    for (let i = 0; i < 20; i++) ctx.emit('session/event', session, events[i])
    await new Promise((resolve) => setTimeout(resolve, 300))
    const checkpointText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'session-listener-test.json'), 'utf8')
    const checkpoint = JSON.parse(checkpointText)
    assert.equal(checkpoint.checkpoint.seq, 19)
    assert.equal(checkpoint.audit.length, 1)
    assert.equal(checkpoint.audit[0].decision, 'skip')
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('/memory-status RPC channel serves the tracker snapshot', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    const conn = ctx.get('connection') as FakeConnectionService
    const result = await callRpc(conn, 'memory-status/snapshot', {}) as {
      ok: boolean
      value: { mode: string; status: string; last: unknown }
    }
    assert.equal(result.ok, true)
    assert.equal(result.value.mode, 'incremental')
    // Fresh tracker in the booted plugin: no data yet = ok (green).
    assert.equal(result.value.status, 'ok')
    assert.equal(result.value.last, null)
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('/memory-peers RPC channel lists peers and configured mounts', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  // Seed two peer directories so the RPC has something to list.
  await mkdir(join(tmp, 'peers', 'alpha-12345678', 'memories'), { recursive: true })
  await mkdir(join(tmp, 'peers', 'beta-87654321', 'memories'), { recursive: true })
  const ctx = await bootCtx(tmp)
  try {
    const conn = ctx.get('connection') as FakeConnectionService
    const result = await callRpc(conn, 'memory-peers/snapshot', {}) as {
      ok: boolean
      value: { peers: Array<{ name: string; displayName: string }>; mounts: Array<{ name: string; peer: string; subpath: string; readonly: boolean }> }
    }
    assert.equal(result.ok, true)
    const peers = result.value.peers.map(p => p.name)
    assert.ok(peers.includes('alpha-12345678'), 'lists alpha peer: ' + peers.join(','))
    assert.ok(peers.includes('beta-87654321'), 'lists beta peer: ' + peers.join(','))
    // displayName defaults to the storage name when no .peer-meta.json exists.
    const alpha = result.value.peers.find(p => p.name === 'alpha-12345678')!
    assert.equal(alpha.displayName, 'alpha-12345678')
    // No mounts configured in the boot row config -> empty mounts list.
    assert.deepEqual(result.value.mounts, [])
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})




test('/memory-status fetch route rejects bad requests like the official rpcFetchHandler', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-err-'))
  const ctx = await bootCtx(tmp)
  try {
    const conn = ctx.get('connection') as FakeConnectionService
    const route = conn.fetchRoutes.get('/api/memory-status/snapshot')
    assert.ok(route, 'memory-lite registered the /api/memory-status/snapshot route')
    // Non-POST -> 404 (official behavior).
    const notPost = await route!.fetch(new Request('http://host/api/memory-status/snapshot', { method: 'GET' }))
    assert.equal(notPost.status, 404)
    // Wrong content-type -> 415 (official behavior).
    const badMedia = await route!.fetch(new Request('http://host/api/memory-status/snapshot', {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
    }))
    assert.equal(badMedia.status, 415)
    // Body is not JSON -> 400.
    const badBody = await route!.fetch(new Request('http://host/api/memory-status/snapshot', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json',
    }))
    assert.equal(badBody.status, 400)
    // Malformed envelope -> 400 + gateway/bad-request.
    const badEnvelope = await route!.fetch(new Request('http://host/api/memory-status/snapshot', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'nope', rpcId: 7 }),
    }))
    assert.equal(badEnvelope.status, 400)
    const envelopeBody = await badEnvelope.json() as { result: { ok: boolean; error: { code: string } } }
    assert.equal(envelopeBody.result.ok, false)
    assert.equal(envelopeBody.result.error.code, 'gateway/bad-request')
    // Method mismatch -> 400 (official behavior).
    const badMethod = await route!.fetch(new Request('http://host/api/memory-status/snapshot', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'r1', method: 'memory-other/snapshot', payload: {} }),
    }))
    assert.equal(badMethod.status, 400)
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('extractOnce uses the global default model when route is unset (§17)', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    ctx.on('llm/stream', () => mockStreamText('{"decision":"create","category":"preferences","title":"pnpm","content":"用户使用 pnpm"}'))
    const store = new MemoryStore(tmp)
    const config = resolveConfig({ root: tmp, defaultPeer: 'test-peer', extraction: { messageScope: ['user', 'assistant', 'tool_result'] } })
    const session = sessionLike('session-global-default', 30)
    // No extraction.llm.route; deps.defaultModel supplies the global default.
    const defaultModel = () => ({ provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
    await extractOnce(
      session,
      { pending: 3, lastExtractAt: null, inFlight: true, checkpoint: { version: 1, checkpoint: { seq: 0 }, digest: '', audit: [] }, idleDispose: null, cancel: null },
      ctx,
      { config: () => config, store, defaultModel },
      new AbortController().signal,
      createStatusTracker(),
    )

    const checkpointText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'session-global-default.json'), 'utf8')
    const checkpoint = JSON.parse(checkpointText)
    assert.deepEqual(checkpoint.audit[0].route, { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' })
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('extractOnce prefers an explicit route over the global default and passes the effort (§17)', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    ctx.on('llm/stream', () => mockStreamText('{"decision":"skip"}'))
    const store = new MemoryStore(tmp)
    // Route configured: fixed, ignores the global default.
    const config = resolveConfig({
      root: tmp,
      defaultPeer: 'test-peer',
      extraction: { llm: { route: 'huoshan/deepseek-v4-flash', reasoningEffort: 'high' } },
    })
    const session = sessionLike('session-explicit-route', 30)
    const defaultModel = () => ({ provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
    await extractOnce(
      session,
      { pending: 3, lastExtractAt: null, inFlight: true, checkpoint: { version: 1, checkpoint: { seq: 0 }, digest: '', audit: [] }, idleDispose: null, cancel: null },
      ctx,
      { config: () => config, store, defaultModel },
      new AbortController().signal,
      createStatusTracker(),
    )

    const checkpointText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'session-explicit-route.json'), 'utf8')
    const checkpoint = JSON.parse(checkpointText)
    assert.deepEqual(checkpoint.audit[0].route, { provider: 'huoshan', model: 'deepseek-v4-flash', reasoningEffort: 'high' })
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})

test('extractOnce falls back to the session header when no route and no global default (§17)', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    ctx.on('llm/stream', () => mockStreamText('{"decision":"skip"}'))
    const store = new MemoryStore(tmp)
    const config = resolveConfig({ root: tmp, defaultPeer: 'test-peer', extraction: { messageScope: ['user', 'assistant', 'tool_result'] } })
    const session = sessionLike('session-header-fallback', 30)
    // defaultModel returns empty (e.g. service absent) -> falls back to requestHeader.
    const defaultModel = () => ({ provider: '', model: '' })
    await extractOnce(
      session,
      { pending: 3, lastExtractAt: null, inFlight: true, checkpoint: { version: 1, checkpoint: { seq: 0 }, digest: '', audit: [] }, idleDispose: null, cancel: null },
      ctx,
      { config: () => config, store, defaultModel },
      new AbortController().signal,
      createStatusTracker(),
    )

    const checkpointText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'session-header-fallback.json'), 'utf8')
    const checkpoint = JSON.parse(checkpointText)
    assert.deepEqual(checkpoint.audit[0].route, { provider: 'huoshan', model: 'deepseek-v4-flash' })
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})


test('extractOnce splits a route whose model id contains a slash (§17, pi-ai style)', async () => {
  await access(PLUGIN_ENTRY, constants.F_OK)
  const tmp = await mkdtemp(join(tmpdir(), 'dsh-extract-mem-'))
  const ctx = await bootCtx(tmp)
  try {
    ctx.on('llm/stream', () => mockStreamText('{"decision":"skip"}'))
    const store = new MemoryStore(tmp)
    // commandcode provider, model id "deepseek/deepseek-v4-flash" — the provider is the
    // first segment, the model is everything after it.
    const config = resolveConfig({
      root: tmp,
      defaultPeer: 'test-peer',
      extraction: { llm: { route: 'commandcode/deepseek/deepseek-v4-flash', reasoningEffort: 'high' } },
    })
    const session = sessionLike('session-slash-route', 30)
    await extractOnce(
      session,
      { pending: 3, lastExtractAt: null, inFlight: true, checkpoint: { version: 1, checkpoint: { seq: 0 }, digest: '', audit: [] }, idleDispose: null, cancel: null },
      ctx,
      { config: () => config, store },
      new AbortController().signal,
      createStatusTracker(),
    )
    const checkpointText = await readFile(join(tmp, 'peers', 'test-peer', 'sessions', 'session-slash-route.json'), 'utf8')
    const checkpoint = JSON.parse(checkpointText)
    assert.deepEqual(checkpoint.audit[0].route, { provider: 'commandcode', model: 'deepseek/deepseek-v4-flash', reasoningEffort: 'high' })
  } finally {
    await ctx.fiber.dispose()
    await rm(tmp, { recursive: true, force: true })
  }
})
