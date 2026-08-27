/**
 * Memory health tracker for the sidebar indicator (Phase: indicator v1).
 *
 * A single "last event" decides the light: the most recent extraction run
 * outcome (fed by recordRun) or an unexpected pipeline exception (fed by the
 * runExtraction catch). No state machine, no file reads — "no data yet" is
 * simply green (not an error, not disabled).
 * @module dsh-memory-lite/src/status
 */

/** Run outcomes that count as healthy (green). Everything else is an error. */
const OK_OUTCOMES = new Set([
  'create',
  'merge',
  'update',
  'skip',
  'parse-error-recovered',
])

/** One recorded event: a run outcome or an unexpected exception. */
export interface StatusEvent {
  /** Wall-clock ms when the event happened. */
  at: number
  /** Whether this event is healthy. */
  ok: boolean
  /** Run decision kind or 'error' for exceptions. */
  outcome: string | null
  /** Error detail (llm-error reason, exception text, …). */
  note: string | null
}

/** The indicator's three-state view. */
export type StatusKind = 'ok' | 'error' | 'disabled'

/** Snapshot served to the browser via the /memory-status RPC channel. */
export interface MemoryStatusSnapshot {
  /** Extraction mode from the resolved config. */
  mode: 'incremental' | 'explicit_only' | 'off'
  /** Most recent event, or null when nothing has run yet this process. */
  last: StatusEvent | null
  /**
   * disabled = mode off/explicit_only (gray); error = last event failed
   * (red); ok = incremental and no failing event (green, including no data).
   */
  status: StatusKind
}

export interface StatusTracker {
  /** Record one extraction run outcome (decision/parse/apply/route result). */
  reportRun(outcome: string, note: string | null, decision: string | null): void
  /** Record an unexpected pipeline exception (outside the recorded-run path). */
  reportError(note: string): void
  /** Derive the three-state snapshot for the current mode. */
  snapshot(mode: 'incremental' | 'explicit_only' | 'off'): MemoryStatusSnapshot
}

/** Create the tracker; one instance per plugin apply (process lifetime). */
export function createStatusTracker(): StatusTracker {
  let last: StatusEvent | null = null
  return {
    reportRun(outcome, note, decision) {
      last = {
        at: Date.now(),
        ok: OK_OUTCOMES.has(outcome),
        outcome: decision ?? outcome,
        note,
      }
    },
    reportError(note) {
      last = { at: Date.now(), ok: false, outcome: 'error', note }
    },
    snapshot(mode) {
      return {
        mode,
        last,
        status: mode === 'incremental' ? (last === null || last.ok ? 'ok' : 'error') : 'disabled',
      }
    },
  }
}
