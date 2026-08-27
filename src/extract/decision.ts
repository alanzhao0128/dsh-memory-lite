/**
 * Parse the extraction LLM's structured output into a concrete memory
 * mutation decision. The model answers in JSON; the parser is tolerant of
 * code fences and prose, normalizes full-width braces/quotes, salvages
 * broken-brace JSON from key:value pairs, and rejects anything outside the
 * closed vocabulary.
 * @module dsh-memory-lite/src/extract/decision
 */

export type ExtractionDecisionKind = 'create' | 'merge' | 'update' | 'skip'

export interface CreateDecision {
  readonly kind: 'create'
  readonly category: string
  readonly title: string
  readonly content: string
}

export interface PathDecision {
  readonly kind: 'merge' | 'update'
  readonly path: string
  readonly content: string
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
      return { kind, category, title, content }
    }
    case 'merge':
    case 'update': {
      const path = str(record.path)
      const content = str(record.content)
      if (path === '' || content === '') {
        throw new Error(`${kind} decision requires path and content`)
      }
      return { kind, path, content }
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
