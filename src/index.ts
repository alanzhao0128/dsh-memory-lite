/**
 * dsh-memory-lite: lightweight Markdown-file memory for DeepSeek Harness.
 *
 * - Five model-facing tools: read_memory, search_memory, remember,
 *   update_memory, forget_memory (explicit capture only — the implicit
 *   extraction channel is Phase 2).
 * - L0 catalog injection (`agent/pre-step` waterfall): the peer's memory
 *   index is published as a durable user message and re-published when the
 *   index changes or compaction moves it off the visible surface.
 * - Peer isolation: each session's cwd derives its own memory root.
 * - All file access goes through a containment boundary; subagent sessions
 *   get no catalog and no tool access.
 *
 * Model Experience: the 5 tool schemas are injected every step; the L0
 * catalog is one durable surface message resident for the session (re-sent
 * after compaction or index changes). See README.md and IMPLEMENTATION.md.
 * @module dsh-memory-lite
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
// dsh-settings >= 0.1.2 exposes SettingsProvider.installSection (the old
// module-level installSettingsSection moved onto the provider). The host
// settings service is that provider, so we call the method directly.
import type { SettingsProvider, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import { Config, resolveConfig } from './config.js'
import type { MemoryConfig, ResolvedConfig } from './config.js'
import { MemoryStore } from './memory-store.js'
import { peerForHeader } from './peer.js'
import type { MemoryDeps } from './tool-utils.js'
import { applyReadMemoryTool } from './tools/read-memory.js'
import { applySearchMemoryTool } from './tools/search-memory.js'
import { applyRememberTool } from './tools/remember.js'
import { applyUpdateMemoryTool } from './tools/update-memory.js'
import { applyForgetMemoryTool } from './tools/forget-memory.js'
import { applyMemoryCatalogInjection } from './inject.js'
import { applyExtraction } from './extract/index.js'
import { createStatusTracker } from './status.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-memory-lite'

/** Services this plugin needs: the tool registry, the agent registry, the LLM stream,
 * and the timer service (ctx.timeout for the extraction idle backstop). */
export const inject = ['tools', 'agents', 'llm', 'timer', 'connection']

export { Config }

/**
 * Install the memory-lite settings namespace on the host SettingsProvider
 * (dsh-settings >= 0.1.2). `installSection` registers the namespace with the
 * composition entry as the base layer, points the source thunk at the
 * resolved scope, and falls back to the entry when the service detaches.
 *
 * Rides ctx.inject so an absent settings service (host without one) is a
 * silent no-op rather than a hard inject failure.
 */
function installSettingsCompat<T>(ctx: Context, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>): void {
  void ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings as SettingsProvider | undefined
    if (settings === undefined) return
    settings.installSection(sctx, ns as never, schema as never, entry, hooks)
  })
}

