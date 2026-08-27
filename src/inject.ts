/**
 * L0 catalog injection: an `agent/pre-step` waterfall listener that publishes
 * the peer's memory catalog as a durable user message, tracking visibility
 * and digest exactly like `@deepseek-ai/dsh-tool-skill`.
 * @module dsh-memory-lite/src/inject
 */

import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { MemoryDeps } from './tool-utils.js'
import type { IndexEntry } from './types.js'
import { peerForHeader } from './peer.js'
import { digestApproxTokens } from './extract/digest.js'
import { catalogHistory, catalogMessage, digestIndexEntries, renderCatalogMessage, renderCatalogUpdate, type SharedMountNotice } from './catalog.js'

/** Inputs to the catalog decision; all derived state is resolved by the caller. */
export interface CatalogDecisionParams {
  readonly decision: PreStepDecision
  readonly history: { readonly visibleDigest?: string; readonly published: boolean }
  readonly existing: { readonly message: UserMessage; readonly entries: readonly IndexEntry[] } | undefined
  readonly entries: readonly IndexEntry[]
  /** Shared mounts to advertise (Phase 3); drives the empty-index exception. */
  readonly sharedMounts: readonly SharedMountNotice[]
  readonly peer: string
}

/** Fixed catalog overhead (framing + guidance + section headers), approximate tokens. */
const CATALOG_FIXED_TOKENS = 200

/**
 * Cap the injected catalog entries so the rendered catalog stays within
 * `index.maxTokens` (recency-first: entries arrive newest-first, oldest are
 * dropped from the injection only — the index file keeps them all and
 * search_memory still finds them). This is the design's bounded L0 window.
 */
export function capCatalogEntries(entries: readonly IndexEntry[], maxTokens: number): readonly IndexEntry[] {
  if (entries.length === 0) return entries
  const budget = maxTokens - CATALOG_FIXED_TOKENS
  if (budget <= 0) return []
  let used = 0
  const result: IndexEntry[] = []
  for (const entry of entries) {
    const lineTokens = digestApproxTokens(`- ${entry.path}: ${entry.summary}\n`)
    if (used + lineTokens > budget) break
    result.push(entry)
    used += lineTokens
  }
  return result
}

/**
 * Decide how the entering batch should carry the memory catalog. The branches
 * mirror `@deepseek-ai/dsh-tool-skill`: publish on first sight, replace or
 * drop a stale in-batch catalog, republish after compaction, and publish
 * nothing for a fresh empty index.
 */
export function applyCatalogDecision(params: CatalogDecisionParams): PreStepDecision {
  const { decision, history, existing, entries, sharedMounts = [], peer } = params
  if (decision.kind === 'reject') return decision
  const digest = digestIndexEntries(entries)
  if (history.visibleDigest === digest) {
    return existing === undefined
      ? decision
      : { kind: 'enter', messages: decision.messages.filter(message => message.id !== existing.message.id) }
  }
  if (existing !== undefined && digestIndexEntries(existing.entries) === digest) return decision
  // Phase 3: an empty local index still publishes a catalog when there are
  // shared mounts to advertise (otherwise the shared region is undiscoverable).
  if (!history.published && entries.length === 0 && sharedMounts.length === 0) {
    return existing === undefined
      ? decision
      : { kind: 'enter', messages: decision.messages.filter(message => message.id !== existing.message.id) }
  }
  const catalog = history.published
    ? renderCatalogUpdate(entries, peer, sharedMounts)
    : renderCatalogMessage(entries, peer, sharedMounts)
  return {
    kind: 'enter',
    messages: existing === undefined
      ? [...decision.messages, catalog]
      : decision.messages.map(message => message.id === existing.message.id ? catalog : message),
  }
}

/** Register the pre-step catalog injector for the lifetime of `ctx`. */
export function applyMemoryCatalogInjection(
  ctx: Context,
  deps: MemoryDeps,
  readTool: ToolDefinition,
): void {
  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    // Locked decision (IMPLEMENTATION.md §7): subagent sessions get no catalog.
    if (agent.session.header.origin === 'subagent') return decision
    // The anchor tool's exact definition is the visibility gate: a restriction
    // or scoped shadow of read_memory removes both the schema and the catalog.
    if (ctx.tools.get(readTool.name, agent) !== readTool) return decision
    const config = deps.config()
    const peer = peerForHeader(agent.session.header, config)
    const entries = capCatalogEntries(await deps.store.readIndex(peer), config.index.maxTokens)
    const sharedMounts = config.sharing.enabled
      ? config.sharing.mounts
          .filter(mount => mount.peer !== peer)
          .map(mount => ({ name: mount.name, peer: mount.peer, readonly: mount.readonly }))
      : []
    return applyCatalogDecision({
      decision,
      history: catalogHistory(agent),
      existing: catalogMessage(decision.messages),
      entries,
      sharedMounts,
      peer,
    })
  })
}
