/**
 * The `update_memory` tool: replaces a memory's current content, archiving
 * the previous file into `.history/` and keeping a one-line History note.
 * @module dsh-memory-lite/src/tools/update-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { assertNotSubagent, cwdForExec, trustForExec, type MemoryDeps } from '../tool-utils.js'
import { normalizeContent, summaryOf } from '../memory-store.js'
import { topicOfPath } from '../privacy.js'

/** Register update_memory. */
export function applyUpdateMemoryTool(ctx: Context, deps: MemoryDeps): void {
  ctx.tools.register(defineTool({
    name: 'update_memory',
    description: "Replace a memory's current content with new content; the previous file is archived (History keeps a one-line note). Use when a memory is outdated or contradicts new facts.",
    parameters: {
      path: { type: 'string', required: true, description: 'Memory file path from the catalog, e.g. infra/cpa.md or private/health/checkup.md.' },
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
      const trust = trustForExec(exec, deps)
      const cwd = cwdForExec(exec)
      const content = normalizeContent(args.content)
      if (content === '') throw new Error('content must be a non-empty string')
      const { rel } = await deps.store.resolve(args.path, { write: true, trust })
      await deps.store.updateCurrent(rel, content, trust)
      await deps.store.ensureIndexEntry(rel, summaryOf(content))
      const topic = topicOfPath(rel)
      if (topic !== '') void deps.affinity?.record(cwd, topic)
      return { path: rel, content }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Update memory ${args.path}`, kind: 'edit', locations: [{ path: args.path }] }
    },
  }))
}
