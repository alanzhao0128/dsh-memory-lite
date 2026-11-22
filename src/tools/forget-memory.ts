/**
 * The `forget_memory` tool: soft-deletes a memory into `.trash/` and removes
 * its L0 index entry.
 * @module dsh-memory-lite/src/tools/forget-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { assertNotSubagent, trustForExec, type MemoryDeps } from '../tool-utils.js'

/** Register forget_memory. */
export function applyForgetMemoryTool(ctx: Context, deps: MemoryDeps): void {
  ctx.tools.register(defineTool({
    name: 'forget_memory',
    description: 'Delete one memory. The file moves to the memory trash and its index entry is removed; this cannot be undone by the model.',
    parameters: {
      path: { type: 'string', required: true, description: 'Memory file path from the catalog, e.g. infra/cpa.md.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Moved ${value.path} to the memory trash.` }],
    },
    async execute(args, exec) {
      assertNotSubagent(exec)
      const trust = trustForExec(exec, deps)
      const { rel } = await deps.store.resolve(args.path, { write: true, trust })
      await deps.store.softDelete(rel, trust)
      await deps.store.removeIndexEntry(rel)
      return { path: rel }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Forget memory ${args.path}`, kind: 'delete', locations: [{ path: args.path }] }
    },
  }))
}
