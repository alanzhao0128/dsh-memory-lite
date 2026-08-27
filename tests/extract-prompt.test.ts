import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractionSystem, buildExtractionUser } from '../src/extract/prompt.js'

test('extractionSystem lists the closed decision vocabulary', () => {
  const system = extractionSystem()
  for (const kind of ['create', 'merge', 'update', 'skip']) assert.ok(system.includes(kind))
  assert.ok(system.includes('JSON'))
})

test('extractionSystem enforces strict JSON-only output', () => {
  const system = extractionSystem()
  assert.ok(system.includes('STRICT OUTPUT RULES'))
  assert.ok(system.includes('exactly one JSON object'))
  assert.ok(system.includes('No prose'))
  assert.ok(system.includes('code fences'))
  assert.ok(system.includes('half-width braces'))
})

test('buildExtractionUser includes digest, window and grep hits', () => {
  const user = buildExtractionUser('digest-text', 'window-text', [
    { path: 'preferences/tools.md', line: 'use pnpm' },
  ])
  assert.ok(user.includes('digest-text'))
  assert.ok(user.includes('window-text'))
  assert.ok(user.includes('preferences/tools.md: use pnpm'))
  assert.ok(user.includes('输出上面的 JSON 决策'))
  assert.ok(user.includes('STRICT OUTPUT RULES'))
})

test('buildExtractionUser omits digest when absent and hits when empty', () => {
  const noDigest = buildExtractionUser(undefined, 'w', [])
  assert.ok(!noDigest.includes('会话滚动摘要'))
  assert.ok(!noDigest.includes('已存在的相关记忆'))
})
