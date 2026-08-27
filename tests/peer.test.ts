import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { peerForHeader, peerFromCwd } from '../src/peer.js'
import { resolveConfig } from '../src/config.js'

test('peerFromCwd is deterministic and sanitized', () => {
  const a = peerFromCwd('/Users/alice/projects/My App')
  const b = peerFromCwd('/Users/alice/projects/My App')
  assert.equal(a, b)
  assert.match(a, /^my-app-[0-9a-f]{8}$/)
  // Distinct directories sharing a basename do not collide.
  assert.notEqual(peerFromCwd('/a/projects/My App'), peerFromCwd('/b/projects/My App'))
})

test('peerForHeader uses the cwd when enabled', () => {
  const config = resolveConfig({})
  const header = { cwd: '/Users/alice/projects/foo' } as SessionHeader
  assert.equal(peerForHeader(header, config), peerFromCwd('/Users/alice/projects/foo'))
})

test('peerForHeader falls back when no cwd', () => {
  const config = resolveConfig({})
  assert.equal(peerForHeader(undefined, config), 'dsh-web')
  assert.equal(peerForHeader({} as SessionHeader, config), 'dsh-web')
})

test('peerForHeader honors cwdFallback', () => {
  const config = resolveConfig({ defaultPeer: 'main', workspacePeers: { cwdFallback: 'sandbox' } })
  assert.equal(peerForHeader(undefined, config), 'sandbox')
  const fallbackToDefault = resolveConfig({ workspacePeers: { cwdFallback: 'default_peer' } })
  assert.equal(peerForHeader(undefined, fallbackToDefault), 'dsh-web')
})

test('peerForHeader ignores cwd when workspace peers are disabled', () => {
  const config = resolveConfig({ workspacePeers: { enabled: false } })
  assert.equal(peerForHeader({ cwd: '/x/y' } as SessionHeader, config), 'dsh-web')
})
