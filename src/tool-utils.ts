/**
 * Shared helpers for the memory tools.
 * @module dsh-memory-lite/src/tool-utils
 */

import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.js'
import type { MemoryStore } from './memory-store.js'
import { peerForHeader } from './peer.js'

/** What the tools and the injector need: the store plus a config source.
 *  The config is a getter so settings changes apply live without restarting
 *  the plugin (root/sharing stay fixed at the store snapshot; see §16). */
export interface MemoryDeps {
  readonly config: () => ResolvedConfig
  readonly store: MemoryStore
  /** Live global default model selection (agent-default-model), read when
   *  extraction.llm.route is unset. Absent = fall back to session header. */
  readonly defaultModel?: () => { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }
}

/** Reject calls from subagent sessions (locked decision; see IMPLEMENTATION.md §7). */
export function assertNotSubagent(exec: ToolExecution): void {
  if (exec.agent?.session.header.origin === 'subagent') {
    throw new Error('memory tools are not available to subagent sessions')
  }
}

/** The peer a tool call reads from and writes to. */
export function peerForExec(exec: ToolExecution, config: ResolvedConfig): string {
  return peerForHeader(exec.agent?.session.header, config)
}
