/**
 * Pure trigger decisions for implicit extraction. The integration layer owns
 * event wiring and job dispatch; these functions own the arithmetic (message
 * counts, turn-boundary thresholds, debounce, idle) so they are unit-testable.
 * @module dsh-memory-lite/src/extract/triggers
 */

/** Window trigger: enough new surface messages accumulated. */
export function shouldExtractWindow(pendingCount: number, windowTurns: number): boolean {
  return pendingCount >= windowTurns
}

/**
 * Turn-boundary trigger: at least `minTurnExtract` unextracted messages and
 * outside the `turnDebounceMs` window since the last extraction.
 */
export function shouldExtractTurn(
  pendingCount: number,
  now: number,
  lastExtractAt: number | null,
  minTurnExtract: number,
  turnDebounceMs: number,
): boolean {
  if (pendingCount < minTurnExtract) return false
  if (lastExtractAt !== null && now - lastExtractAt < turnDebounceMs) return false
  return true
}

/** Idle trigger: anything left unextracted. */
export function shouldExtractIdle(pendingCount: number): boolean {
  return pendingCount > 0
}
