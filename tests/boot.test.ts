/**
 * REAL-composition smoke: boots a real cordis.yml through the Cordis Loader
 * (the same path the `dsh` app uses) with the services dsh-memory-lite
 * depends on, and asserts the five tools register. This is the closest an
 * out-of-repo plugin can get to the repo's REAL-composition gate.
 * @module dsh-memory-lite/tests/boot
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
// The Loader boots this plugin from its built artifact (as an installed
// consumer would), so the REAL-composition test requires a build first.
const PLUGIN_ENTRY = join(PROJECT_ROOT, 'lib', 'index.js')
/** Test double for the host 'connection' service the plugin injects. */
const FAKE_CONNECTION_ENTRY = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-connection.ts')

/** The rows both boot tests share; the plugin row loads the built lib. */
function configRows(memoryRoot: string, extra: string[] = []): string[] {
  // Scoped names are quoted: a bare `@` is a reserved YAML indicator.
  return [
    '- name: "@deepseek-ai/dsh-system-prompt"',
    '- name: "@deepseek-ai/dsh-tools"',
    '- name: "@deepseek-ai/dsh-agent"',
    '- name: "@deepseek-ai/dsh-llm"',
    '- name: "@deepseek-ai/cordis-plugin-timer"',
    '- id: fake-connection',
    `  name: "${FAKE_CONNECTION_ENTRY}"`,
    '- id: memory-lite',
    `  name: "${PLUGIN_ENTRY}"`,
    '  config:',
    `    root: ${memoryRoot}`,
    ...extra,
    '',
  ]
}

test('boots through the Loader and registers the five memory tools', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-boot-'))
  try {
    // This REAL-composition test boots the built plugin, so require the build.
    await access(PLUGIN_ENTRY, constants.F_OK)
    const configPath = join(cwd, 'cordis.yml')
    const memoryRoot = join(cwd, 'memory')
    await writeFile(configPath, configRows(memoryRoot, ['    defaultPeer: boot-test']).join('\n'))
    const ctx = await boot('dsh-memory-lite-test', configPath, [], undefined, PROJECT_ROOT)
    try {
      const tools = ctx.get('tools')
      assert.ok(tools, 'tools service mounted')
      for (const name of ['read_memory', 'search_memory', 'remember', 'update_memory', 'forget_memory']) {
        const tool = tools.get(name)
        assert.ok(tool, `expected tool ${name}`)
        assert.equal(tool.name, name)
      }
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('misconfigured plugin fails loud at boot', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-memory-boot-'))
  try {
    const configPath = join(cwd, 'cordis.yml')
    await writeFile(configPath, configRows(join(cwd, 'memory'), ['    defaultPeer: "a/b"']).join('\n'))
    // Misconfiguration must fail the boot loudly (the Loader wraps the
    // plugin's thrown error, so assert the rejection, not its exact wording).
    await assert.rejects(() => boot('dsh-memory-lite-test', configPath, [], undefined, PROJECT_ROOT))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
