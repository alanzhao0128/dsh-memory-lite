/**
 * The `remember` tool: explicit memory capture — creates a new memory file
 * or appends to an existing one with the same slug.
 * @module dsh-memory-lite/src/tools/remember
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import type { MemoryDeps } from '../tool-utils.js'
import { assertNotSubagent, peerForExec } from '../tool-utils.js'
import { normalizeContent, slugify, summaryOf } from '../memory-store.js'
import { MEMORY_CATEGORIES } from '../types.js'
import type { MemoryCategory } from '../types.js'

/** Register remember. */
export function applyRememberTool(ctx: Context, deps: MemoryDeps): void {
  ctx.tools.register(defineTool({
    name: 'remember',
    description: 'Remember something the user explicitly asked you to remember. Call this ONLY when the user asks to remember something; never decide on your own.',
    parameters: {
      category: {
        type: 'string',
        required: true,
        enum: [...MEMORY_CATEGORIES],
        description: 'Which memory category the entry belongs to: preferences (always relevant), entities (mentioned knowledge), events (time-related), experiences (task lessons).',
      },
      title: { type: 'string', required: true, description: 'Short title; becomes the memory file name.' },
      content: { type: 'string', required: true, description: 'The fact or preference to remember.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          appended: { type: 'boolean', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.appended ? `Appended to ${value.path}` : `Remembered ${value.path}` }],
    },
    async execute(args, exec) {
      assertNotSubagent(exec)
      const peer = peerForExec(exec, deps.config)
      const category = args.category as MemoryCategory
      if (!MEMORY_CATEGORIES.includes(category)) {
        throw new Error(`category must be one of ${MEMORY_CATEGORIES.join(', ')}`)
      }
      const title = args.title.trim()
      if (title === '') throw new Error('title must be a non-empty string')
      const content = normalizeContent(args.content)
      if (content === '') throw new Error('content must be a non-empty string')
      const relPath = `${category}/${slugify(title)}.md`
      const existed = await deps.store.fileExists(peer, relPath)
      if (existed) {
        await deps.store.appendCurrent(peer, relPath, content)
      } else {
        await deps.store.writeNewMemory(peer, relPath, title, content)
      }
      await deps.store.refreshIndexEntry(peer, relPath, summaryOf(content))
      return { path: relPath, appended: existed }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Remember ${args.category}/${args.title}`, kind: 'edit' }
    },
  }))
}
