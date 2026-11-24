/**
 * The on-disk Unified Topic Vault (`~/.agent-memory/`): containment, atomic
 * writes through a serial queue, trust-boundary enforcement, topic-grouped L0
 * index management, and path+summary+body search.
 * @module dsh-memory-lite/src/memory-store
 */

import { readFile as readFileNode, readdir, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, relative } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { DEFAULT_PRIVATE_NAMESPACE, PREFERENCES_TOPIC, type IndexEntry, type TrustContext } from './types.js'
import type { HistoryConfig } from './config.js'
import { containWithin, ensureDir, MemoryPathError, realpathSafe } from './path.js'
import { applyPatch, bulletLines, lineKey, type PatchOp } from './patch.js'
import { isPrivatePath, normalizeTopic, topicOfPath, UNRESTRICTED_TRUST } from './privacy.js'
import { isStale, STALE_MARK, stripStale, type SummaryVerdict } from './summary.js'

/** Current UTC date as YYYY-MM-DD. */
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10)
}

/** Serialize mutations so writers never interleave inside the memory vault. */
export class MutationQueue {
  private tail: Promise<unknown> = Promise.resolve()

  /** Run `op` after every previously queued operation; errors isolate per call. */
  enqueue<T>(op: () => Promise<T>): Promise<T> {
    const run = this.tail.then(op, op)
    this.tail = run.then(() => undefined, () => undefined)
    return run
  }
}

/** Cap on retained summary-log lines (bounds the rolling log). */
export const MAX_LOG_LINES = 5000

/** Defaults for the History cap and sidecar archive (see {@link HistoryConfig}). */
export const DEFAULT_HISTORY: HistoryConfig = { maxEntries: 5, entryMaxChars: 240, archiveKeep: 5 }

/** Directory (beside `memories/`) that holds full pre-change snapshots. */
export const ARCHIVE_DIR = '.history'

/** Summary of one topic in the vault (used by L0 map & UI). */
export interface TopicSummary {
  readonly topic: string
  readonly isPrivate: boolean
  readonly count: number
  readonly previewTitles: readonly string[]
}

/** One line-level search hit. */
export interface SearchMatch {
  /** Memory path relative to `<root>/memories/`. */
  readonly path: string
  /** The matching line (or `[summary]` hit), capped in length. */
  readonly line: string
}

/** Options for {@link MemoryStore.search}. */
export interface SearchOptions {
  readonly topic?: string
  readonly trust?: TrustContext
  readonly maxMatches?: number
  readonly maxLineLength?: number
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
 * the plain new body; extract Current when detected. Plain text passes through.
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

/** Render the topic-grouped L0 index document (`memories/_index.md`). */
export function renderIndex(
  entries: readonly IndexEntry[],
  now: Date,
  privateNamespace = DEFAULT_PRIVATE_NAMESPACE,
): string {
  const lines: string[] = ['# Memory Index', '', `> Last updated: ${now.toISOString()} | Total: ${entries.length}`, '']
  const byTopic = new Map<string, IndexEntry[]>()
  for (const entry of entries) {
    const list = byTopic.get(entry.topic)
    if (list === undefined) byTopic.set(entry.topic, [entry])
    else list.push(entry)
  }
  // Stable priority order: preferences first, then public topics (in newest-first
  // appearance order), then private topics (in newest-first appearance order).
  const publicTopics: string[] = []
  const privateTopics: string[] = []
  for (const topic of byTopic.keys()) {
    if (topic === PREFERENCES_TOPIC) continue
    if (isPrivatePath(topic, privateNamespace)) privateTopics.push(topic)
    else publicTopics.push(topic)
  }
  const orderedTopics = [
    ...(byTopic.has(PREFERENCES_TOPIC) ? [PREFERENCES_TOPIC] : []),
    ...publicTopics,
    ...privateTopics,
  ]
  for (const topic of orderedTopics) {
    const list = byTopic.get(topic)
    if (list === undefined || list.length === 0) continue
    const hint = topic === PREFERENCES_TOPIC ? ' (always relevant)' : ''
    lines.push(`## ${topic}${hint}`)
    for (const entry of list) lines.push(`- ${entry.path}: ${entry.summary}`)
    lines.push('')
  }
  return lines.join('\n').replace(/\n+$/, '\n')
}

/** Parse L0 index entries from `_index.md`; malformed lines are ignored (tolerant of human edits). */
export function parseIndex(text: string): IndexEntry[] {
  const entries: IndexEntry[] = []
  const linePattern = /^- (.+\.md): (.*)$/
  for (const line of text.split('\n')) {
    const match = linePattern.exec(line)
    if (match === null) continue
    const path = match[1]!.trim()
    if (path === '' || path.startsWith('/') || path.includes('..')) continue
    const topic = topicOfPath(path)
    if (topic === '') continue
    entries.push({ topic, path, summary: match[2]!.trim() })
  }
  return entries
}

/**
 * A filesystem-safe slug from a title, used as the memory file basename.
 * Keeps Unicode letters and numbers so CJK titles remain readable and distinct.
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
 * Owns the Unified Topic Vault under `root`. All mutations run through
 * {@link MutationQueue}; every read/write passes through
 * {@link MemoryStore.resolve} (containment + trust-boundary enforcement).
 */
export class MemoryStore {
  readonly root: string
  private readonly queue = new MutationQueue()
  private readonly historySource: () => HistoryConfig
  private readonly namespaceSource: () => string

