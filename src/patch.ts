/**
 * Pure helpers for editing a memory's Current section: list-marker
 * normalisation, line-key comparison, and line-targeted patch operations.
 * No I/O here; {@link MemoryStore} wraps these with archive and write logic.
 * @module dsh-memory-lite/src/patch
 */

/** One edit against the numbered lines of a Current section (1-based). */
export type PatchOp =
  | { readonly op: 'replace'; readonly line: number; readonly content: string }
  | { readonly op: 'delete'; readonly line: number }
  | { readonly op: 'insert'; readonly after: number; readonly content: string }
  | { readonly op: 'append'; readonly content: string }

/** A patch that cannot be applied safely; the target file is left untouched. */
export class PatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PatchError'
  }
}

/** Upper bound on operations in one patch (keeps a runaway answer bounded). */
export const MAX_PATCH_OPS = 20

/** Replacing a line of at least this many characters with less than {@link MIN_REPLACE_RATIO} of its length is rejected. */
export const MIN_SHRINK_CHECK_CHARS = 120
export const MIN_REPLACE_RATIO = 0.5

const STRUCTURAL = /^(?:[-*+]|\d+[.)])\s|^#{1,6}\s|^>|^\||^```/

/**
 * Turn free-form content into Current lines. Lines that already carry
 * structure (list marker, heading, quote, table row, code fence) or are
 * indented keep their shape; plain lines become `- ` bullets. Blank lines are
 * dropped. This replaces the old "prefix every line with `- `" rule that
 * produced `- - -` nesting when the model already wrote a list.
 */
export function bulletLines(content: string): string[] {
  const out: string[] = []
  for (const raw of content.split('\n')) {
    const line = raw.trimEnd()
    if (line.trim() === '') continue
    if (/^\s+\S/.test(line) || STRUCTURAL.test(line)) out.push(line)
    else out.push(`- ${line}`)
  }
  return out
}

/** Comparison key for a line: list markers and surrounding whitespace removed. */
export function lineKey(line: string): string {
  return line.replace(/^\s*(?:(?:[-*+]|\d+[.)])\s+)+/, '').trim()
}

/** Prompt-ready numbered view of a Current section; blank lines are skipped but keep their numbers. */
export interface NumberedView {
  readonly text: string
  /** True when lines were shortened to fit the byte budget. */
  readonly truncated: boolean
}

/**
 * Render `current` as `N| line` rows. When the full text exceeds `maxBytes`
 * each line is shortened to 160 characters; when even that does not fit the
 * section is too large to reconcile and `undefined` is returned.
 */
export function numberedView(current: string, maxBytes: number): NumberedView | undefined {
  const lines = current.split('\n')
  const render = (limit: number): string =>
    lines
      .map((line, index) => [index + 1, line.trimEnd()] as const)
      .filter(([, line]) => line.trim() !== '')
      .map(([n, line]) => `${n}| ${limit > 0 && line.length > limit ? line.slice(0, limit) + '…' : line}`)
      .join('\n')
  const full = render(0)
  if (Buffer.byteLength(full) <= maxBytes) return { text: full, truncated: false }
  const short = render(160)
  if (Buffer.byteLength(short) <= maxBytes) return { text: short, truncated: true }
  return undefined
}

/** Result of {@link applyPatch}. */
export interface PatchResult {
  readonly lines: string[]
  readonly replaced: number
  readonly deleted: number
  readonly added: number
}

/**
 * Apply `ops` to the Current `lines`. Every line reference is validated
 * against the original numbering first. A patch that removes more than half of
 * the existing lines (and more than two) is rejected as a likely mistake.
 * `append` and `insert` lines already present in the section are skipped.
 */
