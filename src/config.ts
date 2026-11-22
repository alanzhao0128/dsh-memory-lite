/**
 * Configuration contracts for dsh-memory-lite v1.0 (Unified Topic Vault).
 * The schemastery `Config` validates the shape written in cordis.yml (every
 * field optional); `resolveConfig` performs explicit defaulting — the only
 * place defaults are applied.
 * @module dsh-memory-lite/src/config
 */

import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import { DEFAULT_PRIVATE_NAMESPACE } from './types.js'

/** Default memory root; `~` expands against the user's home. */
export const DEFAULT_MEMORY_ROOT = '~/.agent-memory'
/** Default cap on L0 catalog size, in approximate tokens. */
export const DEFAULT_INDEX_MAX_TOKENS = 3500
/** Default fraction of post-preferences budget given to expanded hot topics when collapsing. */
export const DEFAULT_HOT_BUDGET_RATIO = 0.7
/** Default session-header indicator slot order (ascending; -1 sits left of the built-in "Session log" capsule). */
export const DEFAULT_HEADER_ORDER = -1

/** One optional safety-net path rule forcing writes/extractions under `pattern` into a private topic. */
export interface PrivatePathRule {
  /** Path glob pattern (~ expanded), e.g. `~/Documents/健康分析/**`. */
  pattern: string
  /** Target private topic, e.g. `private/health`. */
  topic: string
}

/** Trust-boundary configuration guarding the `private/` namespace. */
export interface PrivacyConfig {
  /** Top-level namespace for sensitive memories (plain segment). Defaults to `'private'`. */
  namespace: string
  /** One-click privacy shield (e.g. screen sharing / demos): hides `private/` everywhere. Defaults to false. */
  hidePrivate: boolean
  /** LLM provider IDs that must never receive or access `private/` memories (e.g. corporate gateways). */
  restrictedProviders: string[]
  /** Path patterns (~ expanded) where `private/` memories are hidden (e.g. corporate work directories). */
  restrictedPaths: string[]
  /** Optional safety-net rules: writes/extractions from matching directories are forced into `private/<subtopic>`. */
  privatePaths: PrivatePathRule[]
}

/** L0 catalog sizing and adaptive collapse tuning. */
export interface IndexConfig {
  /** Approximate token cap for the L0 catalog. Under cap = full expansion; over cap = adaptive Topic Map. Defaults to 3500. */
  maxTokens: number
  /** Index sort order; `mtime` newest-first is the only supported value. Defaults to `mtime`. */
  sortBy: 'mtime'
  /** Share of remaining token budget allocated to expanded hot topics in adaptive map mode (0.2–0.9). Defaults to 0.7. */
  hotBudgetRatio: number
}

/** Tool-side switches. */
export interface ToolsConfig {
  /** Reserved; the tool schemas are minimal by construction. Defaults to true. */
  schemaMinimal: boolean
}

/** Browser-side indicator options. */
export interface UiConfig {
  /** Render order of the memory status indicator in the session-header utilities slot. Defaults to -1. */
  headerOrder: number
}

/** Retention for a memory file's History section and its full-snapshot archive. */
export interface HistoryConfig {
  /** Newest History entries kept per file (one line each); 0 drops History entirely. Defaults to 5. */
  maxEntries: number
  /** Max characters per History line; longer lines are cut with an ellipsis. Defaults to 240. */
  entryMaxChars: number
  /** Full pre-change snapshots kept per file under `<root>/.history/`; 0 disables archiving. Defaults to 5. */
  archiveKeep: number
}

/** Extraction model selection: an explicit route wins; empty = the global default model (agent-default-model). */
export interface ExtractionLlmConfig {
  /** Combined "provider/model" route, e.g. 'claude-official/claude-haiku-5-5'. Empty = global default. */
  route?: string
  /** Adapter-owned reasoning effort id (e.g. 'low'); empty = follow the global default selection. */
  reasoningEffort?: string
  /** Legacy provider key; superseded by route. */
  provider?: string
  /** Legacy model id; superseded by route. */
  model?: string
}

