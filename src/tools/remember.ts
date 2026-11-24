/**
 * The `remember` tool: explicit memory capture — creates a new memory file
 * under `<topic>/<slug>.md` or appends to an existing one. Every call must
 * also supply the catalog summary (a new line, or `keep` when appending).
 * @module dsh-memory-lite/src/tools/remember
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { GenericCallView } from '@deepseek-ai/dsh-tools'
import { assertNotSubagent, cwdForExec, renderSummaryLine, trustForExec, type MemoryDeps } from '../tool-utils.js'
import { normalizeContent, slugify, summaryOf } from '../memory-store.js'
import { isPrivatePath, normalizeTopic } from '../privacy.js'
import { parseSummaryField } from '../summary.js'

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
      summary: {
        type: 'string',
        required: true,
        description: 'One-line catalog summary of the memory file (≤80 chars). When appending to an existing file whose catalog summary is still accurate, pass "keep".',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          appended: { type: 'boolean', required: true },
          summary: {
            type: 'object',
            required: true,
            additionalProperties: false,
            properties: {
              before: { type: 'string' },
              after: { type: 'string', required: true },
              action: { type: 'string', required: true, enum: ['kept', 'changed'] },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text: `${value.appended ? `Appended to ${value.path}` : `Remembered ${value.path}`}\n${renderSummaryLine(value.summary)}`,
        },
      ],
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
      // Validate before any write: a missing summary must never leave a changed body behind.
      const verdict = parseSummaryField(args.summary)
      if (verdict === undefined) throw new Error('summary is required: pass a one-line summary or "keep"')
      let summary: { before?: string; after: string; action: 'kept' | 'changed' }
      if (existed) {
        await deps.store.appendCurrent(relPath, content, trust)
        summary = await deps.store.applySummaryVerdict(relPath, verdict, summaryOf(content))
      } else {
        if (verdict.kind === 'keep') throw new Error('new memory file has no existing summary; provide one')
        await deps.store.writeNewMemory(relPath, title, content, trust)
        await deps.store.refreshIndexEntry(relPath, verdict.text)
        summary = { after: verdict.text, action: 'changed' }
      }
      void deps.affinity?.record(cwd, topic)
      return { path: relPath, appended: existed, summary }
    },
    presentCall(args): GenericCallView {
      return { card: 'generic', title: `Remember ${args.topic}/${args.title}`, kind: 'edit' }
    },
  }))
}
