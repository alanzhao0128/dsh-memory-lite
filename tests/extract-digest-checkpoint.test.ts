import { test } from 'node:test'
import assert from 'node:assert/strict'
import { digestApproxTokens, truncateDigest, rollDigest } from '../src/extract/digest.js'
import { emptyCheckpoint, withRun, renderCheckpoint, parseCheckpoint, CHECKPOINT_VERSION } from '../src/extract/checkpoint.js'

test('digest token estimate and truncation are bounded', () => {
  assert.ok(digestApproxTokens('hello') >= 1)
  // 100 CJK chars ≈ 100 * 3 bytes / 3 = 100 tokens.
  const cjk = '中'.repeat(100)
  assert.equal(digestApproxTokens(cjk), 100)
  const long = 'a'.repeat(10_000)
  const capped = truncateDigest(long, 100)
  assert.ok(digestApproxTokens(capped) <= 100)
  assert.ok(capped.length < long.length)
  assert.equal(truncateDigest('', 100), '')
})

test('rollDigest folds the window into the running summary', () => {
  const rolled = rollDigest('prev summary', 'new window text', 1000)
  assert.ok(rolled.includes('prev summary'))
  assert.ok(rolled.includes('new window text'))
  // heavy window still bounded
  const bounded = rollDigest('prev', 'x'.repeat(50_000), 100)
  assert.ok(digestApproxTokens(bounded) <= 100)
})

test('checkpoint round-trips and tolerates malformed input', () => {
  const state = emptyCheckpoint()
  assert.equal(state.checkpoint.seq, 0)
  assert.equal(state.version, CHECKPOINT_VERSION)
  const next = withRun(state, 42, {
    at: '2026-08-25T03:00:00.000Z',
    windowSeq: [10, 42],
    grepHits: ['preferences/tools.md: use pnpm'],
    route: { provider: 'huoshan', model: 'deepseek-v4-flash' },
    maxTokens: 1024,
    decision: 'update',
    path: 'preferences/tools.md',
  })
  assert.equal(next.checkpoint.seq, 42)
  assert.equal(next.audit.length, 1)
  const parsed = parseCheckpoint(renderCheckpoint(next))
  assert.deepEqual(parsed, next)
  // malformed degrades to empty
  assert.deepEqual(parseCheckpoint('not json'), emptyCheckpoint())
  assert.deepEqual(parseCheckpoint('{"checkpoint":{"seq":"bad"}}'), emptyCheckpoint())
})

test('audit is capped at MAX_AUDIT_ENTRIES', async () => {
  const { MAX_AUDIT_ENTRIES } = await import('../src/extract/checkpoint.js')
  let state = emptyCheckpoint()
  for (let i = 1; i <= MAX_AUDIT_ENTRIES + 10; i += 1) {
    state = withRun(state, i, { at: 't', windowSeq: [0, i], grepHits: [], decision: 'skip' })
  }
  assert.ok(state.audit.length <= MAX_AUDIT_ENTRIES)
  assert.equal(state.checkpoint.seq, MAX_AUDIT_ENTRIES + 10)
})
