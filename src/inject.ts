/**
 * Adaptive L0 catalog injection (`agent/pre-step` waterfall listener).
 *
 * - Evaluates the live trust boundary (hidePrivate / restrictedProviders /
 *   restrictedPaths) on every step so switching into a restricted context
 *   immediately scrubs `private/` from the catalog.
 * - Uses two adaptive modes within `index.maxTokens`:
 *     1. Full mode: every visible topic expanded when total tokens fit.
 *     2. Adaptive Topic Map mode: `preferences` always expanded, hot topics
 *        (from `TopicAffinityStore`, pinned once per session to preserve KV
 *        prompt cache) expanded up to `hotBudgetRatio`, remaining topics
 *        collapsed into 1-line map entries.
 * @module dsh-memory-lite/src/inject
 */

import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { PREFERENCES_TOPIC, type CollapsedTopicNotice, type IndexEntry } from './types.js'
import { trustForSession, type MemoryDeps, type SessionContextLike } from './tool-utils.js'
import { digestApproxTokens } from './extract/digest.js'
import {
  catalogHistory, catalogMessage, isCurrentCatalogText,
  renderCatalogMessage, renderCatalogUpdate, type RenderCatalogOptions,
} from './catalog.js'

/** Inputs to the catalog decision; all derived state is resolved by the caller. */
export interface CatalogDecisionParams {
  readonly decision: PreStepDecision
  readonly history: { readonly published: boolean; readonly visibleText?: string }
  readonly existing: { readonly message: UserMessage; readonly text: string } | undefined
  readonly entries: readonly IndexEntry[]
  readonly collapsedTopics?: readonly CollapsedTopicNotice[]
  readonly globalCharter?: string
  readonly restricted?: boolean
}

/** Planned L0 layout produced by {@link planCatalogLayout}. */
export interface CatalogLayout {
  readonly expanded: readonly IndexEntry[]
  readonly collapsed: readonly CollapsedTopicNotice[]
}

/** Fixed catalog overhead (framing + guidance + section headers), approximate tokens. */
const CATALOG_FIXED_TOKENS = 200
/** Max preview titles shown on one collapsed Topic Map line. */
const COLLAPSED_PREVIEW_LIMIT = 6

/** Approximate tokens of one rendered entry line. */
function entryTokens(entry: IndexEntry): number {
  return digestApproxTokens(`- ${entry.path}: ${entry.summary}\n`)
}

/** Approximate tokens of one topic group (heading + all entries). */
function groupTokens(topic: string, list: readonly IndexEntry[]): number {
  let sum = digestApproxTokens(`## ${topic}\n`)
  for (const entry of list) sum += entryTokens(entry)
  return sum
}

/** Build one collapsed Topic Map notice from a topic's entries. */
function toCollapsedNotice(topic: string, list: readonly IndexEntry[]): CollapsedTopicNotice {
  return {
    topic,
    count: list.length,
    previewTitles: list.slice(0, COLLAPSED_PREVIEW_LIMIT).map(e => basename(e.path, '.md')),
  }
}

/**
 * Plan the adaptive L0 layout within `maxTokens`:
 * - If all visible entries fit in budget, expand everything (zero extra tool calls).
 * - Otherwise:
 *     1. Always expand `preferences` (up to remaining budget).
 *     2. Rank remaining topics by `hotTopics` affinity first, then index recency order.
 *     3. Expand hot topics within `hotBudgetRatio` of the post-preferences budget
 *        (reserving room so every remaining topic still fits as a 1-line map entry).
 *     4. Collapse the rest into 1-line Topic Map notices.
 */
