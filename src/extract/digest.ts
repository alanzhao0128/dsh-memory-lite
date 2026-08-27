/**
 * Rolling session digest: a bounded ~100-token summary carried between
 * extraction runs so later windows can resolve cross-window references.
 * Token length is approximated as bytes/3 (CJK 1 token, ASCII ~4 chars).
 * @module dsh-memory-lite/src/extract/digest
 */

/** Rough token-length estimate for mixed CJK/ASCII text. */
export function digestApproxTokens(text: string): number {
  const bytes = Buffer.byteLength(text, 'utf8')
  return Math.ceil(bytes / 3)
}

/** Shrink the digest until it fits `maxTokens` (progressive halving). */
export function truncateDigest(text: string, maxTokens: number): string {
  let current = text.trim()
  while (current.length > 0 && digestApproxTokens(current) > maxTokens) {
    current = current.slice(0, Math.floor(current.length * 0.8)).trim()
  }
  return current
}

/** Roll the digest forward: previous digest + this window, re-truncated. */
export function rollDigest(prev: string, windowText: string, maxTokens: number): string {
  const combined = prev === '' ? windowText : `${prev}\n${windowText}`
  return truncateDigest(combined, maxTokens)
}
