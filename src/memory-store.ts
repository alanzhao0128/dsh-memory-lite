/**
 * The on-disk memory tree: containment, atomic writes through a serial queue,
 * L0 index management, and line search. Instances are created per plugin mount
 * and closed over by the tools and the pre-step injector.
 * @module dsh-memory-lite/src/memory-store
 */

import { readFile as readFileNode, readdir, rename, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import type { IndexEntry } from './types.js'
import type { SharingConfig } from './config.js'
import { containWithin, ensureDir, MemoryPathError, realpathSafe } from './path.js'

/** Serialize mutations so writers never interleave inside one memory tree. */
export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** Run `op` after every previously queued operation; errors isolate per call. */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Cap on retained summary-log lines per peer (bounds the rolling log). */
export const MAX_LOG_LINES = 5000

/** One line-level search hit. */
export interface SearchMatch {
  /** Memory path relative to the peer's memories root. */
  readonly path: string
  /** The matching line, capped in length. */
  readonly line: string
}

/** The known sections of a memory file; extra content is preserved verbatim. */
export interface MemoryFileSections {
  /** H1 title text ('' when absent). */
  title: string
  /** Current-section body ('' when absent). */
  current: string
  /** History-section body ('' when absent). */
  history: string
  /** Related-section body ('' when absent). */
  related: string
  /** Preamble plus any unknown `## section` bodies, preserved. */
  extra: string
}

/** Parse a memory file into its sections; unknown sections survive in {@link MemoryFileSections.extra}. */
export function parseMemoryFile(text: string): MemoryFileSections {
  const lines = text.split('\n')
  const title = lines[0]?.startsWith('# ') ? lines[0].slice(2).trim() : ''
  const sections = new Map<string, string[]>()
  const preamble: string[] = []
  let currentName: string | undefined
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]!
    const match = /^## (.+)$/.exec(line)
    if (match !== null) {
      currentName = match[1]!.trim()
      sections.set(currentName, [])
      continue
    }
    if (currentName === undefined) preamble.push(line)
    else sections.get(currentName)!.push(line)
  }
  const unknown: string[] = []
  for (const [name, body] of sections) {
    if (name !== 'Current' && name !== 'History' && name !== 'Related') {
      unknown.push(`## ${name}\n${body.join('\n')}`)
    }
  }
  const extra = [preamble.join('\n').trim(), unknown.join('\n\n')].filter(part => part !== '').join('\n\n')
  return {
    title,
    current: (sections.get('Current') ?? []).join('\n').trim(),
    history: (sections.get('History') ?? []).join('\n').trim(),
    related: (sections.get('Related') ?? []).join('\n').trim(),
    extra,
  }
}

/**
 * Normalize a tool-supplied "new content" value. Models sometimes pass a full
 * rendered memory file (an H1 title line plus `## Current` etc.) instead of
 * the plain new body; detect that shape and extract the Current section body
 * so it is stored as the section's content rather than nested as a literal
 * bullet. Plain text passes through unchanged.
 */
export function normalizeContent(content: string): string {
  const trimmed = content.trim()
  const firstLine = trimmed.split('\n')[0] ?? ''
  const looksLikeFullFile = firstLine.startsWith('# ') && /^## /m.test(trimmed)
  if (!looksLikeFullFile) return trimmed
  const parsed = parseMemoryFile(trimmed)
  return parsed.current !== '' ? parsed.current : trimmed
}

/** Render parsed sections back into a canonical memory file (always ends with one newline). */
export function renderMemoryFile(sections: MemoryFileSections): string {
  const parts: string[] = [`# ${sections.title === '' ? 'Memory' : sections.title}`, '']
  if (sections.current !== '') parts.push('## Current', sections.current, '')
  if (sections.history !== '') parts.push('## History', sections.history, '')
  if (sections.related !== '') parts.push('## Related', sections.related, '')
  if (sections.extra !== '') parts.push(sections.extra, '')
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '\n')
}

