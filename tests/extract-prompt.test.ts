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

test('buildExtractionUser includes digest, window, index and grep hits', () => {
  const user = buildExtractionUser('digest-text', 'window-text', [
    { path: 'entities/dsh-balance-monitor.md', summary: 'balance plugin' },
  ], [
    { path: 'preferences/tools.md', line: 'use pnpm' },
  ])
  assert.ok(user.includes('digest-text'))
  assert.ok(user.includes('window-text'))
  assert.ok(user.includes('entities/dsh-balance-monitor.md: balance plugin'))
  assert.ok(user.includes('preferences/tools.md: use pnpm'))
  assert.ok(user.includes('输出上面的 JSON 决策'))
  assert.ok(user.includes('STRICT OUTPUT RULES'))
})

test('buildExtractionUser omits digest when absent, index and hits when empty', () => {
  const noDigest = buildExtractionUser(undefined, 'w', [], [])
  assert.ok(!noDigest.includes('会话滚动摘要'))
  assert.ok(!noDigest.includes('记忆库现有文件'))
  assert.ok(!noDigest.includes('已存在的相关记忆'))
})

test('extractionSystem includes existing-memory merge rules', () => {
  const system = extractionSystem()
  assert.ok(system.includes('EXISTING MEMORY RULES'))
  assert.ok(system.includes('merge into that file instead of create'))
  assert.ok(system.includes('create only when no existing file covers the topic'))
})