  constructor(
    root: string,
    history: HistoryConfig | (() => HistoryConfig) = DEFAULT_HISTORY,
    privateNamespace: string | (() => string) = DEFAULT_PRIVATE_NAMESPACE,
  ) {
    this.root = root
    this.historySource = typeof history === 'function' ? history : () => history
    this.namespaceSource = typeof privateNamespace === 'function' ? privateNamespace : () => privateNamespace
  }

  get history(): HistoryConfig {
    return this.historySource()
  }

  get privateNamespace(): string {
    return this.namespaceSource()
  }

  /** Path of the global charter file (`AGENTS.md`) directly under root. */
  globalCharterPath(): string {
    return join(this.root, 'AGENTS.md')
  }

  /** Read `AGENTS.md` if present; returns trimmed text or undefined when absent/empty. */
  async readGlobalCharter(): Promise<string | undefined> {
    try {
      const text = await readFileNode(this.globalCharterPath(), 'utf8')
      const trimmed = text.trim()
      return trimmed === '' ? undefined : trimmed
    } catch {
      return undefined
    }
  }

  memoriesRoot(): string {
    return join(this.root, 'memories')
  }

  sessionsDir(): string {
    return join(this.root, 'sessions')
  }

  trashDir(): string {
    return join(this.root, '.trash')
  }

  /**
   * Contain and resolve a relative `.md` path inside `<root>/memories/`,
   * enforcing the trust boundary (`private/` is blocked in restricted mode).
   */
  async resolve(
    relPath: string,
    opts: { write?: boolean; trust?: TrustContext } = {},
  ): Promise<{ abs: string; rel: string; base: string }> {
    const cleaned = relPath.trim()
    if (extname(cleaned).toLowerCase() !== '.md') {
      throw new MemoryPathError(`memory path must end in .md: ${JSON.stringify(relPath)}`)
    }
    const memories = this.memoriesRoot()
    await ensureDir(memories)
    const memoriesReal = await realpathSafe(memories)
    const abs = await containWithin(memories, cleaned)
    const rel = relative(memoriesReal, abs).replaceAll('\\', '/')
    if (opts.trust?.restricted === true && isPrivatePath(rel, this.privateNamespace)) {
      throw new MemoryPathError(`access denied: ${JSON.stringify(rel)} is inside the private namespace (restricted mode)`)
    }
    return { abs, rel, base: memoriesReal }
  }

  async fileExists(relPath: string, trust: TrustContext = UNRESTRICTED_TRUST): Promise<boolean> {
    const { abs } = await this.resolve(relPath, { trust })
    try {
      return (await stat(abs)).isFile()
    } catch {
      return false
    }
  }

  async readFile(relPath: string, trust: TrustContext = UNRESTRICTED_TRUST): Promise<{ content: string; rel: string }> {
    const { abs, rel } = await this.resolve(relPath, { trust })
    let content: string
    try {
      content = await readFileNode(abs, 'utf8')
    } catch (error) {
      throw new MemoryPathError(`cannot read memory ${JSON.stringify(relPath)}: ${error instanceof Error ? error.message : String(error)}`)
    }
    return { content, rel }
  }

  /** Create a new memory file with the canonical skeleton. */
  writeNewMemory(
    relPath: string,
    title: string,
    content: string,
    trust: TrustContext = UNRESTRICTED_TRUST,
  ): Promise<void> {
    const bullets = bulletLines(content).join('\n')
    return this.queue.enqueue(async () => {
      await this.writeNow(relPath, `# ${title}\n\n## Current\n${bullets}\n\n## History\n\n## Related\n`, trust)
    })
  }

