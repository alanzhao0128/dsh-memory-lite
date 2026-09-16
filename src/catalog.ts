/**
 * L0 catalog rendering and session-history tracking.
 *
 * The injected message uses the OFFICIAL `plugin` source kind with the
 * `catalog` form, so a released session-format migration can classify and
 * carry it (the private `memory-catalog` kind written before 0.2.3 is still read
 * back for old sessions). The official source form carries no payload, so the
 * published state is recovered by comparing the message text itself.
 * @module dsh-memory-lite/src/catalog
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { IndexEntry } from './types.js'

/**
 * The `plugin` name stamped on the catalog source: the official `plugin` kind
 * plus the official `catalog` form mark one plugin-published catalog without
 * inventing a source kind outside the released vocabulary.
 */
export const MEMORY_CATALOG_PLUGIN = 'dsh-memory-lite'

const GUIDANCE =
  'You have long-term memory tools (read_memory / search_memory / remember / update_memory / forget_memory). ' +
  'Call remember only when the user explicitly asks to remember something; do not decide on your own. ' +
  'To load the full text of a memory, call read_memory with the exact path from this index.'

/** One shared-mount notice rendered into the catalog; not an index entry. */
export interface SharedMountNotice {
  readonly name: string
  readonly peer: string
  readonly readonly: boolean
}

/** The shared-mount section of the catalog (empty when no mounts). */
function renderSharedMounts(mounts: readonly SharedMountNotice[]): string[] {
  if (mounts.length === 0) return []
  return [
    '',
    '## shared',
    ...mounts.map(mount =>
      `- shared/${mount.name}/: read-only mirror of peer '${mount.peer}'. The full index is not preloaded — find content with search_memory, then read_memory for the full text.`,
    ),
  ]
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
 * Whether one message source is a memory catalog this plugin published. New
 * messages carry the official `plugin` kind with the `catalog` form; sessions
 * written before that change carry the private `memory-catalog` kind and stay
 * readable, so an already-published catalog is never published twice.
 */
export function isMemoryCatalogSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null) return false
  const record = source as { readonly kind?: unknown; readonly plugin?: unknown; readonly form?: unknown }
  if (record.kind === 'memory-catalog') return true
  return record.kind === 'plugin' && record.plugin === MEMORY_CATALOG_PLUGIN && record.form === 'catalog'
}

/** The text one rendered catalog message publishes. */
function catalogText(message: UserMessage): string | undefined {
  return textOfContent((message as { readonly content?: unknown }).content)
}

/** The catalog message for this session's first publication. */
export function renderCatalogMessage(entries: readonly IndexEntry[], peer: string, sharedMounts: readonly SharedMountNotice[] = []): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        `This is your long-term memory index for the ${peer} project. It lists what you have memorized, one line per memory.`,
        'The full text of any memory is NOT loaded until you call read_memory — use the exact path from this index.',
        ...renderSections(entries),
        ...renderSharedMounts(sharedMounts),
        '',
        GUIDANCE,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: MEMORY_CATALOG_PLUGIN, form: 'catalog' },
  })
}

/** The catalog message when the index changed and an older catalog is still visible. */
export function renderCatalogUpdate(entries: readonly IndexEntry[], peer: string, sharedMounts: readonly SharedMountNotice[] = []): UserMessage {
  return createUserMessage({
    content: [{
      type: 'text',
      text: [
        '<system-reminder>',
        `The memory catalog for ${peer} changed. This complete catalog replaces every earlier memory catalog in this session:`,
        ...renderSections(entries),
        ...renderSharedMounts(sharedMounts),
        '',
        GUIDANCE,
        '</system-reminder>',
      ].join('\n'),
    }],
    source: { kind: 'plugin', plugin: MEMORY_CATALOG_PLUGIN, form: 'catalog' },
  })
}

/**
 * Whether a published catalog text is still this plugin's current rendering.
 * An unchanged catalog matches whichever framing it was published with, so a
 * first publication and an update that carry the same entries and mounts both
 * count as current.
 */
export function isCurrentCatalogText(
  text: string,
  entries: readonly IndexEntry[],
  peer: string,
  sharedMounts: readonly SharedMountNotice[] = [],
): boolean {
  return text === catalogText(renderCatalogMessage(entries, peer, sharedMounts))
    || text === catalogText(renderCatalogUpdate(entries, peer, sharedMounts))
}

/**
 * The latest catalog message this session published, plus the text it
 * published while that message is still on the visible surface (compaction may
 * have moved it off).
 */
export function catalogHistory(agent: Agent): { published: boolean; visibleText?: string } {
  const visible = new Set(agent.session.surface.nodes)
  // dsh-session >= 0.1.2 replaced the `events` property with snapshotEvents()
  // and narrowed seq to a branded SessionSeq; both shapes are read-only event
  // arrays with {type, seq, data} and seq stays comparable with surface.nodes.
  type EventLike = { type: string; seq: unknown; data: { content?: unknown; source?: unknown } }
  const sessionAny = agent.session as { events?: readonly EventLike[]; snapshotEvents?: () => readonly EventLike[] }
  const events = sessionAny.snapshotEvents !== undefined ? sessionAny.snapshotEvents() : (sessionAny.events ?? [])
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // The loop bound proves the read-only event view contains this index.
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
    // A message without a stamped source (created before the loop or by hand)
    // is not this plugin's catalog; treat it like any other message.
    const source = (message as { readonly source?: unknown }).source
    if (!isMemoryCatalogSource(source)) continue
    const text = textOfContent((message as { readonly content?: unknown }).content)
    if (text !== undefined) return { message, text }
  }
  return undefined
}

/** Category-section lines with per-category relevance hints. */
function renderSections(entries: readonly IndexEntry[]): string[] {
  const hints: Record<string, string> = {
    preferences: ' (always relevant)',
    entities: ' (relevant when mentioned)',
    events: ' (relevant for time queries)',
    experiences: ' (relevant for similar tasks)',
  }
  const lines: string[] = []
  let lastCategory: string | undefined
  for (const entry of entries) {
    if (entry.category !== lastCategory) {
      lines.push('')
      lines.push(`## ${entry.category}${hints[entry.category] ?? ''}`)
      lastCategory = entry.category
    }
    lines.push(`- ${escapeCatalogText(entry.path)}: ${escapeCatalogText(entry.summary)}`)
  }
  return lines
}

/** Escape catalog text for the pseudo-XML framing (applied at render, never stored). */
function escapeCatalogText(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
