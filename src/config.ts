/**
 * Configuration contracts for dsh-memory-lite. The schemastery `Config`
 * validates the shape a user writes in cordis.yml (every field optional);
 * `resolveConfig` performs explicit defaulting — the only place defaults
 * are applied.
 * @module dsh-memory-lite/src/config
 */

import { resolve } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'

/** Default memory root; `~` expands against the user's home. */
export const DEFAULT_MEMORY_ROOT = '~/.agent-memory'
/** Default peer used for sessions without a usable cwd. */
export const DEFAULT_PEER = 'dsh-web'
/** Default cap on catalog size, in approximate tokens. */
export const DEFAULT_INDEX_MAX_TOKENS = 1200
/** Default session-header indicator slot order (ascending; -1 sits left of the built-in "Session log" capsule). */
export const DEFAULT_HEADER_ORDER = -1

/** Per-session peer derivation from `SessionHeader.cwd`. */
export interface WorkspacePeersConfig {
  /** Derive the peer from each session's cwd. Defaults to true. */
  enabled: boolean
  /** Reserved for Phase 2 extraction; peer derivation ignores it. Defaults to true. */
  excludeSubagents: boolean
  /** Peer name used when a session has no cwd; the literal `default_peer` selects the default. Defaults to `default_peer`. */
  cwdFallback: string
}

/** L0 catalog sizing. */
export interface IndexConfig {
  /** Approximate token cap for the catalog; entries past the cap are truncated. Defaults to 1200. */
  maxTokens: number
  /** Index sort order; `mtime` newest-first is the only supported value. Defaults to `mtime`. */
  sortBy: 'mtime'
}

/** Tool-side switches. */
export interface ToolsConfig {
  /** Reserved; the tool schemas are minimal by construction. Defaults to true. */
  schemaMinimal: boolean
}

/** Browser-side indicator options. */
export interface UiConfig {
  /** Render order of the memory status indicator in the session-header utilities slot (ascending; smaller = further left, -1 sits left of the built-in "Session log" capsule). Defaults to -1. */
  headerOrder: number
}

/** One explicit cross-peer share: expose a target peer's memories at shared/<name>/... */
export interface SharingMountConfig {
  /** Path prefix exposed to this peer's sessions: shared/<name>/<file>.md. Must be a plain segment. */
  name: string
  /** Target peer whose memories root is shared. */
  peer: string
  /** Subpath inside the target peer's memories root; '' = the whole root. */
  subpath: string
  /** Read-only mirror; write operations are rejected. Defaults to true. */
  readonly: boolean
}

/** Cross-peer sharing (Phase 3): explicit, not default. */
export interface SharingConfig {
  /** Master switch; when off, shared/ paths are rejected. Defaults to false. */
  enabled: boolean
  /** Ordered mount declarations, visible to every peer except the target itself. */
  mounts: SharingMountConfig[]
}

/** Extraction model selection: an explicit route wins; empty = the global default model (agent-default-model). */
export interface ExtractionLlmConfig {
  /** Combined "provider/model" route, e.g. 'deepseek-official/deepseek-v4-flash'. Empty = global default. */
  route?: string
  /** Adapter-owned reasoning effort id (e.g. 'low'); empty = follow the global default selection. */
  reasoningEffort?: string
  /** Legacy provider key (kept for compatibility with pre-§17 configs); superseded by route. */
  provider?: string
  /** Legacy model id (kept for compatibility with pre-§17 configs); superseded by route. */
  model?: string
}