  /** Append content as new Current bullets, skipping duplicates (marker-insensitive); resolves whether the body changed. */
  appendCurrent(
    relPath: string,
    content: string,
    trust: TrustContext = UNRESTRICTED_TRUST,
  ): Promise<boolean> {
    return this.queue.enqueue(async () => {
      const existing = await this.readFile(relPath, trust)
      const parsed = parseMemoryFile(existing.content)
      const seen = new Set(parsed.current.split('\n').map(lineKey).filter(key => key !== ''))
      const fresh = bulletLines(content).filter(line => {
        const key = lineKey(line)
        if (key === '' || seen.has(key)) return false
        seen.add(key)
        return true
      })
      if (fresh.length === 0) return false
      parsed.current = parsed.current === '' ? fresh.join('\n') : `${parsed.current}\n${fresh.join('\n')}`
      await this.writeNow(existing.rel, renderMemoryFile(parsed), trust)
      return true
    })
  }

  /** Replace a memory's Current section, archiving the full previous file under `<root>/.history/`. */
  updateCurrent(
    relPath: string,
    content: string,
    trust: TrustContext = UNRESTRICTED_TRUST,
  ): Promise<void> {
    return this.queue.enqueue(async () => {
      const resolved = await this.resolve(relPath, { write: true, trust })
      const existing = await this.readFile(relPath, trust)
      const parsed = parseMemoryFile(existing.content)
      await this.archiveSnapshot(resolved, existing.content)
      if (parsed.current !== '') {
        const firstLine = (parsed.current.split('\n').find(line => line.trim() !== '') ?? '').replace(/^\s*(?:[-*+]\s+)+/, '')
        parsed.history = this.pushHistory(parsed.history, `- ${todayUtc()}: ${firstLine}`)
      } else {
        parsed.history = this.pushHistory(parsed.history)
      }
      parsed.current = bulletLines(content).join('\n')
      await this.writeNow(existing.rel, renderMemoryFile(parsed), trust)
    })
  }

  /** Apply line-targeted patch operations to a memory's Current section. */
  patchCurrent(
    relPath: string,
    ops: readonly PatchOp[],
    trust: TrustContext = UNRESTRICTED_TRUST,
  ): Promise<{ changed: boolean; replaced: number; deleted: number; added: number }> {
    return this.queue.enqueue(async () => {
      const resolved = await this.resolve(relPath, { write: true, trust })
      const existing = await this.readFile(relPath, trust)
      const parsed = parseMemoryFile(existing.content)
      const result = applyPatch(parsed.current === '' ? [] : parsed.current.split('\n'), ops)
      const next = result.lines.join('\n').trim()
      if (next === parsed.current) return { changed: false, replaced: 0, deleted: 0, added: 0 }
      await this.archiveSnapshot(resolved, existing.content)
      parsed.current = next
      parsed.history = this.pushHistory(
        parsed.history,
        `- ${todayUtc()}: patch（替换 ${result.replaced} / 删除 ${result.deleted} / 新增 ${result.added} 行）`,
      )
      await this.writeNow(existing.rel, renderMemoryFile(parsed), trust)
      return { changed: true, replaced: result.replaced, deleted: result.deleted, added: result.added }
    })
  }

  /** Append one entry (when given) to a History body, then enforce the retention cap. */
  private pushHistory(history: string, entry?: string): string {
    const entries = history === '' ? [] : history.split(/\n(?=- )/)
    if (entry !== undefined) entries.push(entry)
    const { maxEntries, entryMaxChars } = this.history
    if (maxEntries <= 0) return ''
    return entries
      .slice(-maxEntries)
      .map(item => {
        const head = (item.split('\n')[0] ?? '').trimEnd()
        return head.length <= entryMaxChars ? head : head.slice(0, entryMaxChars - 1) + '…'
      })
      .join('\n')
  }

  /** Save the complete previous file text as `<root>/.history/<rel>/<utc>.md` and prune old snapshots. */
  private async archiveSnapshot(resolved: { rel: string; base: string }, previous: string): Promise<void> {
    if (this.history.archiveKeep <= 0) return
    try {
      const dir = join(dirname(resolved.base), ARCHIVE_DIR, resolved.rel)
      await ensureDir(dir)
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      await writeFileAtomic(join(dir, `${stamp}.md`), previous, { mode: 0o600, dirMode: 0o700 })
      const names = (await readdir(dir)).filter(name => name.endsWith('.md')).sort()
      for (const name of names.slice(0, Math.max(0, names.length - this.history.archiveKeep))) {
        await unlink(join(dir, name)).catch(() => {})
      }
    } catch {
      // archive is a safety net, not part of the functional path
    }
  }

