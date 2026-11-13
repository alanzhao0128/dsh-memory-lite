/**
 * Parse the extraction LLM's structured output into a concrete memory
 * mutation decision. The model answers in JSON; the parser is tolerant of
 * code fences and prose, normalizes full-width braces/quotes, salvages
 * broken-brace JSON from key:value pairs, and rejects anything outside the
 * closed vocabulary.
 * @module dsh-memory-lite/src/extract/decision
 */

import type { PatchOp } from '../patch.js'

export type ExtractionDecisionKind = 'create' | 'merge' | 'update' | 'skip'

export interface CreateDecision {
  readonly kind: 'create'
  readonly category: string
  readonly title: string
  readonly content: string
  /** One-sentence description of the whole file for the L0 index (optional). */
  readonly summary?: string
}

export interface PathDecision {
  readonly kind: 'merge' | 'update'
  readonly path: string
  readonly content: string
  /** Replacement index summary; only honoured for `update` (optional). */
  readonly summary?: string
}

export interface SkipDecision {
  readonly kind: 'skip'
  readonly reason?: string
}

export type ExtractionDecision = CreateDecision | PathDecision | SkipDecision

export const DECISION_KINDS: readonly ExtractionDecisionKind[] = ['create', 'merge', 'update', 'skip']

/** Extraction decisions never delete; `forget` stays a user-only tool. */
export const DECISION_ALLOWED = new Set<string>(['create', 'merge', 'update', 'skip'])

/** Locate and parse the JSON object in the model's answer. */
export function parseDecision(text: string): ExtractionDecision {
  const json = extractJsonObject(text)
  const parsed: unknown = JSON.parse(json)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`extraction decision is not an object: ${json.slice(0, 200)}`)
  }
  const record = parsed as Record<string, unknown>
  const kind = typeof record.decision === 'string' ? record.decision : ''
  if (!DECISION_ALLOWED.has(kind)) {
    throw new Error(`extraction decision must be one of ${DECISION_KINDS.join('/')}, got ${JSON.stringify(kind)}`)
  }
  switch (kind) {
    case 'create': {
      const category = str(record.category)
      const title = str(record.title)
      const content = str(record.content)
      if (category === '' || title === '' || content === '') {
        throw new Error('create decision requires category, title, and content')
      }
      const summary = cleanSummary(record.summary)
      return { kind, category, title, content, ...(summary === undefined ? {} : { summary }) }
    }
    case 'merge':
    case 'update': {
      const path = str(record.path)
      const content = str(record.content)
      if (path === '' || content === '') {
        throw new Error(`${kind} decision requires path and content`)
      }
      const summary = cleanSummary(record.summary)
      return { kind, path, content, ...(summary === undefined ? {} : { summary }) }
    }
    default: {
      const reason = str(record.reason)
      return { kind: 'skip', ...(reason === '' ? {} : { reason }) }
    }
  }
}

/** Normalize full-width brace/quote characters the model may emit. */
function normalizeFullWidth(text: string): string {
  return text
    .replaceAll('｛', '{')
    .replaceAll('｝', '}')
    .replaceAll('\uFF02', '"')
}

/**
 * The first balanced `{...}` region in the answer (fence-free). When the
 * braces are broken (truncated or unbalanced output), falls back to rebuilding
 * a JSON object from `"key": "value"` pairs; throws only when neither works.
 */
export function extractJsonObject(text: string): string {
  const normalized = normalizeFullWidth(text)
  const balanced = scanBalanced(normalized)
  if (balanced !== undefined) return balanced
  const rebuilt = rebuildFromPairs(normalized)
  if (rebuilt !== undefined) return rebuilt
  throw new Error('extraction answer contains no JSON object')
}

/** The first balanced `{...}` region, or undefined when unbalanced. */
function scanBalanced(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return undefined
}

/** Rebuild a JSON object from complete `"key": "value"` pairs (no braces). */
function rebuildFromPairs(text: string): string | undefined {
  const pairRe = /"([A-Za-z_][A-Za-z0-9_]*)":\s*("(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?)/g
  const pairs: [string, string][] = []
  let match: RegExpExecArray | null
  while ((match = pairRe.exec(text)) !== null) {
    pairs.push([match[1]!, match[2]!])
    pairRe.lastIndex = match.index + match[0].length
  }
  if (pairs.length === 0) return undefined
  return '{' + pairs.map(([key, value]) => JSON.stringify(key) + ':' + value).join(',') + '}'
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Index summaries are one line; collapse whitespace and cap the length. */
function cleanSummary(value: unknown): string | undefined {
  const text = str(value).replaceAll(/\s+/g, ' ')
  if (text === '') return undefined
  return text.length <= 160 ? text : text.slice(0, 159) + '…'
}

/** Outcome of the reconcile call that follows a merge/update on an existing file. */
export type ReconcileDecision =
  | { readonly kind: 'noop'; readonly reason?: string }
  | { readonly kind: 'patch'; readonly ops: readonly PatchOp[]; readonly summary?: string }

/** Parse the reconcile model's answer (`noop` or `patch` with line-targeted ops). */
export function parseReconcile(text: string): ReconcileDecision {
  const parsed: unknown = JSON.parse(extractJsonObject(text))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('reconcile decision is not an object')
  }
  const record = parsed as Record<string, unknown>
  const kind = typeof record.decision === 'string' ? record.decision : ''
  if (kind === 'noop') {
    const reason = str(record.reason)
    return { kind: 'noop', ...(reason === '' ? {} : { reason }) }
  }
  if (kind !== 'patch') {
    throw new Error(`reconcile decision must be noop or patch, got ${JSON.stringify(kind)}`)
  }
  if (!Array.isArray(record.ops) || record.ops.length === 0) {
    throw new Error('patch decision requires a non-empty ops array')
  }
  const ops: PatchOp[] = record.ops.map((raw: unknown, index: number): PatchOp => {
    if (typeof raw !== 'object' || raw === null) throw new Error(`patch op ${index} is not an object`)
    const op = raw as Record<string, unknown>
    switch (op.op) {
      case 'replace':
        return { op: 'replace', line: int(op.line, index), content: nonEmpty(op.content, index) }
      case 'delete':
        return { op: 'delete', line: int(op.line, index) }
      case 'insert':
        return { op: 'insert', after: int(op.after, index), content: nonEmpty(op.content, index) }
      case 'append':
        return { op: 'append', content: nonEmpty(op.content, index) }
      default:
        throw new Error(`patch op ${index} has unknown op ${JSON.stringify(op.op)}`)
    }
  })
  const summary = cleanSummary(record.summary)
  return { kind: 'patch', ops, ...(summary === undefined ? {} : { summary }) }
}

function int(value: unknown, index: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`patch op ${index} needs an integer line number`)
  return value
}

function nonEmpty(value: unknown, index: number): string {
  const text = str(value)
  if (text === '') throw new Error(`patch op ${index} needs non-empty content`)
  return text
}
