/**
 * Catalog-summary primitives shared by the tools, the store, and implicit
 * extraction: the `⚠stale` marker, the keep-or-rewrite verdict, and the
 * parser that normalizes a model-supplied summary field into a verdict.
 * @module dsh-memory-lite/src/summary
 */

/** Marker appended to an index summary whose file body changed without a confirmed re-judgement. */
export const STALE_MARK = ' ⚠stale'

/** Longest catalog summary kept, in characters (longer ones are cut to 159 + `…`). */
export const SUMMARY_MAX_CHARS = 160

/** An explicit judgement of the catalog summary after a body change: keep it, or replace it. */
export type SummaryVerdict = { readonly kind: 'keep' } | { readonly kind: 'set'; readonly text: string }

const STALE_PATTERN = /\s*⚠stale\s*$/u

/** Remove a trailing {@link STALE_MARK} (if any) from a summary. */
export function stripStale(summary: string): string {
  return summary.replace(STALE_PATTERN, '')
}

/** Whether a summary carries the trailing {@link STALE_MARK}. */
export function isStale(summary: string): boolean {
  return STALE_PATTERN.test(summary)
}

/**
 * Normalize a model-supplied `summary` field into a verdict. `keep` (any case)
 * or `=` keeps the current summary; any other non-empty string becomes the new
 * one (whitespace flattened, a trailing stale marker stripped, long text cut).
 * Empty or non-string input yields `undefined` ("no judgement given").
 */
export function parseSummaryField(value: unknown): SummaryVerdict | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  if (trimmed === '=' || trimmed.toLowerCase() === 'keep') return { kind: 'keep' }
  const text = stripStale(trimmed.replaceAll(/\s+/g, ' ')).trim()
  if (text === '') return undefined
  return { kind: 'set', text: text.length <= SUMMARY_MAX_CHARS ? text : text.slice(0, SUMMARY_MAX_CHARS - 1) + '…' }
}