  /** Validate a session id and resolve its checkpoint/audit file under `<root>/sessions/`. */
  sessionCheckpointPath(sessionId: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(sessionId)) {
      throw new MemoryPathError('invalid session id ' + JSON.stringify(sessionId))
    }
    return join(this.sessionsDir(), sessionId + '.json')
  }

  async readSessionCheckpoint(sessionId: string): Promise<string | undefined> {
    const abs = this.sessionCheckpointPath(sessionId)
    try {
      return await readFileNode(abs, 'utf8')
    } catch {
      return undefined
    }
  }

  writeSessionCheckpoint(sessionId: string, text: string): Promise<void> {
    const abs = this.sessionCheckpointPath(sessionId)
    return this.queue.enqueue(async () => {
      await ensureDir(dirname(abs))
      await writeFileAtomic(abs, text, { mode: 0o600, dirMode: 0o700 })
    })
  }

  /** Vault-wide rolling extraction summary log: `<root>/sessions/extraction.log`. */
  summaryLogPath(): string {
    return join(this.sessionsDir(), 'extraction.log')
  }

  appendExtractionLog(line: string): Promise<void> {
    const abs = this.summaryLogPath()
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

  failedAnswerLogPath(): string {
    return join(this.sessionsDir(), 'failed-answers.log')
  }

  appendFailedAnswer(entry: object): Promise<void> {
    const abs = this.failedAnswerLogPath()
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

  /** Soft-delete: move the file under `<root>/.trash/<date>/`, never overwriting. */
  softDelete(relPath: string, trust: TrustContext = UNRESTRICTED_TRUST): Promise<void> {
    return this.queue.enqueue(async () => {
      const { abs, rel } = await this.resolve(relPath, { write: true, trust })
      const day = new Date().toISOString().slice(0, 10)
      const destDir = join(this.trashDir(), day)
      await ensureDir(destDir)
      const dest = join(destDir, `${basename(rel)}.${Date.now().toString(36)}`)
      await rename(abs, dest)
    })
  }

  /** Parse the full on-disk `_index.md` unfiltered (internal). */
  private async readIndexRaw(): Promise<IndexEntry[]> {
    const memories = this.memoriesRoot()
    await ensureDir(memories)
    try {
      return parseIndex(await readFileNode(join(memories, '_index.md'), 'utf8'))
    } catch {
      return []
    }
  }

  /** Read visible L0 index entries, stripping `private/*` when in restricted mode. */
  async readIndex(trust: TrustContext = UNRESTRICTED_TRUST): Promise<IndexEntry[]> {
    const all = await this.readIndexRaw()
    if (!trust.restricted) return all
    const ns = this.privateNamespace
    return all.filter(entry => !isPrivatePath(entry.path, ns))
  }

  /** List all index entries inside one topic (or under the private namespace). */
  async listTopic(rawTopic: string, trust: TrustContext = UNRESTRICTED_TRUST): Promise<{ topic: string; entries: IndexEntry[] }> {
    const ns = this.privateNamespace
    const cleaned = rawTopic.trim().replace(/^\/+|\/+$/g, '')
    if (cleaned === ns) {
      if (trust.restricted) {
        throw new MemoryPathError(`access denied: topic ${JSON.stringify(cleaned)} is hidden in restricted mode`)
      }
      const entries = (await this.readIndex(trust)).filter(e => isPrivatePath(e.topic, ns))
      return { topic: ns, entries }
    }
    const topic = normalizeTopic(cleaned, ns)
    if (trust.restricted && isPrivatePath(topic, ns)) {
      throw new MemoryPathError(`access denied: topic ${JSON.stringify(topic)} is hidden in restricted mode`)
    }
    const entries = (await this.readIndex(trust)).filter(e => e.topic === topic)
    return { topic, entries }
  }

  /** Group visible index entries into per-topic summaries (for L0 map & UI). */
  async listTopics(trust: TrustContext = UNRESTRICTED_TRUST, previewLimit = 6): Promise<TopicSummary[]> {
    const entries = await this.readIndex(trust)
    const ns = this.privateNamespace
    const groups = new Map<string, IndexEntry[]>()
    for (const entry of entries) {
      const list = groups.get(entry.topic)
      if (list === undefined) groups.set(entry.topic, [entry])
      else list.push(entry)
    }
    return [...groups.entries()].map(([topic, list]) => ({
      topic,
      isPrivate: isPrivatePath(topic, ns),
      count: list.length,
      previewTitles: list.slice(0, previewLimit).map(e => basename(e.path, '.md')),
    }))
  }

  /** Rebuild `_index.md` from entries, sorted by file mtime (newest first). */
  rebuildIndex(entries: readonly IndexEntry[]): Promise<void> {
    return this.queue.enqueue(async () => this.writeIndexNow(entries))
  }

  /** Add or replace one entry, then rebuild `_index.md`. */
  refreshIndexEntry(relPath: string, summary: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const entries = await this.readIndexRaw()
      const topic = topicOfPath(relPath)
      const next = entries.filter(entry => entry.path !== relPath)
      next.push({ topic, path: relPath, summary })
      await this.writeIndexNow(next)
    })
  }

