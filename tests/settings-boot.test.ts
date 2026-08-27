/**
 * REAL-composition smoke for the settings-backed config source (方案 A §16):
 * boots dsh-memory-lite with fake connection + fake settings services, then
 * simulates a user edit through the settings namespace and asserts the change
 * takes effect live — while root/sharing stay pinned to the store snapshot
 * (restart-applies semantics).
 * @module dsh-memory-lite/tests/settings-boot
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '@deepseek-ai/dsh-app-boot'
import type { FakeSettingsProvider } from './fixtures/fake-settings.js'

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const PLUGIN_ENTRY = join(PROJECT_ROOT, 'lib', 'index.js')
const FAKE_CONNECTION_ENTRY = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-connection.ts')
const FAKE_SETTINGS_ENTRY = join(PROJECT_ROOT, 'tests', 'fixtures', 'fake-settings.ts')

test('settings edits apply live to extraction.mode but root/sharing stay pinned', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-settings-boot-'))
  try {
    await access(PLUGIN_ENTRY, constants.F_OK)
    const memoryRoot = join(cwd, 'memory')
    const configPath = join(cwd, 'cordis.yml')
    await writeFile(configPath, [
      '- name: "@deepseek-ai/dsh-system-prompt"',
      '- name: "@deepseek-ai/dsh-tools"',
      '- name: "@deepseek-ai/dsh-agent"',
      '- name: "@deepseek-ai/dsh-llm"',
      '- name: "@deepseek-ai/cordis-plugin-timer"',
      '- id: fake-connection',
      `  name: "${FAKE_CONNECTION_ENTRY}"`,
      '- id: fake-settings',
      `  name: "${FAKE_SETTINGS_ENTRY}"`,
      '- id: memory-lite',
      `  name: "${PLUGIN_ENTRY}"`,
      '  config:',
      `    root: ${memoryRoot}`,
      '    defaultPeer: boot-test',
      '',
    ].join('\n'))
    const ctx = await boot('dsh-memory-lite-settings-test', configPath, [], undefined, PROJECT_ROOT)
    try {
      const connection = ctx.get('connection') as { handlers: Map<string, (e: unknown, p: unknown, s: unknown) => Promise<unknown>> }
      const settings = ctx.get('settings') as FakeSettingsProvider

      // Baseline: incremental mode.
      const statusHandler = connection.handlers.get('/memory-status')!
      const before = await statusHandler(undefined, undefined, undefined) as { value: { mode: string } }
      assert.equal(before.value.mode, 'incremental')

      // Simulate a user edit in the settings panel: mode -> off.
      await settings.update('dsh-memory-lite', { extraction: { mode: 'off' } })

      // The RPC handler reads the live config, so the mode flips without a restart.
      const after = await statusHandler(undefined, undefined, undefined) as { value: { mode: string } }
      assert.equal(after.value.mode, 'off')

      // The user edit persisted into the fake document.
      const section = settings.sections.get('dsh-memory-lite')
      assert.deepEqual(section?.extraction, { mode: 'off' })

      // root/sharing are restart-applies: editing them in settings must NOT
      // move the live config (the store snapshot stays authoritative).
      await settings.update('dsh-memory-lite', { root: join(cwd, 'other-root') })
      const afterRoot = await statusHandler(undefined, undefined, undefined) as { value: { mode: string } }
      assert.equal(afterRoot.value.mode, 'off', 'root edit must not disturb live config')
      const section2 = settings.sections.get('dsh-memory-lite')
      assert.equal(section2?.root, join(cwd, 'other-root'), 'root edit persisted for the next restart')
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a pre-seeded settings document is the config source when the row config is empty', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-settings-seed-'))
  try {
    await access(PLUGIN_ENTRY, constants.F_OK)
    const memoryRoot = join(cwd, 'memory')
    const configPath = join(cwd, 'cordis.yml')
    // No config on the plugin row (migration shape): settings carry everything.
    await writeFile(configPath, [
      '- name: "@deepseek-ai/dsh-system-prompt"',
      '- name: "@deepseek-ai/dsh-tools"',
      '- name: "@deepseek-ai/dsh-agent"',
      '- name: "@deepseek-ai/dsh-llm"',
      '- name: "@deepseek-ai/cordis-plugin-timer"',
      '- id: fake-connection',
      `  name: "${FAKE_CONNECTION_ENTRY}"`,
      '- id: fake-settings',
      `  name: "${FAKE_SETTINGS_ENTRY}"`,
      '  config:',
      '    seed:',
      '      dsh-memory-lite:',
      '        root: ' + JSON.stringify(memoryRoot),
      '        extraction:',
      '          mode: explicit_only',
      '',
      '- id: memory-lite',
      `  name: "${PLUGIN_ENTRY}"`,
      '',
    ].join("\n"))
    const ctx = await boot('dsh-memory-lite-seed-test', configPath, [], undefined, PROJECT_ROOT)
    try {
      const connection = ctx.get('connection') as { handlers: Map<string, (e: unknown, p: unknown, s: unknown) => Promise<unknown>> }
      const statusHandler = connection.handlers.get('/memory-status')!
      // The seeded settings value (explicit_only) wins over the schema default
      // (incremental) because the row config carries nothing.
      const snap = await statusHandler(undefined, undefined, undefined) as { value: { mode: string } }
      assert.equal(snap.value.mode, 'explicit_only')
    } finally {
      await ctx.fiber.dispose()
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

