/**
 * The `update_memory` tool: replaces a memory's current content, archiving
 * the previous current into its History section (ADD-only).
 * @module dsh-memory-lite/src/tools/update-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { MemoryDeps } from '../tool-utils.js'
import { assertNotSubagent, peerForExec } from '../tool-utils.js'
import { normalizeContent, summaryOf } from '../memory-store.js'

/** Register update_memory. */
export function applyUpdateMemoryTool(ctx: Context, deps: MemoryDeps): void {
  ctx.tools.register(defineTool({
    name: 'update_memory',
    description: "Replace a memory's current content with new content; the previous current content moves to its History section. Use when a memory is outdated or contradicts new facts.",
    parameters: {
      path: { type: 'string', required: true, description: 'Memory file path relative to the memory root, e.g. preferences/coding.md.' },
      content: { type: 'string', required: true, description: 'The new current content of the memory.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          content: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `Updated ${value.path} (previous content moved to History).\n<content>\n${value.content}\n</content>` },
      ],
    },
    async execute(args, exec) {
      assertNotSubagent(exec)
      const peer = peerForExec(exec, deps.config())
      const content = normalizeContent(args.content)
      if (content === '') throw new Error('content must be a non-empty string')
      await deps.store.updateCurrent(peer, args.path, content)
      await deps.store.refreshIndexEntry(peer, args.path, summaryOf(content))
      return { path: args.path, content }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Update memory ${args.path}`, kind: 'edit', locations: [{ path: args.path }] }
    },
  }))
}