  /** Read one index entry (or undefined); restricted trust never sees `private/*` entries. */
  readIndexEntry(relPath: string, trust: TrustContext = UNRESTRICTED_TRUST): Promise<IndexEntry | undefined> {
    return this.queue.enqueue(async () => {
      if (trust.restricted && isPrivatePath(relPath, this.privateNamespace)) return undefined
      return (await this.readIndexRaw()).find(entry => entry.path === relPath)
    })
  }

  /**
   * Settle the catalog summary after a body change, according to an explicit
   * verdict. `set` replaces the summary (identical text counts as keep);
   * `keep` retains the existing one, clearing any stale marker, or writes
   * `fallback` when the file has no entry yet.
   */
  applySummaryVerdict(
    relPath: string,
    verdict: SummaryVerdict,
    fallback: string,
  ): Promise<{ before?: string; after: string; action: 'kept' | 'changed' }> {
    return this.queue.enqueue(async () => {
      const entries = await this.readIndexRaw()
      const existing = entries.find(entry => entry.path === relPath)
      const before = existing?.summary
      let after: string
      let action: 'kept' | 'changed'
      if (verdict.kind === 'set') {
        const unchanged = existing !== undefined && verdict.text === stripStale(existing.summary)
        after = verdict.text
        action = unchanged ? 'kept' : 'changed'
      } else if (existing !== undefined) {
        after = stripStale(existing.summary)
        action = 'kept'
      } else {
        after = fallback
        action = 'changed'
      }
      const next = entries.filter(entry => entry.path !== relPath)
      next.push({ topic: topicOfPath(relPath), path: relPath, summary: after })
      await this.writeIndexNow(next)
      return { ...(before === undefined ? {} : { before }), after, action }
    })
  }

