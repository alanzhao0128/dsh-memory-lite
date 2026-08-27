import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDecision, extractJsonObject, DECISION_KINDS } from '../src/extract/decision.js'

test('extractJsonObject finds the first balanced object', () => {
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}')
  assert.equal(extractJsonObject('prefix {"a": {"b": 2}} suffix'), '{"a": {"b": 2}}')
  assert.equal(extractJsonObject('{ "s": "a}b" }'), '{ "s": "a}b" }')
  assert.throws(() => extractJsonObject('no json here'))
})

test('extractJsonObject normalizes full-width braces and quotes', () => {
  assert.equal(extractJsonObject('｛"decision":"skip"｝'), '{"decision":"skip"}')
  assert.equal(extractJsonObject('\uFF02decision\uFF02: \uFF02skip\uFF02 in prose'), '{"decision":"skip"}')
})

test('extractJsonObject salvages broken-brace JSON from key:value pairs', () => {
  // Truncated before the closing brace: complete key:value pairs are rebuilt.
  assert.equal(
    extractJsonObject('{"decision":"create","category":"preferences","title":"pnpm","content":"use pnpm"'),
    '{"decision":"create","category":"preferences","title":"pnpm","content":"use pnpm"}',
  )
  assert.throws(() => extractJsonObject('only prose, no braces, no pairs'))
})

test('parseDecision accepts the four closed kinds', () => {
  assert.deepEqual(DECISION_KINDS, ['create', 'merge', 'update', 'skip'])
  assert.deepEqual(
    parseDecision('{"decision":"create","category":"preferences","title":"pnpm","content":"use pnpm"}'),
    { kind: 'create', category: 'preferences', title: 'pnpm', content: 'use pnpm' },
  )
  assert.deepEqual(
    parseDecision('{"decision":"merge","path":"preferences/tools.md","content":"podman"}'),
    { kind: 'merge', path: 'preferences/tools.md', content: 'podman' },
  )
  assert.deepEqual(
    parseDecision('{"decision":"update","path":"preferences/tools.md","content":"bun"}'),
    { kind: 'update', path: 'preferences/tools.md', content: 'bun' },
  )
  assert.deepEqual(parseDecision('{"decision":"skip","reason":"nothing new"}'), { kind: 'skip', reason: 'nothing new' })
  assert.deepEqual(parseDecision('{"decision":"skip"}'), { kind: 'skip' })
})

test('parseDecision tolerates fences and prose', () => {
  const fenced = [
    'Here is my answer:',
    '```json',
    '{"decision":"create","category":"entities","title":"proj","content":"react 18"}',
    '```',
  ].join('\n')
  assert.deepEqual(parseDecision(fenced), { kind: 'create', category: 'entities', title: 'proj', content: 'react 18' })
})

test('parseDecision tolerates full-width braces', () => {
  assert.deepEqual(
    parseDecision('｛"decision":"create","category":"entities","title":"proj","content":"react 18"｝'),
    { kind: 'create', category: 'entities', title: 'proj', content: 'react 18' },
  )
})

test('parseDecision rejects unknown kinds and missing fields', () => {
  assert.throws(() => parseDecision('{"decision":"delete","path":"a.md"}'), /one of create\/merge\/update\/skip/)
  assert.throws(() => parseDecision('{"decision":"create","category":"preferences"}'), /requires category, title, and content/)
  assert.throws(() => parseDecision('{"decision":"update","path":"a.md"}'), /requires path and content/)
  assert.throws(() => parseDecision('no json'), /contains no JSON/)
})