/** Background implicit extraction (channel B). */
export interface ExtractionConfig {
  /** incremental | explicit_only | off. Defaults to incremental. */
  mode: 'incremental' | 'explicit_only' | 'off'
  /** New in-scope conversation messages >= this count triggers an extraction. Defaults to 50. */
  windowTurns: number
  /** Idle minutes before the remaining window is extracted. Defaults to 30. */
  idleTimeoutMin: number
  /** Max messages fed to the extraction LLM per run. Defaults to 20. */
  maxMessages: number
  /** Which event kinds count toward windowTurns and feed the extraction window. Defaults to ['user','assistant']. */
  messageScope: ('user' | 'assistant' | 'tool_result')[]
  /** Per tool/result content truncation before feeding the LLM. Defaults to 2048. */
  toolResultMaxBytes: number
  /** Carry the rolling session digest. Defaults to true. */
  includeDigest: boolean
  /** Search existing memories for dedup/contradiction. Defaults to true. */
  dedup: boolean
  /** Extraction model selection; empty route = the global default model (agent-default-model). */
  llm: ExtractionLlmConfig
  /** agent/turn-stopping backstop trigger. Defaults to true. */
  turnStoppingTrigger: boolean
  /** session/flush last-resort trigger. Defaults to true. */
  flushTrigger: boolean
  /** Minimum unextracted messages for a turn-boundary run. Defaults to 5. */
  minTurnExtract: number
  /** Debounce window for turn-boundary extraction, ms. Defaults to 30000. */
  turnDebounceMs: number
  /** Write audit entries to `<root>/sessions/{id}.json`. Defaults to true. */
  auditLog: boolean
  /** Global cap on concurrent extraction LLM requests. Defaults to 1. */
  maxConcurrentRequests: number
  /** On a failed JSON parse, one cheap repair call re-asks the model for valid JSON. Defaults to true. */
  parseRetry: boolean
  /** Before merge/update lands on an existing file, run a line-targeted reconcile pass. Defaults to true. */
  reconcile: boolean
  /** Byte budget for the numbered Current shown to the reconcile call; larger files fall back to append. Defaults to 24576. */
  reconcileMaxBytes: number
}

/** Raw plugin configuration as written in cordis.yml; every field optional. */
export interface MemoryConfig {
  root?: string
  privacy?: Partial<PrivacyConfig>
  index?: Partial<IndexConfig>
  tools?: Partial<ToolsConfig>
  extraction?: Partial<ExtractionConfig>
  history?: Partial<HistoryConfig>
  ui?: Partial<UiConfig>
}

/** Fully defaulted configuration after {@link resolveConfig}. */
export interface ResolvedConfig {
  /** Absolute, `~`-expanded memory root. */
  root: string
  privacy: PrivacyConfig
  index: IndexConfig
  tools: ToolsConfig
  extraction: ExtractionConfig
  history: HistoryConfig
  ui: UiConfig
}

/**
 * Mark a schema node editable without remounting in dsh >= 0.1.7 settings
 * (SettingsForms / config-editor volatile form). Forward-compatible with older
 * schemastery runtimes via extra('volatile', true).
 */
function asVolatile<T extends z<any>>(schema: T): T {
  return typeof (schema as any).volatile === 'function'
    ? (schema as any).volatile()
    : (schema as any).extra('volatile', true)
}

/** Validate the plugin configuration shape. Unknown keys are tolerated for forward compatibility. */
export const Config: z<MemoryConfig> = z.object({
  root: asVolatile(z.string()),
  privacy: z.object({
    namespace: asVolatile(z.string()),
    hidePrivate: asVolatile(z.boolean()),
    restrictedProviders: asVolatile(z.array(z.string())),
    restrictedPaths: asVolatile(z.array(z.string())),
    privatePaths: asVolatile(z.array(z.object({
      pattern: z.string(),
      topic: z.string(),
    }))),
  }),
  index: z.object({
    maxTokens: asVolatile(z.number()),
    sortBy: z.union([z.const('mtime')]),
    hotBudgetRatio: asVolatile(z.number()),
  }),
  tools: z.object({
    schemaMinimal: z.boolean(),
  }),
  extraction: z.object({
    mode: asVolatile(z.union([z.const('incremental'), z.const('explicit_only'), z.const('off')])),
    windowTurns: asVolatile(z.number()),
    idleTimeoutMin: asVolatile(z.number()),
    maxMessages: asVolatile(z.number()),
    messageScope: asVolatile(z.array(z.union([z.const('user'), z.const('assistant'), z.const('tool_result')]))),
    toolResultMaxBytes: asVolatile(z.number()),
    includeDigest: asVolatile(z.boolean()),
    dedup: asVolatile(z.boolean()),
    llm: z.object({
      route: asVolatile(z.string()),
      reasoningEffort: asVolatile(z.string()),
      provider: z.string(),
      model: z.string(),
    }),
    turnStoppingTrigger: asVolatile(z.boolean()),
    flushTrigger: asVolatile(z.boolean()),
    minTurnExtract: asVolatile(z.number()),
    turnDebounceMs: asVolatile(z.number()),
    auditLog: asVolatile(z.boolean()),
    maxConcurrentRequests: asVolatile(z.number()),
    parseRetry: asVolatile(z.boolean()),
    reconcile: asVolatile(z.boolean()),
    reconcileMaxBytes: asVolatile(z.number()),
  }),
  history: z.object({
    maxEntries: asVolatile(z.number()),
    entryMaxChars: asVolatile(z.number()),
    archiveKeep: asVolatile(z.number()),
  }),
  ui: z.object({
    headerOrder: asVolatile(z.number()),
  }),
})

