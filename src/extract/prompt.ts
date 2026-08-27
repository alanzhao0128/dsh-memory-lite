/**
 * Extraction prompt assembly. The model receives the rolling digest, the new
 * window, and any grep-matched existing memories, and must answer with one
 * JSON decision (create/merge/update/skip). Kept schema-minimal per the
 * design's cost discipline — this is one background request per run.
 * @module dsh-memory-lite/src/extract/prompt
 */

export interface GrepHitLike {
  readonly path: string
  readonly line: string
}

/** The system instruction given to the extraction model. */
export function extractionSystem(): string {
  return [
    'You are a background memory extractor for an agent. You read a conversation window and decide what is worth remembering long-term.',
    'Decisions:',
    '- create: a new durable fact/preference/entity. Requires category (preferences|entities|events|experiences), a short title, and content.',
    '- merge: add a compatible fact to an existing memory file.',
    '- update: an existing memory is outdated or contradicted; new content replaces it (old content moves to History automatically).',
    '- skip: nothing worth remembering or already covered.',
    '',
    'Reply with exactly ONE JSON object matching this schema (choose one of the four):',
    '{"decision":"create","category":"preferences|entities|events|experiences","title":"...","content":"..."}',
    '{"decision":"merge","path":"...","content":"..."}',
    '{"decision":"update","path":"...","content":"..."}',
    '{"decision":"skip","reason":"..."}',
    '',
    'STRICT OUTPUT RULES:',
    '- Your entire reply must be exactly one JSON object and nothing else.',
    '- No prose, no explanation, no markdown, no code fences, no trailing period.',
    '- The JSON must be valid, balanced, and use half-width braces and quotes.',
    '- Path values must be relative .md paths inside the memory root (e.g. preferences/tools.md).',
    '- category is required only for create.',
  ].join('\n')
}

/** The user turn: digest + window + existing hits. */
export function buildExtractionUser(
  digest: string | undefined,
  windowText: string,
  grepHits: readonly GrepHitLike[],
): string {
  const sections: string[] = []
  if (digest !== undefined && digest !== '') {
    sections.push('## 会话滚动摘要（前序窗口）', digest)
  }
  sections.push('## 本轮对话窗口', windowText)
  if (grepHits.length > 0) {
    sections.push('## 已存在的相关记忆（grep 命中）', grepHits.map(hit => `- ${hit.path}: ${hit.line}`).join('\n'))
  }
  sections.push('只输出上面的 JSON 决策对象（严格遵守系统指令的 STRICT OUTPUT RULES），不要任何解释、markdown 或代码围栏。')
  return sections.join('\n\n')
}
