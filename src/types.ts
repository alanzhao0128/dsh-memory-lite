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
 * The injected catalog message uses the producer-owned `plugin:dsh-memory-lite`
 * source kind with the `catalog` form (see catalog.ts), conforming to dsh 0.1.7
 * session format v4 rules while preserving backward compatibility with v3.
 * Pre-0.2.3 `memory-catalog` and 0.2.3–0.3.0 `{ kind: 'plugin', plugin: 'dsh-memory-lite' }`
 * remain recognized on read.
 */
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-memory-lite': {
      kind: 'plugin:dsh-memory-lite'
      form?: 'catalog'
    }
  }
}