export function planCatalogLayout(
  entries: readonly IndexEntry[],
  maxTokens: number,
  hotTopics: readonly string[] = [],
  hotBudgetRatio = 0.7,
): CatalogLayout {
  if (entries.length === 0) return { expanded: [], collapsed: [] }
  const budget = maxTokens - CATALOG_FIXED_TOKENS
  if (budget <= 0) return { expanded: [], collapsed: [] }

  // Group entries by topic preserving their newest-first order within each topic.
  const byTopic = new Map<string, IndexEntry[]>()
  for (const entry of entries) {
    const list = byTopic.get(entry.topic)
    if (list === undefined) byTopic.set(entry.topic, [entry])
    else list.push(entry)
  }

  // Fast path: full expansion when everything fits inside budget.
  let totalTokens = 0
  for (const [topic, list] of byTopic) totalTokens += groupTokens(topic, list)
  if (totalTokens <= budget) {
    return { expanded: entries, collapsed: [] }
  }

  // Adaptive mode: preferences first, then hot topics, then 1-line map for the rest.
  const expanded: IndexEntry[] = []
  let used = 0

  const prefs = byTopic.get(PREFERENCES_TOPIC)
  if (prefs !== undefined) {
    used += digestApproxTokens(`## ${PREFERENCES_TOPIC} (always relevant)\n`)
    for (const entry of prefs) {
      const t = entryTokens(entry)
      if (used + t > budget) break
      expanded.push(entry)
      used += t
    }
  }

  const otherTopics = [...byTopic.keys()].filter(t => t !== PREFERENCES_TOPIC)
  const hotRank = new Map<string, number>()
  hotTopics.forEach((topic, idx) => {
    if (!hotRank.has(topic)) hotRank.set(topic, idx)
  })
  const rankedTopics = [...otherTopics].sort((a, b) => {
    const ra = hotRank.get(a)
    const rb = hotRank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return 0 // preserve existing recency order from _index.md
  })

  // Estimate space needed if every non-preferences topic were collapsed (1 line each).
  const collapsedCostPerTopic = (topic: string, list: readonly IndexEntry[]): number => {
    const notice = toCollapsedNotice(topic, list)
    return digestApproxTokens(`- ${notice.topic} (${notice.count}): ${notice.previewTitles.join(', ')}\n`)
  }
  const remainingBudget = Math.max(0, budget - used)
  const expandBudget = Math.floor(remainingBudget * hotBudgetRatio)

  let expandUsed = 0
  const collapsed: CollapsedTopicNotice[] = []

  for (let i = 0; i < rankedTopics.length; i += 1) {
    const topic = rankedTopics[i]!
    const list = byTopic.get(topic)!
    const cost = groupTokens(topic, list)
    // Reserve approximate budget for collapsing any topics that come after this one.
    let reserveForLaterCollapsed = 0
    for (let j = i + 1; j < rankedTopics.length; j += 1) {
      const laterTopic = rankedTopics[j]!
      reserveForLaterCollapsed += collapsedCostPerTopic(laterTopic, byTopic.get(laterTopic)!)
    }
    const fitsExpandCap = expandUsed + cost <= expandBudget
    const fitsTotal = used + cost + reserveForLaterCollapsed <= budget
    if (fitsExpandCap && fitsTotal) {
      expanded.push(...list)
      used += cost
      expandUsed += cost
    } else {
      collapsed.push(toCollapsedNotice(topic, list))
    }
  }

  // Enforce budget on collapsed list if there are extraordinarily many topics.
  const boundedCollapsed: CollapsedTopicNotice[] = []
  let mapUsed = used + (collapsed.length > 0 ? 20 : 0)
  for (const notice of collapsed) {
    const lineCost = digestApproxTokens(`- ${notice.topic} (${notice.count}): ${notice.previewTitles.join(', ')}\n`)
    if (mapUsed + lineCost > budget && boundedCollapsed.length > 0) break
    boundedCollapsed.push(notice)
    mapUsed += lineCost
  }

  return { expanded, collapsed: boundedCollapsed }
}

/**
 * Decide how the entering batch should carry the memory catalog:
 * publish on first sight, replace or drop a stale in-batch catalog, republish
 * after compaction or trust change, and publish nothing for an empty vault.
 */
export function applyCatalogDecision(params: CatalogDecisionParams): PreStepDecision {
  const { decision, history, existing, entries, collapsedTopics = [], globalCharter, restricted = false } = params
  if (decision.kind === 'reject') return decision
  const renderOpts: RenderCatalogOptions = { entries, collapsedTopics, globalCharter, restricted }
  const current = (text: string | undefined): boolean =>
    text !== undefined && isCurrentCatalogText(text, renderOpts)
  if (current(history.visibleText)) {
    return existing === undefined
      ? decision
      : { kind: 'enter', messages: decision.messages.filter(message => message.id !== existing.message.id) }
  }
  if (existing !== undefined && current(existing.text)) return decision
  if (
    !history.published
    && entries.length === 0
    && collapsedTopics.length === 0
    && (globalCharter === undefined || globalCharter === '')
  ) {
    return existing === undefined
      ? decision
      : { kind: 'enter', messages: decision.messages.filter(message => message.id !== existing.message.id) }
  }
  const catalog = history.published
    ? renderCatalogUpdate(renderOpts)
    : renderCatalogMessage(renderOpts)
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
  // Pin each session's initial hot-topic order once so reading a cold topic
  // mid-session never reshuffles L0 and busts the KV prompt cache.
  const sessionHotTopics = new Map<string, readonly string[]>()

  ctx.on('agent/pre-step', async ({ agent, signal }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    signal.throwIfAborted()
    if (agent.session.header.origin === 'subagent') return decision
    if (ctx.tools.get(readTool.name, agent) !== readTool) return decision

    const config = deps.config()
    const session = agent.session as unknown as SessionContextLike
    const trust = trustForSession(session, deps)
    const sessionId = agent.session.id

    let hotTopics = sessionHotTopics.get(sessionId)
    if (hotTopics === undefined) {
      hotTopics = deps.affinity !== undefined
        ? await deps.affinity.hotTopicsFor(agent.session.header.cwd)
        : []
      sessionHotTopics.set(sessionId, hotTopics)
      // Bound map growth for long-lived host processes.
      if (sessionHotTopics.size > 500) {
        const oldest = sessionHotTopics.keys().next().value
        if (oldest !== undefined) sessionHotTopics.delete(oldest)
      }
    }

    const [visibleEntries, globalCharter] = await Promise.all([
      deps.store.readIndex(trust),
      deps.store.readGlobalCharter(),
    ])
    const layout = planCatalogLayout(
      visibleEntries,
      config.index.maxTokens,
      hotTopics,
      config.index.hotBudgetRatio,
    )

    return applyCatalogDecision({
      decision,
      history: catalogHistory(agent),
      existing: catalogMessage(decision.messages),
      entries: layout.expanded,
      collapsedTopics: layout.collapsed,
      globalCharter,
      restricted: trust.restricted,
    })
  })
}
