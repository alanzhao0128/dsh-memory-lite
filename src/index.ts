/**
 * dsh-memory-lite: lightweight Markdown-file memory for DeepSeek Harness.
 *
 * - Five model-facing tools: read_memory, search_memory, remember,
 *   update_memory, forget_memory (explicit capture only — the implicit
 *   extraction channel is Phase 2).
 * - L0 catalog injection (`agent/pre-step` waterfall): the peer's memory
 *   index is published as a durable user message and re-published when the
 *   index changes or compaction moves it off the visible surface.
 * - Peer isolation: each session's cwd derives its own memory root.
 * - All file access goes through a containment boundary; subagent sessions
 *   get no catalog and no tool access.
 *
 * Model Experience: the 5 tool schemas are injected every step; the L0
 * catalog is one durable surface message resident for the session (re-sent
 * after compaction or index changes). See README.md and IMPLEMENTATION.md.
 * @module dsh-memory-lite
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-client-connection'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Config, resolveConfig } from './config.js'
import type { MemoryConfig, ResolvedConfig } from './config.js'
import { MemoryStore } from './memory-store.js'
import type { MemoryDeps } from './tool-utils.js'
import { applyReadMemoryTool } from './tools/read-memory.js'
import { applySearchMemoryTool } from './tools/search-memory.js'
import { applyRememberTool } from './tools/remember.js'
import { applyUpdateMemoryTool } from './tools/update-memory.js'
import { applyForgetMemoryTool } from './tools/forget-memory.js'
import { applyMemoryCatalogInjection } from './inject.js'
import { applyExtraction } from './extract/index.js'
import { createStatusTracker } from './status.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-memory-lite'

/** Services this plugin needs: the tool registry, the agent registry, the LLM stream,
 * and the timer service (ctx.timeout for the extraction idle backstop). */
export const inject = ['tools', 'agents', 'llm', 'timer', 'connection']

export { Config }

/** Register the memory capability for the lifetime of `ctx`. */
export function apply(ctx: Context, config: MemoryConfig = {}): void {
  // The live config is a mutable reference; settings changes swap it in place
  // (see installSettingsSection below), so every consumer reading through the
  // deps getter sees the newest value without re-registering.
  let live: ResolvedConfig = resolveConfig(config)
  const store = new MemoryStore(live.root, live.sharing)
  const defaultModel = (): { provider: string; model: string; reasoningEffort?: string } => {
    const svc = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string; reasoningEffort?: string } } | undefined
    if (svc?.currentSelection === undefined) return { provider: '', model: '' }
    try {
      return svc.currentSelection()
    } catch {
      return { provider: '', model: '' }
    }
  }
  const deps: MemoryDeps = { config: () => live, store, defaultModel }
  const readTool = applyReadMemoryTool(ctx, deps)
  applySearchMemoryTool(ctx, deps)
  applyRememberTool(ctx, deps)
  applyUpdateMemoryTool(ctx, deps)
  applyForgetMemoryTool(ctx, deps)
  applyMemoryCatalogInjection(ctx, deps, readTool)
  const tracker = createStatusTracker()
  applyExtraction(ctx, deps, tracker)

  // Settings-backed overrides (方案 A, IMPLEMENTATION.md §16): the cordis row
  // config is the composition base; user edits land in ~/.dsh/settings.yaml
  // under the dsh-memory-lite namespace. root/sharing stay pinned to the store
  // snapshot (restart-applies — MemoryStore holds them at construction); every
  // other field resolves live on each change.
  let source: () => MemoryConfig = () => config
  installSettingsSection(ctx, settingsNamespace('dsh-memory-lite'), Config, config, {
    setSource: (get) => { source = get },
    onChange: () => {
      const next = resolveConfig(source())
      live = { ...next, root: live.root, sharing: live.sharing }
    },
  })

  // Browser indicator channel: the header dot polls this snapshot.
  ctx.connection.rpc.handle(
    '/memory-status',
    async (_endpoint, _payload, _signal) => ({
      ok: true,
      value: tracker.snapshot(live.extraction.mode),
    }),
    { authority: 'loopback' },
  )

  // Settings UI: list existing peers so sharing.mounts can be edited as
  // checkboxes instead of raw YAML (IMPLEMENTATION.md §16.9 known limit).
  ctx.connection.rpc.handle(
    '/memory-peers',
    async (_endpoint, _payload, _signal) => ({
      ok: true,
      value: {
        peers: await store.listPeers(),
        mounts: live.sharing.mounts.map(m => ({ name: m.name, peer: m.peer, subpath: m.subpath, readonly: m.readonly })),
      },
    }),
    { authority: 'loopback' },
  )
  ctx.logger.info(`dsh-memory-lite: memory enabled (root ${live.root}, default peer ${live.defaultPeer}, extraction ${live.extraction.mode})`)
}
