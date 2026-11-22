/**
 * The `read_memory` tool: loads the full text of one memory file, OR lists all
 * entries in a topic when given a topic path (e.g. `private/health/`).
 * @module dsh-memory-lite/src/tools/read-memory
 */

import { extname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { assertNotSubagent, cwdForExec, trustForExec, type MemoryDeps } from '../tool-utils.js'
import { topicOfPath } from '../privacy.js'

/** Register read_memory and return its definition (the injector's visibility anchor). */
export function applyReadMemoryTool(ctx: Context, deps: MemoryDeps) {
  const tool = defineTool({
    name: 'read_memory',
    description: 'Read one memory file (e.g. infra/cpa.md) or list all memories inside a topic directory (e.g. private/health/). Use exact paths from the memory catalog or search_memory results.',
    parameters: {
      path: {
        type: 'string',
        required: true,
        description: 'Memory file path (.md) or topic directory (e.g. infra/cpa.md or private/health/).',
      },
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
        { type: 'text', text: `<path>${value.path}</path>\n<content>\n${value.content}\n</content>` },
      ],
    },
    async execute(args, exec) {
      assertNotSubagent(exec)
      const trust = trustForExec(exec, deps)
      const cwd = cwdForExec(exec)
      const raw = args.path.trim()
      if (extname(raw).toLowerCase() === '.md') {
        const { content, rel } = await deps.store.readFile(raw, trust)
        const topic = topicOfPath(rel)
        if (topic !== '') void deps.affinity?.record(cwd, topic)
        return { path: rel, content }
      }
      // Topic listing mode (for collapsed topics in adaptive L0 map).
      const { topic, entries } = await deps.store.listTopic(raw, trust)
      if (entries.length > 0) void deps.affinity?.record(cwd, topic)
      const content = entries.length === 0
        ? `(no memories in topic ${topic})`
        : entries.map(entry => `- ${entry.path}: ${entry.summary}`).join('\n')
      return { path: `${topic}/`, content }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Read memory ${args.path}`, kind: 'read', locations: [{ path: args.path }] }
    },
  })
  ctx.tools.register(tool)
  return tool
}
