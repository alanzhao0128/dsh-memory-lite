/**
 * The `search_memory` tool: line search across a peer's memory files.
 * @module dsh-memory-lite/src/tools/search-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { MemoryDeps } from '../tool-utils.js'
import { assertNotSubagent, peerForExec } from '../tool-utils.js'

/** Register search_memory. */
export function applySearchMemoryTool(ctx: Context, deps: MemoryDeps): void {
  ctx.tools.register(defineTool({
    name: 'search_memory',
    description: 'Search memory files by keyword and return the matching lines with their paths. Use when you are unsure of the exact path in the memory catalog.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keyword or phrase, e.g. pnpm.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                line: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: value.matches.length === 0 ? '(no matches)' : value.matches.map(match => `<path>${match.path}</path>: ${match.line}`).join('\n') },
      ],
    },
    async execute(args, exec) {
      assertNotSubagent(exec)
      const peer = peerForExec(exec, deps.config())
      const matches = await deps.store.search(peer, args.query)
      return { matches }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Search memory ${args.query}`, kind: 'search' }
    },
  }))
}
