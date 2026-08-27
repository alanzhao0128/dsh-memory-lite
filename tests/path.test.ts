import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { containWithin, MemoryPathError } from '../src/path.js'

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-mem-path-'))
  await mkdir(join(root, 'preferences'), { recursive: true })
  await writeFile(join(root, 'preferences', 'coding.md'), 'content')
  return root
}

test('accepts a normal relative path inside the root', async () => {
  const root = await makeRoot()
  try {
    assert.equal(await containWithin(root, 'preferences/coding.md'), join(await realpath(root), 'preferences', 'coding.md'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects absolute paths at the boundary, not in the description', async () => {
  const root = await makeRoot()
  try {
    await assert.rejects(() => containWithin(root, '/etc/passwd'), MemoryPathError)
    await assert.rejects(() => containWithin(root, 'preferences/../..//etc/passwd'), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects .. escapes', async () => {
  const root = await makeRoot()
  try {
    await assert.rejects(() => containWithin(root, '../../etc/passwd'), MemoryPathError)
    await assert.rejects(() => containWithin(root, 'preferences/../../../tmp/x'), MemoryPathError)
    await assert.rejects(() => containWithin(root, '..'), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects empty and directory-shaped paths', async () => {
  const root = await makeRoot()
  try {
    await assert.rejects(() => containWithin(root, ''), MemoryPathError)
    await assert.rejects(() => containWithin(root, 'preferences/'), MemoryPathError)
    await assert.rejects(() => containWithin(root, '.'), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('rejects symlink escapes (executor-level enforcement)', async () => {
  const root = await makeRoot()
  const outside = await mkdtemp(join(tmpdir(), 'dsh-mem-outside-'))
  try {
    await writeFile(join(outside, 'secret.md'), 'secret')
    await symlink(outside, join(root, 'link'))
    await assert.rejects(() => containWithin(root, 'link/secret.md'), MemoryPathError)
    // A nested symlink inside a legit directory is equally rejected.
    await mkdir(join(root, 'entities'))
    await symlink(outside, join(root, 'entities', 'escape'))
    await assert.rejects(() => containWithin(root, 'entities/escape/secret.md'), MemoryPathError)
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
