/**
 * Unit tests for the memory health tracker (sidebar indicator v1).
 * @module dsh-memory-lite/tests/status
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createStatusTracker } from '../src/status.js'

test('no data yet is ok (green) under incremental mode', () => {
  const t = createStatusTracker()
  assert.deepEqual(t.snapshot('incremental'), { mode: 'incremental', last: null, status: 'ok' })
})

test('a successful run is ok (green)', () => {
  const t = createStatusTracker()
  t.reportRun('skip', null, 'skip')
  const s = t.snapshot('incremental')
  assert.equal(s.status, 'ok')
  assert.equal(s.last!.outcome, 'skip')
  assert.equal(s.last!.ok, true)
})

test('a failed run is error (red)', () => {
  const t = createStatusTracker()
  t.reportRun('llm-error', 'llm-error: 429 rate limited', undefined)
  const s = t.snapshot('incremental')
  assert.equal(s.status, 'error')
  assert.equal(s.last!.ok, false)
  assert.match(s.last!.note ?? '', /429/)
})

test('red clears on the next successful run (no time magic)', () => {
  const t = createStatusTracker()
  t.reportRun('llm-error', 'llm-error: network', undefined)
  assert.equal(t.snapshot('incremental').status, 'error')
  t.reportRun('create', null, 'create')
  assert.equal(t.snapshot('incremental').status, 'ok')
})

test('parse-error-recovered counts as ok (self-healed)', () => {
  const t = createStatusTracker()
  t.reportRun('parse-error-recovered', 'parse-error-recovered', 'skip')
  assert.equal(t.snapshot('incremental').status, 'ok')
})

test('unexpected exceptions (reportError) are error (red)', () => {
  const t = createStatusTracker()
  t.reportError('cannot get property "timer" without inject')
  const s = t.snapshot('incremental')
  assert.equal(s.status, 'error')
  assert.equal(s.last!.outcome, 'error')
  assert.match(s.last!.note ?? '', /timer/)
})

test('mode off or explicit_only is disabled (gray) regardless of runs', () => {
  const t = createStatusTracker()
  t.reportRun('create', null, 'create')
  assert.equal(t.snapshot('off').status, 'disabled')
  assert.equal(t.snapshot('explicit_only').status, 'disabled')
})