interface ClientRequestEnvelope {
  readonly type: 'client-request'
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

function isClientRequest(value: unknown): value is ClientRequestEnvelope {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.type === 'client-request' && typeof record.rpcId === 'string' && typeof record.method === 'string'
}

function rpcErrorResponse(rpcId: string, code: string, message: string, status: number): Response {
  return Response.json({
    type: 'server-response',
    rpcId,
    result: { ok: false, error: { code, message, details: {} } },
  }, { status })
}

function rpcSuccessResponse(rpcId: string, result: unknown): Response {
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * dsh 0.1.5 channel migration: connection.rpc.handle 对第三方插件不可用
 * （官方 #5926：connection 顶层 inject 不再声明 webServer，注册时抛
 * "cannot get property webServer without inject"，master 未修）。插件 RPC
 * 改为 /api 共享通道的精确 Fetch 路由（connection.fetch.register），信封
 * 协议与旧 rpc.handle 一致（复刻官方 rpcFetchHandler）。
 *
 * 与官方 rpcFetchHandler 的差异（有意）：handler 抛错时返回 200 + 结构化
 * error envelope（官方为 500 纯文本），让浏览器端 rpc.call 能拿到
 * { ok:false, error } 而不是 transport failure。
 */
function rpcRoute(
  endpoint: string,
  handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>,
): ConnectionFetchRoute {
  return {
    path: '/api/' + endpoint,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request: Request): Promise<Response> => {
      if (request.method !== 'POST') return new Response('not found', { status: 404 })
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let message: unknown
      try {
        message = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      if (!isClientRequest(message)) {
        return rpcErrorResponse('invalid-request', 'gateway/bad-request', 'invalid client-request message', 400)
      }
      if (message.method !== endpoint) {
        return rpcErrorResponse(message.rpcId, 'gateway/bad-request', 'method ' + JSON.stringify(message.method) + ' does not match endpoint ' + JSON.stringify(endpoint), 400)
      }
      try {
        const result = await handler(endpoint, message.payload, request.signal)
        return rpcSuccessResponse(message.rpcId, result)
      } catch (error) {
        return rpcErrorResponse(message.rpcId, 'gateway/internal', 'handler failure: ' + String(error), 200)
      }
    },
  }
}

/** Register the memory capability for the lifetime of `ctx`. */
export function apply(ctx: Context, config: MemoryConfig = {}): void {
  // The live config is a mutable reference; settings changes swap it in place
  // (see installSettingsSection below), so every consumer reading through the
  // deps getter sees the newest value without re-registering.
  let live: ResolvedConfig = resolveConfig(config)
  const store = new MemoryStore(live.root, live.sharing)
  const defaultModel = (): { provider: string; model: string; reasoningEffort?: string } => {
    const svc = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string; reasoningEffort?: string } } | undefined
    if (svc?.currentSelection === undefined) return { provider: '', model: '' }
    try {
      return svc.currentSelection()
    } catch {
      return { provider: '', model: '' }
    }
  }
  const deps: MemoryDeps = { config: () => live, store, defaultModel }
  const readTool = applyReadMemoryTool(ctx, deps)
  applySearchMemoryTool(ctx, deps)
  applyRememberTool(ctx, deps)
  applyUpdateMemoryTool(ctx, deps)
  applyForgetMemoryTool(ctx, deps)
  applyMemoryCatalogInjection(ctx, deps, readTool)
  const tracker = createStatusTracker()
  applyExtraction(ctx, deps, tracker)

  // Peer UI annotations: whenever a session with a working directory is seen,
  // ensure its peer carries a human-readable displayName (e.g. 健康分析 behind
  // workspace-aad65ea5). Idempotent and async — rememberPeerCwd reads first
  // and writes exactly once per peer.
  ctx.on('session/event', (session) => {
    const header = session.header as { cwd?: string; origin?: string } | undefined
    if (header?.cwd === undefined || header?.origin === 'subagent') return
    const peer = peerForHeader(header as Parameters<typeof peerForHeader>[0], live)
    void store.rememberPeerCwd(peer, header.cwd)
  })

  // Settings-backed overrides (方案 A, IMPLEMENTATION.md §16): the cordis row
  // config is the composition base; user edits land in ~/.dsh/settings.yaml
  // under the dsh-memory-lite namespace. root/sharing stay pinned to the store
  // snapshot (restart-applies — MemoryStore holds them at construction); every
  // other field resolves live on each change.
  let source: () => MemoryConfig = () => config
  installSettingsCompat(ctx, 'dsh-memory-lite', Config, config, {
    setSource: (get) => { source = get },
    onChange: () => {
      const next = resolveConfig(source())
      live = { ...next, root: live.root, sharing: live.sharing }
    },
  })

  // Browser indicator channel: the header dot polls this snapshot.
  ctx.effect(
    () => ctx.connection.fetch.register(rpcRoute('memory-status/snapshot', async (_endpoint, _payload, _signal) => ({
      ok: true,
      value: tracker.snapshot(live.extraction.mode),
    }))),
    'dsh-memory-lite: /api/memory-status/snapshot',
  )

