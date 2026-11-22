/**
 * Extraction prompt assembly for the Unified Topic Vault (v1.0).
 * @module dsh-memory-lite/src/extract/prompt
 */

import { DEFAULT_PRIVATE_NAMESPACE } from '../types.js'

export interface GrepHitLike {
  readonly path: string
  readonly line: string
}

export interface IndexEntryLike {
  readonly path: string
  readonly summary: string
}

export interface ExtractionSystemOptions {
  readonly restricted?: boolean
  readonly privateNamespace?: string
}

/** The system instruction given to the extraction model. */
export function extractionSystem(opts: ExtractionSystemOptions = {}): string {
  const restricted = opts.restricted === true
  const ns = opts.privateNamespace ?? DEFAULT_PRIVATE_NAMESPACE

  const privacySection = restricted
    ? [
        'TRUST BOUNDARY (RESTRICTED MODE ACTIVE):',
        `- The "${ns}/" namespace is hidden and non-writable in this context.`,
        `- NEVER output a topic or path under "${ns}/". If a fact is sensitive personal/medical/financial/family info, choose skip.`,
      ]
    : [
        'TOPIC & PRIVACY ROUTING:',
        '- Choose the owning topic by SUBJECT, not by folder name.',
        '- Reuse an existing topic from the vault whenever possible; put one-off technical lessons in "dev" (or the closest existing topic). NEVER invent a new topic for a single isolated fact.',
        `- Use "preferences" ONLY for universal cross-topic user preferences.`,
        `- Use "${ns}/<subtopic>" (e.g. "${ns}/health", "${ns}/insurance", "${ns}/family", "${ns}/quant") for sensitive personal facts: medical/health records, insurance policies, family members, personal finances, or live trading strategies/balances.`,
        `- Legal topic shapes: single segment ("infra", "dsh", "g7", "video", "dev", "preferences") OR "${ns}/<subtopic>". Never deeper than 2 levels.`,
      ]

  return [
    'You are a strict, minimalist background memory extractor for an agent. Your goal is to keep memory high-signal, dense, and clean. You aggressively filter out noise, transient tasks, and trivial details.',
    'Decisions:',
    '- create: ONLY for a brand-new, durable, core system asset, permanent infrastructure truth, or explicit user rule. Requires topic, a short title, summary, and content.',
    '- merge: add an essential, high-value fact to an existing memory file.',
    '- update: an existing memory is outdated or contradicted; new content replaces it (old content moves to History automatically).',
    '- skip: DEFAULT CHOICE. Use whenever information is transient, conversational, single-task, one-off debugging, standard tool usage, or already covered.',
    '',
    '### HARD CRITERIA — TRIPLE GATE FOR EXTRACTION (WHEN IN DOUBT, ALWAYS SKIP):',
    'Gate 1: Ephemeral & Non-Essential Exclusion (Strict Skip)',
    '- NEVER record single-session debugging steps, command outputs, temporary errors, test runs, or code read logs.',
    '- NEVER record newly registered skills, tools, or ephemeral project files unless the user explicitly establishes a permanent workflow rule around them.',
    '- NEVER record third-party tool documentation, general programming syntax, or generic knowledge that the model already knows.',
    '- NEVER record temporary tasks, intermediate proposals, or discussions before final settlement.',
    '',
    'Gate 2: The 30-Day Durability Test',
    '- Ask: "Will a future agent 30 days from now genuinely fail or make a catastrophic mistake without this specific bullet point?" If NO -> SKIP.',
    '- Only record facts that represent lasting user preferences, permanent server/network/proxy infrastructure facts, API quota models, domain knowledge, or core boundaries.',
    '',
    'Gate 3: Aggressive Merge over Create',
    '- NEVER create a fragmented, single-bullet file. If a fact relates to an existing topic file (e.g. CPA proxy, Flow2API, server norms, G7 gateway), it MUST be merged into that file.',
    '',
    'NOT WORTH REMEMBERING — do not create/merge/update for these; prefer skip:',
    '1. Debugging/implementation process (paths, line numbers, error messages, fix steps, rename chores): record only if the lesson is reusable for future tasks; one-off -> skip.',
    '2. In-progress/ephemeral states ("implementing X", "planning Y", "proposal pending"): record only after settled or decided.',
    '3. Pure changelog events ("released v1.0.0", "committed abc"): record only if the event affects future work.',
    '4. Process chatter (which options were compared, what code was read): record only if it produced a reusable conclusion.',
    '5. Already covered info: when grep hits already cover the fact and nothing new is added, skip.',
    '',
    'PRIORITY: when in doubt, prefer skip over create. Only record facts/decisions that would still be useful weeks later.',
    '',
    'EXISTING MEMORY RULES (the user turn lists the memory index of existing files):',
    '- Before create, check the index. If an existing file covers the same topic/entity/project/person, use merge into that file instead of create.',
    '- create only when no existing file covers the topic.',
    '- merge must add only NEW facts not already present in that file (no duplicates).',
    '- If the new fact contradicts an existing file, use update (old content moves to History).',
    '',
    ...privacySection,
    '',
    'Reply with exactly ONE JSON object matching this schema (choose one of the four):',
    '{"decision":"create","topic":"...","title":"...","summary":"...","content":"..."}',
    '{"decision":"merge","path":"...","content":"..."}',
    '{"decision":"update","path":"...","content":"..."}',
    '{"decision":"skip","reason":"..."}',
    '',
    'CONTENT FORMAT:',
    '- content is plain text, one self-contained statement per line. Do NOT prefix lines with "- " or "* "; the store adds list markers itself.',
    '- State the conclusion and, when it matters, the reason and the date (YYYY-MM-DD). Never record the debugging story.',
    '- summary (create only, required): ONE sentence, at most 80 characters, describing what the whole file is about (topic and scope).',
    '',
    'STRICT OUTPUT RULES:',
    '- Your entire reply must be exactly one JSON object and nothing else.',
    '- No prose, no explanation, no markdown, no code fences, no trailing period.',
    '- The JSON must be valid, balanced, and use half-width braces and quotes.',
    '- Path values must be relative .md paths inside the memory vault (e.g. infra/cpa.md or preferences/mac.md).',
    '- topic is required only for create.',
  ].join('\n')
}

