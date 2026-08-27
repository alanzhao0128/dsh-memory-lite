/**
 * The `read_memory` tool: loads the full text of one memory file.
 * @module dsh-memory-lite/src/tools/read-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { MemoryDeps } from '../tool-utils.js'
import { assertNotSubagent, peerForExec } from '../tool-utils.js'

/** Register read_memory and return its definition (the injector's visibility anchor). */
export function applyReadMemoryTool(ctx: Context, deps: MemoryDeps) {
  const tool = defineTool({
    name: 'read_memory',
    description: 'Read the full text of one memory file. Use the exact path from the memory catalog or search_memory results.',
    parameters: {
      path: { type: 'string', required: true, description: 'Memory file path relative to the memory root, e.g. preferences/coding.md.' },
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
      const peer = peerForExec(exec, deps.config())
      const { content, rel } = await deps.store.readFile(peer, args.path)
      return { path: rel, content }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Read memory ${args.path}`, kind: 'read', locations: [{ path: args.path }] }
    },
  })
  ctx.tools.register(tool)
  return tool
}
