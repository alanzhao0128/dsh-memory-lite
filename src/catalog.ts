/**
 * L0 catalog rendering and session-history tracking for the Unified Topic Vault.
 *
 * Supports two adaptive layouts transparently:
 *   1. Full expansion (when visible entries fit inside `index.maxTokens`)
 *   2. Adaptive Topic Map (preferences + hot topics expanded, remaining topics
 *      rendered as 1-line map entries inspectable via `read_memory("<topic>/")`)
 * @module dsh-memory-lite/src/catalog
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { PREFERENCES_TOPIC, type CollapsedTopicNotice, type IndexEntry } from './types.js'

/** Producer-owned v4 source kind stamped on the catalog message. */
export const MEMORY_CATALOG_PLUGIN = 'dsh-memory-lite'
export const MEMORY_CATALOG_SOURCE_KIND = `plugin:${MEMORY_CATALOG_PLUGIN}` as const

const GUIDANCE =
  'You have long-term memory tools (read_memory / search_memory / remember / update_memory / forget_memory). ' +
  'Call remember only when the user explicitly asks to remember something; do not decide on your own. ' +
  'To load the full text of a memory, call read_memory with its exact path (or pass "<topic>/" to list a collapsed topic).'

/** Structured render inputs for one catalog publication. */
export interface RenderCatalogOptions {
  readonly entries: readonly IndexEntry[]
  readonly collapsedTopics?: readonly CollapsedTopicNotice[]
  readonly globalCharter?: string
  readonly restricted?: boolean
}

/** The single model-facing text block of one message content array. */
function textOfContent(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as { readonly type?: unknown; readonly text?: unknown }
    if (record.type === 'text' && typeof record.text === 'string') return record.text
  }
  return undefined
}

/**
 * Whether one message source is a memory catalog this plugin published.
 * Recognizes all three historical representations (pre-0.2.3, v3, v4).
 */
export function isMemoryCatalogSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as { readonly kind?: unknown; readonly plugin?: unknown; readonly form?: unknown }
  if (record.kind === 'memory-catalog') return true
  if (record.kind === 'plugin' && record.plugin === MEMORY_CATALOG_PLUGIN && record.form === 'catalog') return true
  if (record.kind === MEMORY_CATALOG_SOURCE_KIND && record.form === 'catalog') return true
  return false
}

/** The text one rendered catalog message publishes. */
function catalogText(message: UserMessage): string | undefined {
  return textOfContent((message as { readonly content?: unknown }).content)
}

/** Render the global charter section if present. */
function renderGlobalCharter(globalCharter?: string): string[] {
  if (globalCharter === undefined || globalCharter.trim() === '') return []
  return [
    '',
    '## Global Agent Charter (~/.agent-memory/AGENTS.md)',
    globalCharter.trim(),
    '',
  ]
}

/** Topic-grouped entry lines (`preferences` annotated as always relevant). */
function renderTopicSections(entries: readonly IndexEntry[]): string[] {
  const lines: string[] = []
  let lastTopic: string | undefined
  for (const entry of entries) {
    if (entry.topic !== lastTopic) {
      lines.push('')
      const hint = entry.topic === PREFERENCES_TOPIC ? ' (always relevant)' : ''
      lines.push(`## ${escapeCatalogText(entry.topic)}${hint}`)
      lastTopic = entry.topic
    }
    lines.push(`- ${escapeCatalogText(entry.path)}: ${escapeCatalogText(entry.summary)}`)
  }
  return lines
}

/** Collapsed 1-line Topic Map entries for adaptive mode. */
function renderCollapsedTopics(collapsed: readonly CollapsedTopicNotice[]): string[] {
  if (collapsed.length === 0) return []
  const lines: string[] = [
    '',
    '## Collapsed Topics (call read_memory("<topic>/") to list, or search_memory)',
  ]
  for (const item of collapsed) {
    const preview = item.previewTitles.map(escapeCatalogText).join(', ')
    const previewPart = preview === '' ? '' : `: ${preview}`
    lines.push(`- ${escapeCatalogText(item.topic)} (${item.count})${previewPart}`)
  }
  return lines
}

/** Build the body text for first publication or replacement update. */
function buildCatalogBody(options: RenderCatalogOptions, isUpdate: boolean): string {
  const { entries, collapsedTopics = [], globalCharter, restricted = false } = options
  const modeNote = restricted ? ' (restricted mode: private memories are hidden)' : ''
  const header = isUpdate
    ? [`Your long-term memory catalog changed${modeNote}. This complete catalog replaces every earlier memory catalog in this session:`]
    : [
        `This is your long-term memory index${modeNote}. Memories are organized by topic, one line per memory.`,
        'The full text of any memory is NOT loaded until you call read_memory — use the exact path from this index.',
      ]
  return [
    '<system-reminder>',
    ...renderGlobalCharter(globalCharter),
    ...header,
    ...renderTopicSections(entries),
    ...renderCollapsedTopics(collapsedTopics),
    '',
    GUIDANCE,
    '</system-reminder>',
  ].filter((line, i, arr) => !(line === '' && arr[i - 1] === '')).join('\n')
}

/** The catalog message for this session's first publication. */
export function renderCatalogMessage(options: RenderCatalogOptions): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: buildCatalogBody(options, false) }],
    source: { kind: MEMORY_CATALOG_SOURCE_KIND, form: 'catalog' },
  })
}

/** The catalog message when the index or trust level changed while an older catalog is visible. */
export function renderCatalogUpdate(options: RenderCatalogOptions): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text: buildCatalogBody(options, true) }],
    source: { kind: MEMORY_CATALOG_SOURCE_KIND, form: 'catalog' },
  })
}

/** Whether a published catalog text still matches the current rendering. */
export function isCurrentCatalogText(text: string, options: RenderCatalogOptions): boolean {
  return text === catalogText(renderCatalogMessage(options))
    || text === catalogText(renderCatalogUpdate(options))
}

/** Latest catalog message this session published, plus its text while still on the visible surface. */
export function catalogHistory(agent: Agent): { published: boolean; visibleText?: string } {
  const visible = new Set(agent.session.surface.nodes)
  type EventLike = { type: string; seq: unknown; data: { content?: unknown; source?: unknown } }
  const sessionAny = agent.session as { events?: readonly EventLike[]; snapshotEvents?: () => readonly EventLike[] }
  const events = sessionAny.snapshotEvents !== undefined ? sessionAny.snapshotEvents() : (sessionAny.events ?? [])
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]!
    if (event.type !== 'user/message') continue
    if (!isMemoryCatalogSource(event.data.source)) continue
    const text = textOfContent(event.data.content)
    if (text === undefined) continue
    if (visible.has(event.seq as never)) return { published: true, visibleText: text }
    return { published: true }
  }
  return { published: false }
}

/** The catalog message already in the entering batch, if any. */
export function catalogMessage(
  messages: readonly UserMessage[],
): { message: UserMessage; text: string } | undefined {
  for (const message of messages) {
    const source = (message as { readonly source?: unknown }).source
    if (!isMemoryCatalogSource(source)) continue
    const text = textOfContent((message as { readonly content?: unknown }).content)
    if (text !== undefined) return { message, text }
  }
  return undefined
}

/** Escape catalog text for the pseudo-XML framing (applied at render, never stored). */
function escapeCatalogText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