/** The system instruction for the reconcile call that follows a merge/update on an existing file. */
export function reconcileSystem(): string {
  return [
    'You maintain ONE existing memory file. You are given its current lines (numbered "N| text") and a proposed addition. Decide how to fold the addition in without duplicates or contradictions.',
    'Reply with exactly ONE JSON object, one of:',
    '{"decision":"noop","reason":"..."}',
    '{"decision":"patch","ops":[...],"summary":"..."}',
    'Operations (line numbers refer to the numbered lines shown):',
    '- {"op":"replace","line":N,"content":"..."}: rewrite line N. Use this when the addition updates, corrects or contradicts that line; keep still-valid details and dates.',
    '- {"op":"delete","line":N}: remove line N only when the addition clearly supersedes it or it is an exact duplicate.',
    '- {"op":"insert","after":N,"content":"..."}: add new lines after line N (0 = top), next to related lines.',
    '- {"op":"append","content":"..."}: add genuinely new facts at the end.',
    'Rules:',
    '- If every fact in the addition is already present, answer noop.',
    '- Prefer replace over append when an existing line covers the same fact; never leave two lines that disagree.',
    '- Do not touch unrelated lines. Never delete more than a few lines. At most 12 operations.',
    '- content is plain text, one self-contained statement per line, without numbering and without a leading "- ".',
    '- summary is optional: only give it when the file\'s overall topic changed; ONE sentence of at most 80 characters.',
    '',
    'STRICT OUTPUT RULES:',
    '- Your entire reply must be exactly one JSON object and nothing else.',
    '- No prose, no explanation, no markdown, no code fences, no trailing period.',
    '- The JSON must be valid, balanced, and use half-width braces and quotes.',
  ].join('\n')
}

/** The user turn for the reconcile call. */
export function buildReconcileUser(
  title: string,
  numbered: string,
  truncated: boolean,
  kind: 'create' | 'merge' | 'update',
  proposed: string,
): string {
  const hint = kind === 'update'
    ? 'The extractor believes parts of the current file are OUTDATED or CONTRADICTED by this addition.'
    : 'The extractor proposes adding this to the file.'
  return [
    `## Memory file: ${title}`,
    '## Current lines' + (truncated ? ' (long lines shortened with …; replace/delete still work by line number)' : ''),
    numbered,
    '## Proposed addition',
    hint,
    proposed,
    'Reply with the single JSON object only (see STRICT OUTPUT RULES).',
  ].join('\n\n')
}

/** The user turn: digest + window + existing topics + memory index + grep hits. */
export function buildExtractionUser(
  digest: string | undefined,
  windowText: string,
  indexEntries: readonly IndexEntryLike[],
  grepHits: readonly GrepHitLike[],
  existingTopics: readonly string[] = [],
): string {
  const sections: string[] = []
  if (digest !== undefined && digest !== '') {
    sections.push('## 会话滚动摘要（前序窗口）', digest)
  }
  sections.push('## 本轮对话窗口', windowText)
  if (existingTopics.length > 0) {
    sections.push('## 现有主题列表（优先复用，勿为单条记忆新建主题）', existingTopics.join(', '))
  }
  if (indexEntries.length > 0) {
    sections.push('## 记忆库现有文件（全库索引）', indexEntries.map(entry => `- ${entry.path}: ${entry.summary}`).join('\n'))
  }
  if (grepHits.length > 0) {
    sections.push('## 已存在的相关记忆（grep 命中）', grepHits.map(hit => `- ${hit.path}: ${hit.line}`).join('\n'))
  }
  sections.push('只输出上面的 JSON 决策对象（严格遵守系统指令的 STRICT OUTPUT RULES），不要任何解释、markdown 或代码围栏。')
  return sections.join('\n\n')
}
