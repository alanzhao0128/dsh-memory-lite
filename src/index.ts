/**
 * dsh-memory-lite v1.0: Unified Topic Vault for DeepSeek Harness.
 *
 * - Single topic-organized Markdown vault (`~/.agent-memory/memories/<topic>/`).
 * - Adaptive two-tier L0 catalog (full expansion under budget; preferences +
 *   auto-learned hot topics + 1-line Topic Map when larger).
 * - Hard trust-boundary gate (`privacy`): hides and blocks `private/` when
 *   `hidePrivate` is on, or when the session/extractor uses a restricted
 *   provider or restricted working directory.
 * - Five model-facing tools + background incremental extraction with reconcile.
 * @module dsh-memory-lite
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import type { SettingsProvider, SettingsSectionHooks } from '@deepseek-ai/dsh-settings'
import { Config, resolveConfig, unwrapConfig } from './config.js'
import type { MemoryConfig, ResolvedConfig } from './config.js'
import { MemoryStore } from './memory-store.js'
import { TopicAffinityStore } from './affinity.js'
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

/** Services this plugin requires to activate; `connection` is injected optionally below. */
export const inject = ['tools', 'agents', 'llm', 'timer']

export { Config }

/** Install settings namespace across dsh <= 0.1.5 (SettingsProvider) and dsh >= 0.1.7 (SettingsForms). */
function installSettingsCompat<T>(ctx: Context, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>): void {
  void ctx.inject(['settings'], (sctx) => {
    const settings = sctx.settings as (SettingsProvider & { configure?: (opts: { auto?: boolean }, owner?: unknown) => () => void }) | undefined
    if (settings === undefined) return
    if (typeof (settings as any).installSection === 'function') {
      settings.installSection(sctx, ns as never, schema as never, entry, hooks)
      return
    }
    hooks.setSource(() => {
      const entryConfig = (ctx as any).fiber?.entry?.options?.config as T | undefined
      const fiberConfig = (ctx as any).fiber?.config as T | undefined
      return entryConfig ?? fiberConfig ?? entry
    })
    if (typeof settings.configure === 'function') {
      sctx.effect(
        () => settings.configure!({ auto: false }, (ctx as any).fiber),
        'dsh-memory-lite: disable auto-generated settings form',
      )
    }
    ;(sctx as any).on('app-boot/config-reload', () => {
      hooks.onChange()
    })
    hooks.onChange()
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

/** Shared `/api/<endpoint>` RPC route matching the official rpcFetchHandler envelope. */
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
  let live: ResolvedConfig = resolveConfig(config)
  // MemoryStore & TopicAffinityStore pin `root` at construction (first use,
  // after settings seed loads); `history` and `privacy` resolve live.
  let store: MemoryStore | undefined
  let affinity: TopicAffinityStore | undefined
  const storeOf = (): MemoryStore => (store ??= new MemoryStore(
    live.root,
    () => live.history,
    () => live.privacy.namespace,
  ))
  const affinityOf = (): TopicAffinityStore => (affinity ??= new TopicAffinityStore(live.root))

  const defaultModel = (): { provider: string; model: string; reasoningEffort?: string } => {
    const svc = ctx.get('agentDefaultModel') as { currentSelection?: () => { provider: string; model: string; reasoningEffort?: string } } | undefined
    if (svc?.currentSelection === undefined) return { provider: '', model: '' }
    try {
      return svc.currentSelection()
    } catch {
      return { provider: '', model: '' }
    }
  }

  const deps: MemoryDeps = {
    config: () => live,
    get store() { return storeOf() },
    get affinity() { return affinityOf() },
    defaultModel,
  }

  const readTool = applyReadMemoryTool(ctx, deps)
  applySearchMemoryTool(ctx, deps)
  applyRememberTool(ctx, deps)
  applyUpdateMemoryTool(ctx, deps)
  applyForgetMemoryTool(ctx, deps)
  applyMemoryCatalogInjection(ctx, deps, readTool)
  const tracker = createStatusTracker()
  applyExtraction(ctx, deps, tracker)

  let source: () => MemoryConfig = () => config
  installSettingsCompat(ctx, 'dsh-memory-lite', Config, unwrapConfig(config), {
    setSource: (get) => { source = get },
    onChange: () => {
      const next = resolveConfig(source())
      live = store === undefined
        ? next
        : { ...next, root: live.root }
    },
  })

  void ctx.inject(['connection'], (cctx) => {
    cctx.effect(
      () => cctx.connection.fetch.register(rpcRoute('memory-status/snapshot', async (_endpoint, _payload, _signal) => ({
        ok: true,
        value: {
          ...tracker.snapshot(live.extraction.mode),
          hidePrivate: live.privacy.hidePrivate,
        },
      }))),
      'dsh-memory-lite: /api/memory-status/snapshot',
    )

    cctx.effect(
      () => cctx.connection.fetch.register(rpcRoute('memory-vault/snapshot', async (_endpoint, _payload, _signal) => {
        const topics = await storeOf().listTopics()
        const totalMemories = topics.reduce((sum, t) => sum + t.count, 0)
        return {
          ok: true,
          value: {
            totalMemories,
            topics,
            privacy: {
              namespace: live.privacy.namespace,
              hidePrivate: live.privacy.hidePrivate,
              restrictedProviders: live.privacy.restrictedProviders,
              restrictedPaths: live.privacy.restrictedPaths,
              privatePaths: live.privacy.privatePaths,
            },
          },
        }
      })),
      'dsh-memory-lite: /api/memory-vault/snapshot',
    )

    cctx.effect(
      () => cctx.connection.fetch.register(rpcRoute('memory-models/snapshot', async (_endpoint, _payload, _signal) => {
        const groups: unknown[] = []
        try {
          const llm = ctx.llm as {
            listProviders?: () => readonly { readonly id: string; readonly name: string }[]
            listModels?: (provider: string) => Promise<readonly { readonly id: string; readonly name: string; readonly description?: string }[]>
          } | undefined
          if (llm?.listProviders !== undefined) {
            const providers = llm.listProviders()
            for (const provider of providers) {
              const models = llm.listModels !== undefined ? await llm.listModels(provider.id) : []
              groups.push({ id: provider.id, name: provider.name, models })
            }
          }
        } catch (error) {
          cctx.logger.warn('dsh-memory-lite: /memory-models failed: ' + String(error))
        }
        return { ok: true, value: { groups } }
      })),
      'dsh-memory-lite: /api/memory-models/snapshot',
    )

    cctx.effect(
      () => cctx.connection.fetch.register(rpcRoute('memory-model-efforts/snapshot', async (_endpoint, payload, _signal) => {
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
          cctx.logger.warn('dsh-memory-lite: /memory-model-efforts failed: ' + String(error))
        }
        return { ok: true, value: { efforts, defaultEffort } }
      })),
      'dsh-memory-lite: /api/memory-model-efforts/snapshot',
    )
  })
  ctx.logger.info(`dsh-memory-lite: unified vault enabled (root ${live.root}, extraction ${live.extraction.mode})`)
}