/** One-line summary of content for the L0 index. */
export function summaryOf(content: string, maxLength = 100): string {
  const normalized = content.replaceAll(/\s+/g, ' ').trim()
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 3)}...`
}

/** Render the L0 index document for one peer. */
export function renderIndex(peer: string, entries: readonly IndexEntry[], now: Date): string {
  const hints: Record<string, string> = {
    preferences: '(always relevant)',
    entities: '(relevant when mentioned)',
    events: '(relevant for time queries)',
    experiences: '(relevant for similar tasks)',
  }
  const lines: string[] = [`# Memory Index — ${peer}`, '', `> Last updated: ${now.toISOString()} | Total: ${entries.length}`, '']
  const byCategory = new Map<string, IndexEntry[]>()
  for (const entry of entries) {
    const list = byCategory.get(entry.category)
    if (list === undefined) byCategory.set(entry.category, [entry])
    else list.push(entry)
  }
  for (const [category, list] of byCategory) {
    lines.push(`## ${category}${hints[category] !== undefined ? ' ' + hints[category] : ''}`)
    for (const entry of list) lines.push(`- ${entry.path}: ${entry.summary}`)
    lines.push('')
  }
  return lines.join('\n').replace(/\n+$/, '\n')
}

/** Parse L0 index entries from an index document; malformed lines are ignored (tolerant of human edits). */
export function parseIndex(text: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  const linePattern = /^- (.+\.md): (.*)$/
  for (const line of text.split('\n')) {
    const match = linePattern.exec(line)
    if (match === null) continue
    const path = match[1]!.trim()
    if (path === '' || path.startsWith('/') || path.includes('..')) continue
    const category = path.split('/')[0] ?? ''
    if (category === '') continue
    entries.push({ category, path, summary: match[2]!.trim() })
  }
  return entries
}

/**
 * A filesystem-safe slug from a title, used as the memory file basename.
 * Keeps Unicode letters and numbers (Chinese titles yield CJK filenames
 * instead of collapsing to the bare 'memory' fallback, which would collide).
 */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
  return slug === '' ? 'memory' : slug.slice(0, 80)
}

/**
 * Owns the on-disk memory tree for every peer under one root. All mutations
 * run through {@link MutationQueue}; every read/write goes through
 * {@link MemoryStore.resolve} (the containment boundary).
 */
export class MemoryStore {
  readonly root: string
  private readonly queue = new MutationQueue()
  readonly sharing: SharingConfig

  constructor(root: string, sharing: SharingConfig = { enabled: false, mounts: [] }) {
    this.root = root
    this.sharing = sharing
  }

  peersDir(): string {
    return join(this.root, 'peers')
  }

  memoriesRoot(peer: string): string {
    return join(this.root, 'peers', peer, 'memories')
  }

  sessionsDir(peer: string): string {
    return join(this.root, 'peers', peer, 'sessions')
  }

  trashDir(): string {
    return join(this.root, '.trash')
  }

  /**
   * Contain and resolve a tool-supplied relative path inside one peer's memories
   * root. Paths under `shared/<name>/...` are redirected (Phase 3 sharing) to
   * the declared target peer's memories root; the model-facing relative path
   * keeps the `shared/<name>` prefix so tool output stays source-annotated.
   * `opts.write` marks a mutation so read-only mounts are rejected.
   */
  async resolve(peer: string, relPath: string, opts: { write?: boolean } = {}): Promise<{ abs: string; rel: string }> {
    if (extname(relPath).toLowerCase() !== '.md') {
      throw new MemoryPathError(`memory path must end in .md: ${JSON.stringify(relPath)}`)
    }
    if (relPath.startsWith('shared/')) {
      return this.resolveShared(peer, relPath, opts)
    }
    const memories = this.memoriesRoot(peer)
    await ensureDir(memories)
    // containWithin returns the canonical (realpath'd) target; compute the
    // relative path against the canonical root so /tmp vs /private/tmp and
    // other symlinked ancestors never leak into tool-facing paths.
    const memoriesReal = await realpathSafe(memories)
    const abs = await containWithin(memories, relPath)
    return { abs, rel: relative(memoriesReal, abs) }
  }

