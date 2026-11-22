/**
 * The `search_memory` tool: searches filenames, index summaries, and file
 * bodies across visible memories, with optional `topic` scoping.
 * @module dsh-memory-lite/src/tools/search-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { assertNotSubagent, trustForExec, type MemoryDeps } from '../tool-utils.js'

/** Register search_memory. */
export function applySearchMemoryTool(ctx: Context, deps: MemoryDeps): void {
  ctx.tools.register(defineTool({
    name: 'search_memory',
    description: 'Search visible memories by keyword across titles, summaries, and contents. Optionally narrow to one topic.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search keyword or phrase, e.g. CPA or 友邦.' },
      topic: { type: 'string', description: 'Optional topic filter, e.g. infra, g7, or private/insurance.' },
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
      const trust = trustForExec(exec, deps)
      const matches = await deps.store.search(args.query, {
        ...(typeof args.topic === 'string' && args.topic.trim() !== '' ? { topic: args.topic } : {}),
        trust,
      })
      return { matches }
    },
    presentCall(args): GenericCallView {
      const scope = typeof args.topic === 'string' && args.topic.trim() !== '' ? ` in ${args.topic}` : ''
      return { card: 'generic', title: `Search memory ${args.query}${scope}`, kind: 'search' }
    },
  }))
}
