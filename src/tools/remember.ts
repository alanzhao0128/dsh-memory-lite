/**
 * The `remember` tool: explicit memory capture — creates a new memory file
 * under `<topic>/<slug>.md` or appends to an existing one.
 * @module dsh-memory-lite/src/tools/remember
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { assertNotSubagent, cwdForExec, trustForExec, type MemoryDeps } from '../tool-utils.js'
import { normalizeContent, slugify, summaryOf } from '../memory-store.js'
import { isPrivatePath, normalizeTopic } from '../privacy.js'

/** Register remember. */
export function applyRememberTool(ctx: Context, deps: MemoryDeps): void {
  ctx.tools.register(defineTool({
    name: 'remember',
    description: 'Remember something the user explicitly asked you to remember. Call this ONLY when the user asks to remember something; never decide on your own.',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: 'Owning topic directory (e.g. preferences, infra, dsh, g7, video, dev, or private/<subtopic> for sensitive personal info). Prefer existing topics from the catalog.',
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
      const config = deps.config()
      const trust = trustForExec(exec, deps)
      const cwd = cwdForExec(exec)
      const ns = config.privacy.namespace

      let topic = normalizeTopic(args.topic, ns)
      if (trust.restricted && isPrivatePath(topic, ns)) {
        throw new Error(`cannot write to private topic ${JSON.stringify(topic)} in restricted mode`)
      }
      if (!trust.restricted && trust.forcedPrivateTopic !== undefined && !isPrivatePath(topic, ns)) {
        topic = trust.forcedPrivateTopic
      }

      const title = args.title.trim()
      if (title === '') throw new Error('title must be a non-empty string')
      const content = normalizeContent(args.content)
      if (content === '') throw new Error('content must be a non-empty string')

      const relPath = `${topic}/${slugify(title)}.md`
      const existed = await deps.store.fileExists(relPath, trust)
      if (existed) {
        await deps.store.appendCurrent(relPath, content, trust)
        await deps.store.ensureIndexEntry(relPath, summaryOf(content))
      } else {
        await deps.store.writeNewMemory(relPath, title, content, trust)
        await deps.store.refreshIndexEntry(relPath, summaryOf(content))
      }
      void deps.affinity?.record(cwd, topic)
      return { path: relPath, appended: existed }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Remember ${args.topic}/${args.title}`, kind: 'edit' }
    },
  }))
}