  /** Resolve a `shared/<name>/...` path against the declared mount, enforcing read-only. */
  private async resolveShared(peer: string, relPath: string, opts: { write?: boolean }): Promise<{ abs: string; rel: string }> {
    if (!this.sharing.enabled) {
      throw new MemoryPathError('shared/ paths are disabled (sharing.enabled = false)')
    }
    const rest = relPath.slice('shared/'.length)
    const slash = rest.indexOf('/')
    if (slash <= 0) {
      throw new MemoryPathError(`shared path must be shared/<name>/<file>.md: ${JSON.stringify(relPath)}`)
    }
    const name = rest.slice(0, slash)
    const inner = rest.slice(slash + 1)
    const mount = this.sharing.mounts.find(mount => mount.name === name)
    if (mount === undefined) {
      throw new MemoryPathError(`unknown shared mount ${JSON.stringify(name)}`)
    }
    if (mount.peer === peer) {
      throw new MemoryPathError(`a peer cannot access its own memories via shared/`)
    }
    if (opts.write === true && mount.readonly) {
      throw new MemoryPathError(`shared mount ${JSON.stringify(name)} is read-only`)
    }
    const targetMemories = this.memoriesRoot(mount.peer)
    await ensureDir(targetMemories)
    const subpath = mount.subpath === '' || mount.subpath === '.' ? '' : mount.subpath + '/'
    const targetAbs = await containWithin(targetMemories, subpath + inner)
    return { abs: targetAbs, rel: relPath }
  }

  async fileExists(peer: string, relPath: string): Promise<boolean> {
    const { abs } = await this.resolve(peer, relPath)
    try {
      return (await stat(abs)).isFile()
    } catch {
      return false
    }
  }

  async readFile(peer: string, relPath: string): Promise<{ content: string; rel: string }> {
    const { abs, rel } = await this.resolve(peer, relPath)
    let content: string
    try {
      content = await readFileNode(abs, 'utf8')
    } catch (error) {
      throw new MemoryPathError(`cannot read memory ${JSON.stringify(relPath)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { content, rel }
  }

  /** Create a new memory file with the canonical skeleton. */
  writeNewMemory(peer: string, relPath: string, title: string, content: string): Promise<void> {
    const bullets = content.split('\n').map(line => `- ${line}`).join('\n')
    return this.queue.enqueue(async () => {
      await this.writeNow(peer, relPath, `# ${title}\n\n## Current\n${bullets}\n\n## History\n\n## Related\n`)
    })
  }

