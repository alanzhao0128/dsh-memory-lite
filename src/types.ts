/**
 * Shared type contracts for dsh-memory-lite.
 * @module dsh-memory-lite/src/types
 */

/** The four memory categories the plugin generates. */
export const MEMORY_CATEGORIES = ['preferences', 'entities', 'events', 'experiences'] as const

/** One memory category name. */
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number]

/** One L0 index entry: a memory file and its one-line summary. */
export interface IndexEntry {
  /** First path segment of {@link path} (the containing directory). */
  readonly category: string
  /** Memory file path relative to the peer's memories root, e.g. `preferences/coding.md`. */
  readonly path: string
  /** One-line summary rendered in the L0 catalog. */
  readonly summary: string
}

/**
 * Durable provider record for one published memory catalog message: the
 * entries it published beside the model-facing prose, so a consumer never
 * re-parses the `<system-reminder>` framing, whose prose exists for the model.
 */
export interface MemoryCatalogSource {
  readonly kind: 'memory-catalog'
  readonly form: 'catalog'
  /** Marks a replacement catalog rather than this session's first publication. */
  readonly update?: true
  /** Exactly the entries this message published, in catalog order. */
  readonly entries: readonly IndexEntry[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'memory-catalog': MemoryCatalogSource
  }
}