export function applyPatch(lines: readonly string[], ops: readonly PatchOp[]): PatchResult {
  if (ops.length === 0) return { lines: [...lines], replaced: 0, deleted: 0, added: 0 }
  if (ops.length > MAX_PATCH_OPS) throw new PatchError(`patch has ${ops.length} operations (max ${MAX_PATCH_OPS})`)
  const total = lines.length
  const replacements = new Map<number, string[]>()
  const deletions = new Set<number>()
  const insertions = new Map<number, string[]>()
  const appended: string[] = []
  for (const op of ops) {
    switch (op.op) {
      case 'replace': {
        assertLine(op.line, total, 'replace')
        if (replacements.has(op.line) || deletions.has(op.line)) throw new PatchError(`line ${op.line} is edited more than once`)
        const original = lines[op.line - 1] ?? ''
        const body = replacementLines(original, op.content)
        if (body.length === 0) throw new PatchError(`replace of line ${op.line} has empty content`)
        // A rewrite that drops most of a long line almost certainly loses facts;
        // the model can delete + append instead, or the change falls back to append.
        const newLength = body.join('\n').length
        if (original.length >= MIN_SHRINK_CHECK_CHARS && newLength < original.length * MIN_REPLACE_RATIO) {
          throw new PatchError(`replace of line ${op.line} shrinks it from ${original.length} to ${newLength} characters`)
        }
        replacements.set(op.line, body)
        break
      }
      case 'delete': {
        assertLine(op.line, total, 'delete')
        if (replacements.has(op.line) || deletions.has(op.line)) throw new PatchError(`line ${op.line} is edited more than once`)
        deletions.add(op.line)
        break
      }
      case 'insert': {
        if (!Number.isInteger(op.after) || op.after < 0 || op.after > total) {
          throw new PatchError(`insert position ${op.after} is outside 0..${total}`)
        }
        const body = bulletLines(op.content)
        if (body.length === 0) throw new PatchError('insert has empty content')
        insertions.set(op.after, [...(insertions.get(op.after) ?? []), ...body])
        break
      }
      case 'append': {
        const body = bulletLines(op.content)
        if (body.length === 0) throw new PatchError('append has empty content')
        appended.push(...body)
        break
      }
    }
  }
  const existing = lines.filter(line => line.trim() !== '').length
  if (deletions.size > Math.max(2, Math.floor(existing / 2))) {
    throw new PatchError(`patch deletes ${deletions.size} of ${existing} lines; refusing`)
  }
  const kept = new Set<string>()
  for (let index = 0; index < total; index += 1) {
    if (!deletions.has(index + 1)) kept.add(lineKey(lines[index] ?? ''))
  }
  const fresh = (body: string[]): string[] =>
    body.filter(line => {
      const key = lineKey(line)
      if (key === '' || kept.has(key)) return false
      kept.add(key)
      return true
    })
  const out: string[] = []
  let added = 0
  const top = fresh(insertions.get(0) ?? [])
  out.push(...top)
  added += top.length
  for (let index = 1; index <= total; index += 1) {
    if (!deletions.has(index)) {
      const replacement = replacements.get(index)
      out.push(...(replacement ?? [lines[index - 1] ?? '']))
    }
    const after = fresh(insertions.get(index) ?? [])
    out.push(...after)
    added += after.length
  }
  const tail = fresh(appended)
  out.push(...tail)
  added += tail.length
  if (out.every(line => line.trim() === '')) throw new PatchError('patch would empty the section')
  return { lines: out, replaced: replacements.size, deleted: deletions.size, added }
}

function assertLine(line: number, total: number, op: string): void {
  if (!Number.isInteger(line) || line < 1 || line > total) {
    throw new PatchError(`${op} targets line ${line}, outside 1..${total}`)
  }
}

/**
 * Lines that replace `original`. A single plain line inherits the original's
 * indentation and list marker so nested bullets stay nested.
 */
function replacementLines(original: string, content: string): string[] {
  const trimmed = content.trim()
  if (trimmed !== '' && !trimmed.includes('\n') && !STRUCTURAL.test(trimmed) && !/^\s+\S/.test(content)) {
    const lead = /^\s*(?:(?:[-*+]|\d+[.)])\s+)?/.exec(original)?.[0] ?? '- '
    return [`${lead === '' ? '- ' : lead}${trimmed}`]
  }
  return bulletLines(content)
}