  /**
   * Append content as new Current bullets; creates the section when absent.
   * Identical lines already in Current are skipped (no-op writes are dropped).
   */
  appendCurrent(peer: string, relPath: string, content: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const existing = await this.readFile(peer, relPath)
      const parsed = parseMemoryFile(existing.content)
      const bullets = content.split('\n').map(line => `- ${line}`)
      const seen = new Set(parsed.current.split('\n').filter(line => line !== ''))
      const fresh = bullets.filter(bullet => !seen.has(bullet))
      if (fresh.length === 0) return
      parsed.current = parsed.current === '' ? fresh.join('\n') : `${parsed.current}\n${fresh.join('\n')}`
      await this.writeNow(peer, existing.rel, renderMemoryFile(parsed))
    })
  }

  /**
   * Replace a memory's current content, archiving the previous current into
   * History with a date. The previous content is never destroyed (ADD-only).
   */
  updateCurrent(peer: string, relPath: string, content: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const existing = await this.readFile(peer, relPath)
      const parsed = parseMemoryFile(existing.content)
      const date = new Date().toISOString().slice(0, 10)
      if (parsed.current !== '') {
        const oldLines = parsed.current.split('\n')
        const entry = `- ${date}: ${oldLines[0]}`
        const continuation = oldLines.slice(1).map(line => `  ${line}`).join('\n')
        const historyEntry = continuation === '' ? entry : `${entry}\n${continuation}`
        parsed.history = parsed.history === '' ? historyEntry : `${parsed.history}\n${historyEntry}`
      }
      parsed.current = content.split('\n').map(line => `- ${line}`).join('\n')
      await this.writeNow(peer, existing.rel, renderMemoryFile(parsed))
    })
  }

  /**
   * Validate a session id and resolve its checkpoint/audit file under
   * sessionsDir; the id is constrained so it can never escape the directory.
   */
  sessionCheckpointPath(peer: string, sessionId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(sessionId)) {
      throw new MemoryPathError('invalid session id ' + JSON.stringify(sessionId))
    }
    return join(this.sessionsDir(peer), sessionId + '.json')
  }

  /** Read a session checkpoint document; a missing file reads as undefined. */
  async readSessionCheckpoint(peer: string, sessionId: string): Promise<string | undefined> {
    const abs = this.sessionCheckpointPath(peer, sessionId)
    try {
      return await readFileNode(abs, 'utf8')
    } catch {
      return undefined
    }
  }

  /** Persist a session checkpoint/audit document through the serial queue. */
  writeSessionCheckpoint(peer: string, sessionId: string, text: string): Promise<void> {
    const abs = this.sessionCheckpointPath(peer, sessionId)
    return this.queue.enqueue(async () => {
      await ensureDir(dirname(abs))
      await writeFileAtomic(abs, text, { mode: 0o600, dirMode: 0o700 })
    })
  }

  /** Peer-level rolling run log: peers/{peer}/sessions/extraction.log. */
  summaryLogPath(peer: string): string {
    return join(this.sessionsDir(peer), 'extraction.log')
  }

  /** Append one JSON line to the peer's extraction summary log (capped). */
  appendExtractionLog(peer: string, line: string): Promise<void> {
    const abs = this.summaryLogPath(peer)
    return this.queue.enqueue(async () => {
      await ensureDir(dirname(abs))
      let existing = ''
      try {
        existing = await readFileNode(abs, 'utf8')
      } catch {
        // first entry
      }
      const lines = existing === '' ? [] : existing.split('\n').filter(l => l.trim() !== '')
      lines.push(line.trim())
      if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES)
      await writeFileAtomic(abs, lines.join('\n') + '\n', { mode: 0o600, dirMode: 0o700 })
    })
  }

  /**
   * Diagnostic: append one failed extraction answer (the raw model output that
   * parseDecision rejected) to peers/{peer}/sessions/failed-answers.log, capped.
   * Only written when the answer was not salvageable; used to debug parse-error
   * spikes. Not part of the functional path — callers tolerate failures.
   */
  failedAnswerLogPath(peer: string): string {
    return join(this.sessionsDir(peer), 'failed-answers.log')
  }

  appendFailedAnswer(peer: string, entry: object): Promise<void> {
    const abs = this.failedAnswerLogPath(peer)
    return this.queue.enqueue(async () => {
      await ensureDir(dirname(abs))
      let existing = ''
      try {
        existing = await readFileNode(abs, 'utf8')
      } catch {
        // first entry
      }
      const lines = existing === '' ? [] : existing.split('\n').filter(l => l.trim() !== '')
      lines.push(JSON.stringify(entry))
      if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES)
      await writeFileAtomic(abs, lines.join('\n') + '\n', { mode: 0o600, dirMode: 0o700 })
    }).catch(() => {})
  }

  /** Soft-delete: move the file under root/.trash/<date>/, never overwriting. */
  softDelete(peer: string, relPath: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const { abs, rel } = await this.resolve(peer, relPath, { write: true })
      const day = new Date().toISOString().slice(0, 10)
      const destDir = join(this.trashDir(), day)
      await ensureDir(destDir)
      const dest = join(destDir, `${basename(rel)}.${Date.now().toString(36)}`)
      await rename(abs, dest)
    })
  }

  /** Parse the L0 index for one peer; a missing index reads as empty. */
  async readIndex(peer: string): Promise<IndexEntry[]> {
    const memories = this.memoriesRoot(peer)
    await ensureDir(memories)
    try {
      return parseIndex(await readFileNode(join(memories, '_index.md'), 'utf8'))
    } catch {
      return []
    }
  }

  /** Rebuild the L0 index from entries, sorted by file mtime (newest first). */
  rebuildIndex(peer: string, entries: readonly IndexEntry[]): Promise<void> {
    return this.queue.enqueue(async () => this.writeIndexNow(peer, entries))
  }

  /** Add or replace one entry, then rebuild. */
  refreshIndexEntry(peer: string, relPath: string, summary: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const entries = await this.readIndex(peer)
      const category = relPath.split('/')[0] ?? ''
      const next = entries.filter(entry => entry.path !== relPath)
      next.push({ category, path: relPath, summary })
      await this.writeIndexNow(peer, next)
    })
  }

  /** Drop one entry, then rebuild. */
  removeIndexEntry(peer: string, relPath: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const entries = await this.readIndex(peer)
      await this.writeIndexNow(peer, entries.filter(entry => entry.path !== relPath))
    })
  }

  /** Line search across a peer's memory files, including enabled shared mounts (index files excluded). */
  async search(peer: string, query: string, maxMatches = 20, maxLineLength = 300): Promise<SearchMatch[]> {
    if (query.trim() === '') throw new MemoryPathError('search query must not be empty')
    const needle = query.toLowerCase()
    const matches: SearchMatch[] = []
    for (const { abs, prefix } of this.searchRoots(peer)) {
      await ensureDir(abs)
      await this.walkMarkdown(abs, abs, async (fileAbs, rel) => {
        if (matches.length >= maxMatches) return
        let content: string
        try {
          content = await readFileNode(fileAbs, 'utf8')
        } catch {
          return
        }
        for (const line of content.split('\n')) {
          if (matches.length >= maxMatches) return
          const trimmed = line.slice(0, maxLineLength)
          if (trimmed.toLowerCase().includes(needle)) matches.push({ path: prefix + rel, line: trimmed })
        }
      })
    }
    return matches
  }

  /** Search roots for a peer: its own memories plus each enabled non-self shared mount. */
  private searchRoots(peer: string): Array<{ abs: string; prefix: string }> {
    const roots: Array<{ abs: string; prefix: string }> = [{ abs: this.memoriesRoot(peer), prefix: '' }]
    if (this.sharing.enabled) {
      for (const mount of this.sharing.mounts) {
        if (mount.peer === peer) continue
        const sub = mount.subpath === '' || mount.subpath === '.' ? '' : mount.subpath
        roots.push({ abs: join(this.memoriesRoot(mount.peer), sub), prefix: 'shared/' + mount.name + '/' })
      }
    }
    return roots
  }

  private async writeNow(peer: string, relPath: string, content: string): Promise<void> {
    const { abs } = await this.resolve(peer, relPath, { write: true })
    await writeFileAtomic(abs, content, { mode: 0o600, dirMode: 0o700 })
  }

  private async writeIndexNow(peer: string, entries: readonly IndexEntry[]): Promise<void> {
    const memories = this.memoriesRoot(peer)
    const byMtime = new Map<string, number>()
    for (const entry of entries) {
      try {
        byMtime.set(entry.path, (await stat(join(memories, entry.path))).mtimeMs)
      } catch {
        byMtime.set(entry.path, 0)
      }
    }
    const sorted = [...entries].sort((a, b) => (byMtime.get(b.path) ?? 0) - (byMtime.get(a.path) ?? 0))
    await writeFileAtomic(join(memories, '_index.md'), renderIndex(peer, sorted, new Date()), { mode: 0o600, dirMode: 0o700 })
  }

  private async walkMarkdown(base: string, dir: string, visit: (abs: string, rel: string) => Promise<void>): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      if (entry.isDirectory()) {
        await this.walkMarkdown(base, abs, visit)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md' && entry.name !== '_index.md') {
        // rel is always relative to the top-level memories root, so results
        // stay valid paths for read_memory / update_memory / forget_memory.
        await visit(abs, relative(base, abs))
      }
    }
  }
}
