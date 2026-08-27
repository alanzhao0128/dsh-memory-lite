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
import { Config, resolveConfig } from './config.js'
import type { MemoryConfig } from './config.js'
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
  const resolved = resolveConfig(config)
  const store = new MemoryStore(resolved.root, resolved.sharing)
  const deps: MemoryDeps = { config: resolved, store }
  const readTool = applyReadMemoryTool(ctx, deps)
  applySearchMemoryTool(ctx, deps)
  applyRememberTool(ctx, deps)
  applyUpdateMemoryTool(ctx, deps)
  applyForgetMemoryTool(ctx, deps)
  applyMemoryCatalogInjection(ctx, resolved, store, readTool)
  const tracker = createStatusTracker()
  applyExtraction(ctx, resolved, store, tracker)
  // Browser indicator channel: the sidebar dot polls this snapshot.
  ctx.connection.rpc.handle(
    '/memory-status',
    async (_endpoint, _payload, _signal) => ({
      ok: true,
      value: tracker.snapshot(resolved.extraction.mode),
    }),
    { authority: 'loopback' },
  )
  ctx.logger.info(`dsh-memory-lite: memory enabled (root ${resolved.root}, default peer ${resolved.defaultPeer}, extraction ${resolved.extraction.mode})`)
}
