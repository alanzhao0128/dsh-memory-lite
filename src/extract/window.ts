/**
 * Extraction windowing: which session-log events feed an extraction run, how
 * the window is cropped, and how each event is rendered into text. Pure
 * functions over a minimal structural event shape (structurally satisfied by
 * DSH SessionEvent) so they are unit-testable without a live runtime.
 * @module dsh-memory-lite/src/extract/window
 */

/** The three surface event types (v6 定死, confirmed in dsh-session source). */
export const SURFACE_TYPES = ['user/message', 'assistant/message', 'tool/result'] as const
export type SurfaceEventType = (typeof SURFACE_TYPES)[number]

/** Minimal structural view of a session-log event; DSH SessionEvent satisfies it. */
export interface SurfaceEventLike {
  readonly type: string
  readonly seq: number
  readonly data: unknown
}

/** Whether an event type belongs to the message-producing surface set. */
export function isSurfaceType(type: string): type is SurfaceEventType {
  return SURFACE_TYPES.includes(type as SurfaceEventType)
}

/** Keep at most the trailing `max` items (most recent first by position). */
export function takeTail<T>(items: readonly T[], max: number): T[] {
  if (max <= 0) return []
  return items.length <= max ? [...items] : items.slice(items.length - max)
}

/**
 * Whether a surface event is real conversation content rather than a
 * system-injected message. Real user input is stamped `source.kind === 'user'`;
 * injections (runtime context, skill catalog, memory catalog, agent
 * instructions, goals) carry their own kinds and are excluded so boilerplate
 * never reaches the extraction model or inflates its cost. Assistant messages
 * and tool results are always conversation content.
 */
export function isConversationEvent(event: SurfaceEventLike): boolean {
  if (event.type !== 'user/message') return true
  const source = (event.data as { source?: { kind?: unknown } } | null)?.source
  return source?.kind === 'user'
}

/**
 * Select the extraction window: real conversation surface events with seq
 * strictly after `fromSeqExclusive`, capped to the trailing `maxMessages`.
 */
export function selectWindow(
  events: readonly SurfaceEventLike[],
  fromSeqExclusive: number,
  maxMessages: number,
): SurfaceEventLike[] {
  const selected = events.filter(event => isSurfaceType(event.type) && isConversationEvent(event) && event.seq > fromSeqExclusive)
  return takeTail(selected, maxMessages)
}

/**
 * Byte-aware truncation that never splits a UTF-8 sequence: the boundary is
 * walked back to a clean continuation start, so CJK and other multibyte text
 * stays valid (no replacement chars introduced).
 */
export function truncateBytes(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  let end = maxBytes
  while (end > 0 && end <= bytes.length && (bytes[end]! & 0b11000000) === 0b10000000) end -= 1
  return bytes.subarray(0, end).toString('utf8')
}

/** The message-content block list carried by an event, tolerant of both shapes. */
export function messageBlocksOf(data: unknown): unknown[] {
  const record = data as { message?: { content?: unknown }; content?: unknown } | null
  if (record !== null && typeof record === 'object') {
    const message = record.message
    if (typeof message === 'object' && message !== null && Array.isArray(message.content)) {
      return message.content as unknown[]
    }
    if (Array.isArray(record.content)) return record.content as unknown[]
  }
  return []
}

/** Render one content block to its text contribution. */
export function blockText(block: unknown, toolResultMaxBytes: number): string | undefined {
  if (typeof block !== 'object' || block === null) return undefined
  const b = block as { type?: string; text?: string; name?: string; id?: string; arguments?: string; content?: unknown }
  switch (b.type) {
    case 'text':
      return typeof b.text === 'string' ? b.text : undefined
    case 'tool-call': {
      const name = typeof b.name === 'string' ? b.name : '?'
      const args = typeof b.arguments === 'string' ? ' ' + truncateBytes(b.arguments, 200) : ''
      return `[tool-call ${name}${args}]`
    }
    case 'tool-result': {
      const inner = Array.isArray(b.content) ? renderBlocks(b.content, toolResultMaxBytes) : ''
      const id = typeof b.id === 'string' ? b.id : ''
      return `[tool-result ${id}] ${truncateBytes(inner, toolResultMaxBytes)}`
    }
    default:
      return undefined
  }
}

/** Concatenate block texts, truncating per `toolResultMaxBytes`. */
export function renderBlocks(blocks: readonly unknown[], toolResultMaxBytes: number): string {
  const parts: string[] = []
  for (const block of blocks) {
    const text = blockText(block, toolResultMaxBytes)
    if (text !== undefined && text !== '') parts.push(text)
  }
  return parts.join(' ')
}

/** One rendered line for an event, prefixed by its role. */
export function renderEventText(event: SurfaceEventLike, toolResultMaxBytes: number): string {
  const blocks = messageBlocksOf(event.data)
  const body = renderBlocks(blocks, toolResultMaxBytes)
  const prefix = event.type === 'user/message' ? 'user' : event.type === 'tool/result' ? 'tool' : 'assistant'
  return body === '' ? `[${prefix} (no text)]` : `[${prefix}] ${body}`
}
