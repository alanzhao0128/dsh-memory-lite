/**
 * Regression tests for the browser half (lib/client.js): it must evaluate as a
 * classic-script under the ModuleLoader contract (declares module/exports —
 * a missing shell previously broke startup with "exports is not defined"),
 * return a plugin with apply/inject, and honor ui.headerOrder.
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

const reactStub = { useCallback: (fn: unknown) => fn, useEffect: (fn: unknown) => fn, useState: (v: unknown) => [v, () => {}] }
const jsxStub = { jsx: (_t: unknown, p: unknown) => ({ p }), jsxs: (_t: unknown, p: unknown) => ({ p }) }
const fakeRequire = (name: string): unknown => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return jsxStub
  throw new Error('unexpected require: ' + name)
}

function applyWith(order: number | undefined): SlotEntry {
  const { factory } = loadClient()
  const plugin = factory(fakeRequire) as { apply: (ctx: unknown, config: unknown) => void; inject: string[] }
  assert.equal(typeof plugin.apply, 'function')
  assert.deepEqual(plugin.inject, ['connection', 'slots'])
  let entry: SlotEntry | null = null
  const fakeCtx = {
    get: (name: string) => name === 'connection' ? { rpc: { call: async () => ({ ok: true, value: null }) } } : null,
    slots: {
      inject: (_name: string, fn: () => unknown) => { entry = fn() as SlotEntry },
      register: (opts: SlotEntry, component: unknown) => ({ ...opts, component }),
    },
  }
  plugin.apply(fakeCtx, order === undefined ? {} : { ui: { headerOrder: order } })
  assert.ok(entry, 'apply must register the header utilities slot')
  return entry!
}

test('client.js evaluates and registers the header indicator with ui.headerOrder', () => {
  const entry = applyWith(5)
  assert.equal(entry.name, 'conversation.session.header.utilities')
  assert.equal(entry.id, 'memory-lite-status')
  assert.equal(entry.order, 5)
  assert.equal(typeof entry.component, 'function')
})

test('client.js defaults headerOrder to -1 when ui config is absent', () => {
  const entry = applyWith(undefined)
  assert.equal(entry.order, -1)
})
