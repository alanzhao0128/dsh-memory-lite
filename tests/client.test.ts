/**
 * Regression tests for the browser half (lib/client.js): it must evaluate as a
 * classic-script under the ModuleLoader contract (declares module/exports —
 * a missing shell previously broke startup with "exports is not defined"),
 * return a plugin with apply/inject, and register both the header indicator
 * (conversation.session.header.utilities) and the settings page
 * (settings.section) with the settingsScope service bound.
 * @module dsh-memory-lite/tests/client
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = resolve(fileURLToPath(import.meta.url), '../..')
const CLIENT_ENTRY = join(PROJECT_ROOT, 'lib', 'client.js')

interface ModuleLoaderEntry { id: string; factory: (require: (name: string) => unknown) => unknown }
interface SlotEntry { name: string; id: string; order?: number; component: unknown }

function loadClient(): ModuleLoaderEntry {
  let registered: ModuleLoaderEntry | null = null
  ;(globalThis as Record<string, unknown>).window = {
    __ModuleLoader__: { load: (entry: ModuleLoaderEntry) => { registered = entry } },
  }
  ;(globalThis as Record<string, unknown>).document = {
    addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible',
  }
  const src = readFileSync(CLIENT_ENTRY, 'utf8')
  // Evaluate in this context (module-scope eval: indirect eval keeps globals).
  // eslint-disable-next-line no-eval
  ;(0, eval)(src)
  assert.ok(registered, 'client.js must register a module-loader entry')
  return registered!
}

const reactStub = {
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: unknown) => fn,
  useState: (v: unknown) => [v, () => {}],
}
const jsxStub = { jsx: (_t: unknown, p: unknown) => ({ p }), jsxs: (_t: unknown, p: unknown) => ({ p }) }
const fakeRequire = (name: string): unknown => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return jsxStub
  throw new Error('unexpected require: ' + name)
}

/** Fake settingsScope: bind returns a scope whose snapshot is empty/ready. */
const fakeScope = {
  getSnapshot: () => ({ status: 'ready', value: {}, base: undefined, user: undefined, revision: 1, writable: true, mode: 'host' }),
  subscribe: () => () => {},
  set: async () => {}, unset: async () => {},
}

function applyWith(): { entries: SlotEntry[]; inject: string[] } {
  const { factory } = loadClient()
  const plugin = factory(fakeRequire) as { apply: (ctx: unknown, config: unknown) => void; inject: string[] }
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['connection', 'slots', 'settingsScope'])
  const entries: SlotEntry[] = []
  const fakeCtx = {
    get: (name: string) => {
      if (name === 'connection') return {
        rpc: { call: async () => ({ ok: true, value: null }) },
        api: {
          settings: { mutate: async () => ({ result: { ok: true } }) },
          llm: { models: async () => ({ result: { ok: true, value: { groups: [], failures: [] } } }) },
        },
      }
      if (name === 'settingsScope') return { bind: () => fakeScope }
      return null
    },
    slots: {
      inject: (_name: string, fn: () => unknown) => { entries.push(fn() as SlotEntry) },
      register: (opts: SlotEntry, component: unknown) => ({ ...opts, component }),
    },
  }
  plugin.apply(fakeCtx, {})
  assert.ok(entries.length >= 2, 'apply must register both slots')
  return { entries, inject: plugin.inject }
}

test('client.js evaluates and registers the header indicator + settings page', () => {
  const { entries } = applyWith()
  const header = entries.find(e => e.name === 'conversation.session.header.utilities')
  assert.ok(header, 'header indicator entry registered')
  assert.equal(header!.id, 'memory-lite-status')
  // -20 < open-in-app (-10): the status pill sits left of the workspace
  // open-in-app split button (Finder/VSCode/Xcode).
  assert.equal(header!.order, -20)
  assert.equal(typeof header!.component, 'function')

  const settings = entries.find(e => e.name === 'settings.section')
  assert.ok(settings, 'settings page entry registered')
  assert.equal(settings!.id, 'memory-lite')
  assert.equal(typeof settings!.component, 'function')
})

test('client.js binds the settingsScope namespace service', () => {
  const { inject } = applyWith()
  assert.ok(inject.includes('settingsScope'), 'inject declares settingsScope')
})

test('client.js binds both the memory-lite and agent-default-model scopes', () => {
  const { factory } = loadClient()
  const plugin = factory(fakeRequire) as { apply: (ctx: unknown) => void }
  const bound: string[] = []
  const fakeCtx = {
    get: (name: string) => {
      if (name === 'connection') return {
        rpc: { call: async () => ({ ok: true, value: null }) },
        api: { settings: { mutate: async () => ({ result: { ok: true } }) }, llm: { models: async () => ({ result: { ok: true, value: { groups: [], failures: [] } } }) } },
      }
      if (name === 'settingsScope') return { bind: (opts: { namespace: string }) => { bound.push(opts.namespace); return fakeScope } }
      return null
    },
    slots: { inject: () => {}, register: (opts: SlotEntry, component: unknown) => ({ ...opts, component }) },
  }
  plugin.apply(fakeCtx, {})
  assert.ok(bound.includes('dsh-memory-lite'), 'memory-lite namespace bound')
  assert.ok(bound.includes('agent-default-model'), 'agent-default-model namespace bound for the model dropdown')
})
