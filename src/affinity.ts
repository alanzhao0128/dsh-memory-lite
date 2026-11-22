/**
 * Lightweight automatic `cwd <-> topic` affinity tracker (`topic-affinity.json`).
 *
 * Whenever a session reads, writes, or extracts a memory in a topic, the store
 * bumps a small recency-weighted counter for `(cwd, topic)`. When the vault
 * grows past `index.maxTokens` and enters adaptive Topic Map mode, hot topics
 * for the current `cwd` expand automatically — zero manual workspace rules.
 * @module dsh-memory-lite/src/affinity
 */

import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ensureDir } from './path.js'
import { MutationQueue } from './memory-store.js'

const AFFINITY_FILE = 'topic-affinity.json'
const MAX_CWDS = 200
const MAX_TOPICS_PER_CWD = 12

interface TopicWeight {
  count: number
  lastAt: number
}

type AffinityMap = Record<string, Record<string, TopicWeight>>

/** Persistent, best-effort cwd-to-topic affinity tracker. */
export class TopicAffinityStore {
  private readonly filePath: string
  private readonly queue = new MutationQueue()

  constructor(root: string) {
    this.filePath = join(root, AFFINITY_FILE)
  }

  private async load(): Promise<AffinityMap> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as AffinityMap)
        : {}
    } catch {
      return {}
    }
  }

  /** Record one interaction between `cwd` and `topic` (best-effort, never throws). */
  record(cwd: string | undefined, topic: string): Promise<void> {
    if (cwd === undefined || cwd === '' || topic === '') return Promise.resolve()
    const key = resolve(cwd)
    return this.queue.enqueue(async () => {
      const map = await this.load()
      const bucket = map[key] ?? {}
      const prev = bucket[topic]
      bucket[topic] = { count: (prev?.count ?? 0) + 1, lastAt: Date.now() }
      // Prune least-used topics per cwd.
      const topicEntries = Object.entries(bucket).sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)
      map[key] = Object.fromEntries(topicEntries.slice(0, MAX_TOPICS_PER_CWD))
      // Prune oldest cwds overall.
      const cwdEntries = Object.entries(map).sort((a, b) => {
        const aMax = Math.max(0, ...Object.values(a[1]).map(v => v.lastAt))
        const bMax = Math.max(0, ...Object.values(b[1]).map(v => v.lastAt))
        return bMax - aMax
      })
      const pruned = Object.fromEntries(cwdEntries.slice(0, MAX_CWDS))
      await ensureDir(dirname(this.filePath))
      await writeFileAtomic(this.filePath, JSON.stringify(pruned, null, 2) + '\n', { mode: 0o600, dirMode: 0o700 })
    }).catch(() => {})
  }

  /**
   * Return hot topics for `cwd`, ordered by affinity (count desc, recency desc).
   * Falls back cleanly to `[]` when no affinity exists yet.
   */
  async hotTopicsFor(cwd: string | undefined): Promise<string[]> {
    if (cwd === undefined || cwd === '') return []
    const map = await this.load()
    const bucket = map[resolve(cwd)]
    if (bucket === undefined) return []
    return Object.entries(bucket)
      .sort((a, b) => b[1].count - a[1].count || b[1].lastAt - a[1].lastAt)
      .map(([topic]) => topic)
  }
}