  /**
   * Flag the catalog summary as possibly outdated (appends {@link STALE_MARK},
   * idempotent). A file without an entry gets `fallback` plus the marker.
   */
  markIndexStale(relPath: string, fallback: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const entries = await this.readIndexRaw()
      const existing = entries.find(entry => entry.path === relPath)
      if (existing !== undefined && isStale(existing.summary)) return
      const next = entries.filter(entry => entry.path !== relPath)
      next.push({ topic: topicOfPath(relPath), path: relPath, summary: `${existing?.summary ?? fallback}${STALE_MARK}` })
      await this.writeIndexNow(next)
    })
  }

  /** Ensure an index entry exists without overwriting an existing summary; re-sorts by mtime. */
  ensureIndexEntry(relPath: string, fallbackSummary: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const entries = await this.readIndexRaw()
      const topic = topicOfPath(relPath)
      const existing = entries.find(entry => entry.path === relPath)
      const next = entries.filter(entry => entry.path !== relPath)
      next.push({ topic, path: relPath, summary: existing?.summary ?? fallbackSummary })
      await this.writeIndexNow(next)
    })
  }

  /** Drop one entry, then rebuild `_index.md`. */
  removeIndexEntry(relPath: string): Promise<void> {
    return this.queue.enqueue(async () => {
      const entries = await this.readIndexRaw()
      await this.writeIndexNow(entries.filter(entry => entry.path !== relPath))
    })
  }

  /**
   * Search visible memories by keyword across filenames, index summaries, and
   * file bodies. Enforces `trust.restricted` (never reads `private/` files in
   * restricted mode) and supports optional `topic` scoping.
   */
  async search(query: string, opts: SearchOptions = {}): Promise<SearchMatch[]> {
    if (query.trim() === '') throw new MemoryPathError('search query must not be empty')
    const trust = opts.trust ?? UNRESTRICTED_TRUST
    const maxMatches = opts.maxMatches ?? 20
    const maxLineLength = opts.maxLineLength ?? 300
    const ns = this.privateNamespace

    let topicFilter: string | undefined
    if (opts.topic !== undefined && opts.topic.trim() !== '') {
      const cleaned = opts.topic.trim().replace(/^\/+|\/+$/g, '')
      if (cleaned === ns) {
        if (trust.restricted) {
          throw new MemoryPathError(`access denied: topic ${JSON.stringify(cleaned)} is hidden in restricted mode`)
        }
        topicFilter = ns
      } else {
        topicFilter = normalizeTopic(cleaned, ns)
        if (trust.restricted && isPrivatePath(topicFilter, ns)) {
          throw new MemoryPathError(`access denied: topic ${JSON.stringify(topicFilter)} is hidden in restricted mode`)
        }
      }
    }

    const matchesTopic = (rel: string): boolean => {
      if (topicFilter === undefined) return true
      if (topicFilter === ns) return isPrivatePath(rel, ns)
      return topicOfPath(rel) === topicFilter
    }

    const needle = query.toLowerCase()
    const matches: SearchMatch[] = []
    const matchedPaths = new Set<string>()

    // 1. Search index paths & summaries first (high-signal title/topic hits).
    const indexEntries = await this.readIndex(trust)
    for (const entry of indexEntries) {
      if (matches.length >= maxMatches) break
      if (!matchesTopic(entry.path)) continue
      const combined = `${entry.path} ${entry.summary}`.toLowerCase()
      if (combined.includes(needle)) {
        matches.push({ path: entry.path, line: `[summary] ${entry.summary}`.slice(0, maxLineLength) })
        matchedPaths.add(entry.path)
      }
    }

    // 2. Search file bodies across visible markdown files.
    const memories = this.memoriesRoot()
    await ensureDir(memories)
    await this.walkMarkdown(memories, memories, trust, async (fileAbs, rel) => {
      if (matches.length >= maxMatches) return
      if (!matchesTopic(rel)) return
      let content: string
      try {
        content = await readFileNode(fileAbs, 'utf8')
      } catch {
        return
      }
      for (const line of content.split('\n')) {
        if (matches.length >= maxMatches) return
        const trimmed = line.slice(0, maxLineLength)
        if (trimmed.toLowerCase().includes(needle)) {
          matches.push({ path: rel, line: trimmed })
        }
      }
    })

    return matches
  }

  private async writeNow(relPath: string, content: string, trust: TrustContext): Promise<void> {
    const { abs } = await this.resolve(relPath, { write: true, trust })
    await writeFileAtomic(abs, content, { mode: 0o600, dirMode: 0o700 })
  }

  private async writeIndexNow(entries: readonly IndexEntry[]): Promise<void> {
    const memories = this.memoriesRoot()
    await ensureDir(memories)
    const byMtime = new Map<string, number>()
    for (const entry of entries) {
      try {
        byMtime.set(entry.path, (await stat(join(memories, entry.path))).mtimeMs)
      } catch {
        byMtime.set(entry.path, 0)
      }
    }
    const sorted = [...entries].sort((a, b) => (byMtime.get(b.path) ?? 0) - (byMtime.get(a.path) ?? 0))
    await writeFileAtomic(
      join(memories, '_index.md'),
      renderIndex(sorted, new Date(), this.privateNamespace),
      { mode: 0o600, dirMode: 0o700 },
    )
  }

  private async walkMarkdown(
    base: string,
    dir: string,
    trust: TrustContext,
    visit: (abs: string, rel: string) => Promise<void>,
  ): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    const ns = this.privateNamespace
    for (const entry of entries) {
      const abs = join(dir, entry.name)
      const rel = relative(base, abs).replaceAll('\\', '/')
      if (entry.isDirectory()) {
        // Hard privacy skip: never even descend into private/ when restricted.
        if (trust.restricted && isPrivatePath(rel, ns)) continue
        await this.walkMarkdown(base, abs, trust, visit)
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md' && entry.name !== '_index.md') {
        if (trust.restricted && isPrivatePath(rel, ns)) continue
        await visit(abs, rel)
      }
    }
  }
}