/** Background implicit extraction (Phase 2, channel B). */
export interface ExtractionConfig {
  /** incremental | explicit_only | off. Defaults to incremental. */
  mode: 'incremental' | 'explicit_only' | 'off'
  /** New surface messages >= this count triggers an extraction. Defaults to 20. */
  windowTurns: number
  /** Idle minutes before the remaining window is extracted. Defaults to 30. */
  idleTimeoutMin: number
  /** Max messages fed to the extraction LLM per run. Defaults to 20. */
  maxMessages: number
  /** Which event kinds count and feed the window (fixed to the three surface types). */
  messageScope: ('user' | 'assistant' | 'tool_result')[]
  /** Per tool/result content truncation before feeding the LLM. Defaults to 2048. */
  toolResultMaxBytes: number
  /** Carry the rolling session digest. Defaults to true. */
  includeDigest: boolean
  /** Grep existing memories for dedup/contradiction. Defaults to true. */
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
  /** Write audit entries to peers/{peer}/sessions/{id}.json. Defaults to true. */
  auditLog: boolean
  /** Global cap on concurrent extraction LLM requests. Defaults to 1. */
  maxConcurrentRequests: number
  /** On a failed JSON parse, one cheap repair call re-asks the model for valid JSON. Defaults to true. */
  parseRetry: boolean
}

/** Raw plugin configuration as written in cordis.yml; every field optional. */
export interface MemoryConfig {
  root?: string
  defaultPeer?: string
  workspacePeers?: Partial<WorkspacePeersConfig>
  index?: Partial<IndexConfig>
  tools?: Partial<ToolsConfig>
  extraction?: Partial<ExtractionConfig>
  sharing?: Partial<SharingConfig>
  ui?: Partial<UiConfig>
}

/** Fully defaulted configuration after {@link resolveConfig}. */
export interface ResolvedConfig {
  /** Absolute, `~`-expanded memory root. */
  root: string
  defaultPeer: string
  workspacePeers: WorkspacePeersConfig
  index: IndexConfig
  tools: ToolsConfig
  extraction: ExtractionConfig
  sharing: SharingConfig
  ui: UiConfig
}

/** Validate the plugin configuration shape. Unknown keys are tolerated for forward compatibility. */
export const Config: z<MemoryConfig> = z.object({
  root: z.string(),
  defaultPeer: z.string(),
  workspacePeers: z.object({
    enabled: z.boolean(),
    excludeSubagents: z.boolean(),
    cwdFallback: z.string(),
  }),
  index: z.object({
    maxTokens: z.number(),
    sortBy: z.union([z.const('mtime')]),
  }),
  tools: z.object({
    schemaMinimal: z.boolean(),
  }),
  extraction: z.object({
    mode: z.union([z.const('incremental'), z.const('explicit_only'), z.const('off')]),
    windowTurns: z.number(),
    idleTimeoutMin: z.number(),
    maxMessages: z.number(),
    messageScope: z.array(z.union([z.const('user'), z.const('assistant'), z.const('tool_result')])),
    toolResultMaxBytes: z.number(),
    includeDigest: z.boolean(),
    dedup: z.boolean(),
    llm: z.object({
      route: z.string(),
      reasoningEffort: z.string(),
      provider: z.string(),
      model: z.string(),
    }),
    turnStoppingTrigger: z.boolean(),
    flushTrigger: z.boolean(),
    minTurnExtract: z.number(),
    turnDebounceMs: z.number(),
    auditLog: z.boolean(),
    maxConcurrentRequests: z.number(),
    parseRetry: z.boolean(),
  }),
  sharing: z.object({
    enabled: z.boolean(),
    mounts: z.array(z.object({
      name: z.string(),
      peer: z.string(),
      subpath: z.string(),
      readonly: z.boolean(),
    })),
  }),
  ui: z.object({
    headerOrder: z.number(),
  }),
})

