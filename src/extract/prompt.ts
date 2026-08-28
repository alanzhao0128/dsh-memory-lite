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
    'NOT WORTH REMEMBERING — do not create/merge/update for these; prefer skip:',
    '1. Debugging/implementation process (paths, line numbers, error messages, fix steps, rename chores): record only if the lesson is reusable for future tasks (reusable -> experiences; one-off -> skip).',
    '2. In-progress/ephemeral states ("implementing X", "planning Y", "proposal pending"): record only after the fact is settled or decided.',
    '3. Pure changelog events ("released v0.5.2", "committed abc", "created release"): record only if the event affects future work (version compatibility, API changes).',
    '4. Process chatter (which options were compared, what code was read): record only if it produced a reusable conclusion.',
    '5. Already covered info: when grep hits already cover the fact and nothing new is added, skip.',
    '',
    'PRIORITY: when in doubt, prefer skip over create. Only record facts/decisions that would still be useful to a future agent weeks later. If a window is mostly process, skip is the correct answer.',
    '',
    'EXISTING MEMORY RULES (the user turn lists the memory index of existing files):',
    '- Before create, check the index. If an existing file covers the same topic (same entity/project/event/person), use merge into that file instead of create.',
    '- create only when no existing file covers the topic.',
    '- merge must add only NEW facts not already present in that file (no duplicates).',
    '- If the new fact contradicts an existing file, use update (old content moves to History).',
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

/** One line of the memory index: path plus one-line summary. */
export interface IndexEntryLike {
  readonly path: string
  readonly summary: string
}

/** The user turn: digest + window + memory index + existing hits. */
export function buildExtractionUser(
  digest: string | undefined,
  windowText: string,
  indexEntries: readonly IndexEntryLike[],
  grepHits: readonly GrepHitLike[],
): string {
  const sections: string[] = []
  if (digest !== undefined && digest !== '') {
    sections.push('## 会话滚动摘要（前序窗口）', digest)
  }
  sections.push('## 本轮对话窗口', windowText)
  if (indexEntries.length > 0) {
    sections.push('## 记忆库现有文件（全库索引）', indexEntries.map(entry => `- ${entry.path}: ${entry.summary}`).join('\n'))
  }
  if (grepHits.length > 0) {
    sections.push('## 已存在的相关记忆（grep 命中）', grepHits.map(hit => `- ${hit.path}: ${hit.line}`).join('\n'))
  }
  sections.push('只输出上面的 JSON 决策对象（严格遵守系统指令的 STRICT OUTPUT RULES），不要任何解释、markdown 或代码围栏。')
  return sections.join('\n\n')
}
