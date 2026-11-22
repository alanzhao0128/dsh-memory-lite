/**
 * Shared helpers for memory tools, catalog injection, and trust evaluation.
 * @module dsh-memory-lite/src/tool-utils
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.js'
import type { MemoryStore } from './memory-store.js'
import type { TopicAffinityStore } from './affinity.js'
import { evaluateTrust } from './privacy.js'
import type { TrustContext } from './types.js'

/** Minimal session view needed for trust and affinity resolution. */
export interface SessionContextLike {
  readonly id?: string
  readonly header?: { readonly cwd?: string; readonly origin?: string }
  requestHeader?(): { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined
}

/** Dependencies closed over by the tools, injector, and extractor. */
export interface MemoryDeps {
  readonly config: () => ResolvedConfig
  readonly store: MemoryStore
  readonly affinity?: TopicAffinityStore
  /** Live global default model selection (agent-default-model). */
  readonly defaultModel?: () => { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

/** Reject calls from subagent sessions (locked decision). */
export function assertNotSubagent(exec: ToolExecution): void {
  if (exec.agent?.session.header.origin === 'subagent') {
    throw new Error('memory tools are not available to subagent sessions')
  }
}

/** Resolve the effective LLM provider for a session (session header first, else live default model). */
export function providerForSession(
  session: SessionContextLike | undefined,
  deps: Pick<MemoryDeps, 'defaultModel'>,
): string | undefined {
  const fromSession = session?.requestHeader?.()?.config?.provider
  if (typeof fromSession === 'string' && fromSession.trim() !== '') return fromSession.trim()
  const fromDefault = deps.defaultModel?.()?.provider
  if (typeof fromDefault === 'string' && fromDefault.trim() !== '') return fromDefault.trim()
  return undefined
}

/** Evaluate the trust boundary for a session (optionally including extra provider IDs such as extraction LLM). */
export function trustForSession(
  session: SessionContextLike | undefined,
  deps: Pick<MemoryDeps, 'config' | 'defaultModel'>,
  extraProviders: readonly (string | undefined)[] = [],
): TrustContext {
  const config = deps.config()
  return evaluateTrust({
    cwd: session?.header?.cwd,
    provider: providerForSession(session, deps),
    extraProviders,
    privacy: config.privacy,
  })
}

/** Evaluate the trust boundary for a tool execution. */
export function trustForExec(exec: ToolExecution, deps: Pick<MemoryDeps, 'config' | 'defaultModel'>): TrustContext {
  return trustForSession(exec.agent?.session as SessionContextLike | undefined, deps)
}

/** Current session cwd for a tool execution, if any. */
export function cwdForExec(exec: ToolExecution): string | undefined {
  return exec.agent?.session.header.cwd
}