/** Validate and normalize extraction.messageScope. */
function normalizeMessageScope(scope: readonly ('user' | 'assistant' | 'tool_result')[] | undefined): ('user' | 'assistant' | 'tool_result')[] {
  if (scope === undefined || scope.length === 0) return ['user', 'assistant']
  const valid = new Set(['user', 'assistant', 'tool_result'])
  for (const entry of scope) {
    if (!valid.has(entry)) {
      throw new Error('dsh-memory-lite: extraction.messageScope entries must be user | assistant | tool_result, got ' + JSON.stringify(entry))
    }
  }
  return [...new Set(scope)]
}

/**
 * Recursively unwrap Schemastery / Cosmokit `.volatile()` reference objects
 * ({ get(): T }) into plain values.
 */
export function unwrapConfig<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj
  if (typeof obj === 'object' && typeof (obj as any).get === 'function') {
    return unwrapConfig((obj as any).get())
  }
  if (Array.isArray(obj)) {
    return obj.map(item => unwrapConfig(item)) as unknown as T
  }
  if (typeof obj === 'object' && Object.prototype.toString.call(obj) === '[object Object]') {
    const res: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj)) {
      res[key] = unwrapConfig(value)
    }
    return res as T
  }
  return obj
}

/** Validate a plain path segment (no slashes, no dots). */
function assertPlainSegment(value: string, fieldName: string): string {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..') {
    throw new Error(`dsh-memory-lite: ${fieldName} must be a plain directory name, got ${JSON.stringify(value)}`)
  }
  return trimmed
}

