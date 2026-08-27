/**
 * Checkpoint + audit document for one peer/session, persisted at
 * peers/{peer}/sessions/{session-id}.json. The checkpoint records the last
 * extracted log seq (resume gap-filling); the audit records each run's inputs
 * and outcome so extraction is reproducible from the session log.
 * @module dsh-memory-lite/src/extract/checkpoint
 */

export interface AuditEntry {
  /** ISO timestamp of the run. */
  readonly at: string
  /** Included window seq range [start, end]. */
  readonly windowSeq: readonly [number, number]
  /** Grep hits fed as existing memory context. */
  readonly grepHits: readonly string[]
  /** Provider/model route used, when resolvable. */
  readonly route?: { readonly provider: string; readonly model: string }
  /** maxTokens sent on the extraction request. */
  readonly maxTokens?: number
  /** The parsed decision kind, or the failure note. */
  readonly decision: string
  /** Target memory path when the decision addressed one. */
  readonly path?: string
  /** The log seq the checkpoint advanced to after this run. */
  readonly seq: number
  /** Failure/retry context (successful runs omit it). */
  readonly note?: string
  /** Number of LLM stream calls made for this run (1, or 2 when a repair ran). */
  readonly llmCalls?: number
  /** Total input tokens (real stream usage when available, else bytes/3 estimate). */
  readonly inputTokens?: number
  /** Total output tokens (real stream usage when available, else bytes/3 estimate). */
  readonly outputTokens?: number
  /** Cache-read tokens reported by the provider. */
  readonly cacheReadTokens?: number
  /** Cache-write tokens reported by the provider. */
  readonly cacheWriteTokens?: number
  /** Run wall-clock duration in ms. */
  readonly durationMs?: number
}

export interface CheckpointFile {
  readonly version: 1
  readonly checkpoint: { readonly seq: number }
  readonly digest: string
  readonly audit: readonly AuditEntry[]
}

export const CHECKPOINT_VERSION = 1
/** Cap on retained audit entries per session, bounding file size. */
export const MAX_AUDIT_ENTRIES = 50

export function emptyCheckpoint(): CheckpointFile {
  return { version: CHECKPOINT_VERSION, checkpoint: { seq: 0 }, digest: '', audit: [] }
}

/** Append an audit entry and advance the checkpoint; returns a new document. */
export function withRun(state: CheckpointFile, seq: number, entry: Omit<AuditEntry, 'seq'>): CheckpointFile {
  const audit = [...state.audit, { ...entry, seq }]
  if (audit.length > MAX_AUDIT_ENTRIES) audit.splice(0, audit.length - MAX_AUDIT_ENTRIES)
  return { version: CHECKPOINT_VERSION, checkpoint: { seq }, digest: state.digest, audit }
}

/** Serialize the document for atomic write. */
export function renderCheckpoint(state: CheckpointFile): string {
  return JSON.stringify(state, null, 2) + '\n'
}

/** Parse a persisted document; tolerant of malformed input (degrades to empty). */
export function parseCheckpoint(text: string): CheckpointFile {
  try {
    const value: unknown = JSON.parse(text)
    if (typeof value !== 'object' || value === null) return emptyCheckpoint()
    const record = value as Record<string, unknown>
    const checkpoint = record.checkpoint as Record<string, unknown> | undefined
    const seq = typeof checkpoint?.seq === 'number' && Number.isSafeInteger(checkpoint.seq) ? checkpoint.seq : 0
    const digest = typeof record.digest === 'string' ? record.digest : ''
    const audit = Array.isArray(record.audit) ? record.audit : []
    return { version: CHECKPOINT_VERSION, checkpoint: { seq }, digest, audit: audit as AuditEntry[] }
  } catch {
    return emptyCheckpoint()
  }
}
