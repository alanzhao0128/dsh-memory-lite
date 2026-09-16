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
 * The injected catalog message uses the OFFICIAL `plugin` source kind with the
 * `catalog` form (see catalog.ts), so released session-format migrations can
 * always classify and carry it. The private `memory-catalog` kind written
 * before 0.2.3 is read back for old sessions but never written again.
 */
