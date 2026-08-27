/**
 * L0 catalog rendering, digest, and session-history tracking. The pattern is
 * copied from `@deepseek-ai/dsh-tool-skill` (the verified reference).
 * @module dsh-memory-lite/src/catalog
 */

import { createHash } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { IndexEntry, MemoryCatalogSource } from './types.js'

/** Catalog identity over the entry list (not the prose); stable across renders. */
export function digestIndexEntries(entries: readonly IndexEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(entry => JSON.stringify([entry.category, entry.path, entry.summary]))
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

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
    source: { kind: 'memory-catalog', form: 'catalog', entries },
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
    source: { kind: 'memory-catalog', form: 'catalog', update: true, entries },
  })
}

/** Entries of one durable catalog message, or undefined when the record is unusable. */
export function readCatalogEntries(source: unknown): readonly IndexEntry[] | undefined {
  const entries = (source as { entries?: unknown }).entries
  if (!Array.isArray(entries)) return undefined
  const readable: IndexEntry[] = []
  for (const entry of entries as readonly unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const { category, path, summary } = entry as { category?: unknown; path?: unknown; summary?: unknown }
    if (typeof category !== 'string' || category === '' || typeof path !== 'string' || path === '' || typeof summary !== 'string') {
      return undefined
    }
    readable.push({ category, path, summary })
  }
  return readable
}

/**
 * The latest memory-catalog message this session published and whether its
 * digest is still on the visible surface (compaction may have moved it off).
 */
export function catalogHistory(agent: Agent): { visibleDigest?: string; published: boolean } {
  const visible = new Set(agent.session.surface.nodes)
  const events = agent.session.events
  for (let index = events.length - 1; index >= 0; index -= 1) {
    // The loop bound proves the read-only event view contains this index.
    const event = events[index]!
    if (event.type !== 'user/message') continue
    const source = event.data.source
    if (typeof source !== 'object' || source === null || source.kind !== 'memory-catalog') continue
    const entries = readCatalogEntries(source)
    if (entries === undefined) continue
    if (visible.has(event.seq)) return { visibleDigest: digestIndexEntries(entries), published: true }
    return { published: true }
  }
  return { published: false }
}

/** The memory-catalog message already in the entering batch, if any. */
export function catalogMessage(
  messages: readonly UserMessage[],
): { message: UserMessage; entries: readonly IndexEntry[] } | undefined {
  for (const message of messages) {
    // A message without a stamped source (created before the loop or by hand)
    // is not this plugin's catalog; treat it like any other message.
    const source = (message as { source?: unknown }).source
    if (typeof source !== 'object' || source === null || (source as { kind?: unknown }).kind !== 'memory-catalog') continue
    const entries = readCatalogEntries(source)
    if (entries !== undefined) return { message, entries }
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
