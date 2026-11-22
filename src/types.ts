/**
 * Shared type contracts for dsh-memory-lite v1.0 (Unified Topic Vault).
 * @module dsh-memory-lite/src/types
 */

/** Special top-level topic that is always expanded in L0 catalogs. */
export const PREFERENCES_TOPIC = 'preferences'

/** Default top-level namespace for sensitive/private topics (`private/<subtopic>`). */
export const DEFAULT_PRIVATE_NAMESPACE = 'private'

/** One L0 index entry: a memory file, its owning topic, and its one-line summary. */
export interface IndexEntry {
  /** Owning topic directory relative to memories root, e.g. `infra`, `g7`, `private/health`. */
  readonly topic: string
  /** Memory file path relative to `<root>/memories/`, e.g. `infra/cpa.md` or `private/health/checkup.md`. */
  readonly path: string
  /** One-line summary rendered in the L0 catalog. */
  readonly summary: string
}

/** One collapsed topic line rendered in adaptive Topic Map mode when the vault exceeds L0 token budget. */
export interface CollapsedTopicNotice {
  readonly topic: string
  readonly count: number
  readonly previewTitles: readonly string[]
}

/** Evaluated trust boundary for a session, tool call, or extraction run. */
export interface TrustContext {
  /** When true, the entire private namespace is invisible and non-writable. */
  readonly restricted: boolean
  /** Why restricted mode triggered (for diagnostics/UI). */
  readonly reason?: 'hidePrivate' | 'provider' | 'path'
  /** Optional private topic forced when writing/extracting inside a configured `privacy.privatePaths` cwd. */
  readonly forcedPrivateTopic?: string
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