/** Normalize and default a raw configuration; throws on invalid values. */
export function resolveConfig(rawConfig: MemoryConfig = {}): ResolvedConfig {
  const config = unwrapConfig(rawConfig) ?? {}
  const root = resolve(expandHomePath(config.root ?? DEFAULT_MEMORY_ROOT))

  const namespace = assertPlainSegment(config.privacy?.namespace ?? DEFAULT_PRIVATE_NAMESPACE, 'privacy.namespace')
  const restrictedProviders = [...new Set(
    (config.privacy?.restrictedProviders ?? [])
      .map(p => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean),
  )]
  const restrictedPaths = [...new Set(
    (config.privacy?.restrictedPaths ?? [])
      .map(p => (typeof p === 'string' ? p.trim() : ''))
      .filter(Boolean),
  )]
  const privatePaths: PrivatePathRule[] = (config.privacy?.privatePaths ?? []).map(rule => {
    const pattern = typeof rule.pattern === 'string' ? rule.pattern.trim() : ''
    const topic = typeof rule.topic === 'string' ? rule.topic.trim().replace(/^\/+|\/+$/g, '') : ''
    if (pattern === '') {
      throw new Error('dsh-memory-lite: privacy.privatePaths entry requires a non-empty pattern')
    }
    const parts = topic.split('/')
    if (parts.length !== 2 || parts[0] !== namespace || parts[1] === '' || parts[1] === '.' || parts[1] === '..') {
      throw new Error(`dsh-memory-lite: privacy.privatePaths topic must be "${namespace}/<subtopic>", got ${JSON.stringify(rule.topic)}`)
    }
    return { pattern, topic }
  })
  const privacy: PrivacyConfig = {
    namespace,
    hidePrivate: config.privacy?.hidePrivate ?? false,
    restrictedProviders,
    restrictedPaths,
    privatePaths,
  }

  const index: IndexConfig = {
    maxTokens: config.index?.maxTokens ?? DEFAULT_INDEX_MAX_TOKENS,
    sortBy: 'mtime',
    hotBudgetRatio: config.index?.hotBudgetRatio ?? DEFAULT_HOT_BUDGET_RATIO,
  }
  if (!Number.isInteger(index.maxTokens) || index.maxTokens < 50) {
    throw new Error(`dsh-memory-lite: index.maxTokens must be an integer >= 50, got ${index.maxTokens}`)
  }
  if (typeof index.hotBudgetRatio !== 'number' || !Number.isFinite(index.hotBudgetRatio) || index.hotBudgetRatio < 0.2 || index.hotBudgetRatio > 0.9) {
    throw new Error(`dsh-memory-lite: index.hotBudgetRatio must be between 0.2 and 0.9, got ${index.hotBudgetRatio}`)
  }

  const extraction: ExtractionConfig = {
    mode: config.extraction?.mode ?? 'incremental',
    windowTurns: config.extraction?.windowTurns ?? 50,
    idleTimeoutMin: config.extraction?.idleTimeoutMin ?? 30,
    maxMessages: config.extraction?.maxMessages ?? 20,
    messageScope: normalizeMessageScope(config.extraction?.messageScope),
    toolResultMaxBytes: config.extraction?.toolResultMaxBytes ?? 2048,
    includeDigest: config.extraction?.includeDigest ?? true,
    dedup: config.extraction?.dedup ?? true,
    llm: {
      route: config.extraction?.llm?.route ?? '',
      reasoningEffort: config.extraction?.llm?.reasoningEffort ?? '',
      provider: config.extraction?.llm?.provider,
      model: config.extraction?.llm?.model,
    },
    turnStoppingTrigger: config.extraction?.turnStoppingTrigger ?? true,
    flushTrigger: config.extraction?.flushTrigger ?? true,
    minTurnExtract: config.extraction?.minTurnExtract ?? 5,
    turnDebounceMs: config.extraction?.turnDebounceMs ?? 30000,
    auditLog: config.extraction?.auditLog ?? true,
    maxConcurrentRequests: config.extraction?.maxConcurrentRequests ?? 1,
    parseRetry: config.extraction?.parseRetry ?? true,
    reconcile: config.extraction?.reconcile ?? true,
    reconcileMaxBytes: config.extraction?.reconcileMaxBytes ?? 24576,
  }
  for (const [key, value] of [
    ['windowTurns', extraction.windowTurns],
    ['maxMessages', extraction.maxMessages],
    ['toolResultMaxBytes', extraction.toolResultMaxBytes],
    ['minTurnExtract', extraction.minTurnExtract],
    ['turnDebounceMs', extraction.turnDebounceMs],
    ['maxConcurrentRequests', extraction.maxConcurrentRequests],
    ['idleTimeoutMin', extraction.idleTimeoutMin],
    ['reconcileMaxBytes', extraction.reconcileMaxBytes],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`dsh-memory-lite: extraction.${key} must be a non-negative integer, got ${value}`)
    }
  }
  const llmRoute = extraction.llm.route ?? ''
  if (llmRoute !== '') {
    const slash = llmRoute.indexOf('/')
    if (slash <= 0 || slash === llmRoute.length - 1 || llmRoute.includes('\\')) {
      throw new Error(`dsh-memory-lite: extraction.llm.route must be "provider/model", got ${JSON.stringify(llmRoute)}`)
    }
  }

  const history: HistoryConfig = {
    maxEntries: config.history?.maxEntries ?? 5,
    entryMaxChars: config.history?.entryMaxChars ?? 240,
    archiveKeep: config.history?.archiveKeep ?? 5,
  }
  for (const [key, value] of [
    ['maxEntries', history.maxEntries],
    ['entryMaxChars', history.entryMaxChars],
    ['archiveKeep', history.archiveKeep],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`dsh-memory-lite: history.${key} must be a non-negative integer, got ${value}`)
    }
  }
  if (history.entryMaxChars < 20) {
    throw new Error(`dsh-memory-lite: history.entryMaxChars must be >= 20, got ${history.entryMaxChars}`)
  }

  const ui: UiConfig = {
    headerOrder: config.ui?.headerOrder ?? DEFAULT_HEADER_ORDER,
  }
  if (!Number.isInteger(ui.headerOrder)) {
    throw new Error(`dsh-memory-lite: ui.headerOrder must be an integer, got ${ui.headerOrder}`)
  }

  return {
    root,
    privacy,
    index,
    tools: { schemaMinimal: config.tools?.schemaMinimal ?? true },
    extraction,
    history,
    ui,
  }
}