  // Settings UI: list existing peers so sharing.mounts can be edited as
  // checkboxes instead of raw YAML (IMPLEMENTATION.md §16.9 known limit).
  ctx.effect(
    () => ctx.connection.fetch.register(rpcRoute('memory-peers/snapshot', async (_endpoint, _payload, _signal) => ({
      ok: true,
      value: {
        peers: await store.listPeers(),
        mounts: live.sharing.mounts.map(m => ({ name: m.name, peer: m.peer, subpath: m.subpath, readonly: m.readonly })),
      },
    }))),
    'dsh-memory-lite: /api/memory-peers/snapshot',
  )

  // Settings UI: model catalog for the extraction-model dropdown (§17). rc.1
  // removed the browser connection.api.llm.models aggregate; rebuild the same
  // {groups:[{id,name,models:[{id,name,reasoning?}]}]} shape host-side from
  // ctx.llm (listProviders + listModels + resolveModelInfo) so the client
  // settings page keeps working across host versions over our own RPC.
  ctx.effect(
    () => ctx.connection.fetch.register(rpcRoute('memory-models/snapshot', async (_endpoint, _payload, _signal) => {
      const groups: unknown[] = []
      try {
        const llm = ctx.llm as {
          listProviders?: () => readonly { readonly id: string; readonly name: string }[]
          listModels?: (provider: string) => Promise<readonly { readonly id: string; readonly name: string; readonly description?: string }[]>
          resolveModelInfo?: (provider: string, model: string) => Promise<{ readonly reasoning?: { readonly efforts?: readonly { readonly id: string; readonly name: string; readonly description?: string }[]; readonly defaultEffort?: string } }>
        } | undefined
        if (llm?.listProviders !== undefined) {
          const providers = llm.listProviders()
          for (const provider of providers) {
            const models = llm.listModels !== undefined ? await llm.listModels(provider.id) : []
            groups.push({ id: provider.id, name: provider.name, models })
          }
        }
      } catch (error) {
        ctx.logger.warn('dsh-memory-lite: /memory-models failed: ' + String(error))
      }
      return { ok: true, value: { groups } }
    })),
    'dsh-memory-lite: /api/memory-models/snapshot',
  )

  // Per-route reasoning efforts for the effort dropdown: resolved lazily so
  // the catalog RPC stays cheap (resolveModelInfo per model would be N calls).
  ctx.effect(
    () => ctx.connection.fetch.register(rpcRoute('memory-model-efforts/snapshot', async (_endpoint, payload, _signal) => {
      const route = String((payload as { route?: unknown } | null)?.route ?? '')
      const slash = route.indexOf('/')
      if (slash <= 0) return { ok: true, value: { efforts: [], defaultEffort: undefined } }
      const provider = route.slice(0, slash)
      const model = route.slice(slash + 1)
      let efforts: readonly { readonly id: string; readonly name: string; readonly description?: string }[] = []
      let defaultEffort: string | undefined
      try {
        const llm = ctx.llm as { resolveModelInfo?: (p: string, m: string) => Promise<{ readonly reasoning?: { readonly efforts?: readonly { readonly id: string; readonly name: string; readonly description?: string }[]; readonly defaultEffort?: string } }> } | undefined
        const info = llm?.resolveModelInfo !== undefined ? await llm.resolveModelInfo(provider, model) : undefined
        efforts = info?.reasoning?.efforts ?? []
        defaultEffort = info?.reasoning?.defaultEffort
      } catch (error) {
        ctx.logger.warn('dsh-memory-lite: /memory-model-efforts failed: ' + String(error))
      }
      return { ok: true, value: { efforts, defaultEffort } }
    })),
    'dsh-memory-lite: /api/memory-model-efforts/snapshot',
  )
  ctx.logger.info(`dsh-memory-lite: memory enabled (root ${live.root}, default peer ${live.defaultPeer}, extraction ${live.extraction.mode})`)
}