/** Normalize and default a raw configuration; throws on invalid values. */
export function resolveConfig(config: MemoryConfig = {}): ResolvedConfig {
  const root = resolve(expandHomePath(config.root ?? DEFAULT_MEMORY_ROOT))
  const defaultPeer = config.defaultPeer ?? DEFAULT_PEER
  if (defaultPeer === '' || defaultPeer.includes('/') || defaultPeer.includes('\\') || defaultPeer === '.' || defaultPeer === '..') {
    throw new Error(`dsh-memory-lite: defaultPeer must be a plain directory name, got ${JSON.stringify(defaultPeer)}`)
  }
  const workspacePeers = {
    enabled: config.workspacePeers?.enabled ?? true,
    excludeSubagents: config.workspacePeers?.excludeSubagents ?? true,
    cwdFallback: config.workspacePeers?.cwdFallback ?? 'default_peer',
  }
  const index = {
    maxTokens: config.index?.maxTokens ?? DEFAULT_INDEX_MAX_TOKENS,
    sortBy: 'mtime' as const,
  }
  if (!Number.isInteger(index.maxTokens) || index.maxTokens < 50) {
    throw new Error(`dsh-memory-lite: index.maxTokens must be an integer >= 50, got ${index.maxTokens}`)
  }
  const extraction = {
    mode: config.extraction?.mode ?? 'incremental',
    windowTurns: config.extraction?.windowTurns ?? 20,
    idleTimeoutMin: config.extraction?.idleTimeoutMin ?? 30,
    maxMessages: config.extraction?.maxMessages ?? 20,
    messageScope: config.extraction?.messageScope ?? (['user', 'assistant', 'tool_result'] as const),
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
  }
  for (const [key, value] of [
    ['windowTurns', extraction.windowTurns],
    ['maxMessages', extraction.maxMessages],
    ['toolResultMaxBytes', extraction.toolResultMaxBytes],
    ['minTurnExtract', extraction.minTurnExtract],
    ['turnDebounceMs', extraction.turnDebounceMs],
    ['maxConcurrentRequests', extraction.maxConcurrentRequests],
    ['idleTimeoutMin', extraction.idleTimeoutMin],
  ] as const) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`dsh-memory-lite: extraction.${key} must be a non-negative integer, got ${value}`)
    }
  }
  const llmRoute = extraction.llm.route
  if (llmRoute !== '') {
    // "provider/model-id": the model id itself may contain a slash (pi-ai
    // routes like commandcode/deepseek/deepseek-v4-flash), so only the first
    // segment is the provider and the rest is the model id.
    const slash = llmRoute.indexOf('/')
    if (slash <= 0 || slash === llmRoute.length - 1 || llmRoute.includes('\\')) {
      throw new Error(`dsh-memory-lite: extraction.llm.route must be "provider/model", got ${JSON.stringify(llmRoute)}`)
    }
  }
  const sharing = {
    enabled: config.sharing?.enabled ?? false,
    mounts: (config.sharing?.mounts ?? []).map(mount => ({
      name: mount.name,
      peer: mount.peer,
      subpath: mount.subpath ?? '',
      readonly: mount.readonly ?? true,
    })),
  }
  for (const mount of sharing.mounts) {
    if (mount.name === '' || /[\\/]/.test(mount.name) || mount.name === '.' || mount.name === '..') {
      throw new Error('dsh-memory-lite: sharing mount name must be a plain segment, got ' + JSON.stringify(mount.name))
    }
    if (mount.peer === '' || mount.peer.includes('/') || mount.peer.includes('\\') || mount.peer === '.' || mount.peer === '..') {
      throw new Error('dsh-memory-lite: sharing mount peer must be a plain directory name, got ' + JSON.stringify(mount.peer))
    }
    if (mount.subpath.startsWith('/') || mount.subpath.split('/').includes('..')) {
      throw new Error('dsh-memory-lite: sharing mount subpath must not escape the memories root, got ' + JSON.stringify(mount.subpath))
    }
  }
  const ui = {
    headerOrder: config.ui?.headerOrder ?? DEFAULT_HEADER_ORDER,
  }
  if (!Number.isInteger(ui.headerOrder)) {
    throw new Error(`dsh-memory-lite: ui.headerOrder must be an integer, got ${ui.headerOrder}`)
  }
  return {
    root,
    defaultPeer,
    workspacePeers,
    index,
    tools: { schemaMinimal: config.tools?.schemaMinimal ?? true },
    extraction,
    sharing,
    ui,
  }
}
