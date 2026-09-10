/**
 * Implicit extraction (Phase 2, channel B): trigger wiring and the background
 * extraction job. Event handlers only count and schedule; the LLM work runs
 * inside a ctx.jobs task, never awaited inside serial event callbacks (the
 * agent/turn-stopping contract, verified in dsh-agent-loop source).
 *
 * Model resolution: config.extraction.llm wins when set; otherwise the
 * session's current model (session.requestHeader().config) is reused.
 * @module dsh-memory-lite/src/extract
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { MemoryStore } from '../memory-store.js'
import { peerForHeader } from '../peer.js'
import type { MemoryDeps } from '../tool-utils.js'
import type { StatusTracker } from '../status.js'
import { MEMORY_CATEGORIES } from '../types.js'
import { slugify, summaryOf } from '../memory-store.js'
import { isSurfaceType, inScope, selectWindow, renderEventText } from './window.js'
import { shouldExtractIdle, shouldExtractTurn, shouldExtractWindow } from './triggers.js'
import { parseDecision, type ExtractionDecision } from './decision.js'
import { digestApproxTokens, rollDigest } from './digest.js'
import { emptyCheckpoint, parseCheckpoint, withRun, renderCheckpoint, type CheckpointFile } from './checkpoint.js'
import { buildExtractionUser, extractionSystem } from './prompt.js'

const DIGEST_MAX_TOKENS = 100
const MAX_KEYWORDS = 8
const MAX_GREP_HITS = 8
// Bumped 1024 -> 4096 (2026-08-28): with extraction.llm.reasoningEffort = high
// the model's reasoning pass consumed the whole 1024-token budget and the
// answer text came back empty (every failed answer logged textLen=0), forcing
// the repair path on ~85% of runs. 4096 leaves room for both reasoning and the
// JSON decision body.
const EXTRACTION_MAX_TOKENS = 4096

interface Route {
  readonly provider: string
  readonly model: string
  /** Adapter-owned reasoning effort; absent = adapter/provider default. */
  readonly reasoningEffort?: import('@deepseek-ai/dsh-llm').ReasoningEffortId
}

interface GrepHit {
  readonly path: string
  readonly line: string
}

/** Per-run metrics accumulated across LLM calls (1 call, or 2 with a repair). */
interface RunMetrics {
  llmCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Fixed inputs for one run's record; metrics accumulate as calls happen. */
interface RunRecordCtx {
  readonly ctx: Context
  readonly state: ExtractionState
  readonly store: MemoryStore
  readonly peer: string
  readonly sessionId: string
  readonly windowStart: number
  readonly windowEnd: number
  readonly hits: readonly GrepHit[]
  readonly route: Route | undefined
  readonly metrics: RunMetrics
  readonly startedAt: number
  readonly auditLog: boolean
  readonly tracker: StatusTracker
}

interface ExtractionState {
  pending: number
  lastExtractAt: number | null
  inFlight: boolean
  checkpoint: CheckpointFile
  idleDispose: (() => void) | null
  cancel: (() => void) | null
}

/** Minimal structural view of a session the extractor reads; real Sessions satisfy it. */
export interface ExtractionSessionLike {
  readonly id: string
  readonly header: { readonly cwd?: string; readonly origin?: 'subagent' }
  /** dsh-session <= 0.1.1 exposed the full log as `events`; >= 0.1.2 uses snapshotEvents(). */
  readonly events?: readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
  requestHeader(): { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined
}

/** Read a session's full event log across dsh-session versions (events vs snapshotEvents). */
function sessionEvents(session: ExtractionSessionLike): readonly { readonly type: string; readonly seq: number; readonly data: unknown }[] {
  if (session.snapshotEvents !== undefined) return session.snapshotEvents()
  return session.events ?? []
}

/** Register the extraction channel for the lifetime of `ctx`. */
export function applyExtraction(ctx: Context, deps: MemoryDeps, tracker: StatusTracker): void {
  const ext = () => deps.config().extraction
  if (ext().mode === 'off') return

  const states = new Map<string, ExtractionState>()

  function stateOf(session: Session): ExtractionState {
    let state = states.get(session.id)
    if (state === undefined) {
      state = {
        pending: 0,
        lastExtractAt: null,
        inFlight: false,
        checkpoint: emptyCheckpoint(),
        idleDispose: null,
        cancel: null,
      }
      states.set(session.id, state)
    }
    return state
  }

  function resetIdle(session: Session, state: ExtractionState): void {
    if (ext().mode !== 'incremental') return
    state.idleDispose?.()
    state.idleDispose = null
    state.idleDispose = ctx.timeout(() => {
      if (shouldExtractIdle(state.pending)) maybeSchedule(session, state)
    }, ext().idleTimeoutMin * 60_000)
  }

  function maybeSchedule(session: Session, state: ExtractionState): void {
    if (ext().mode !== 'incremental') return
    if (state.inFlight) return
    state.inFlight = true
    runExtraction(session, state, ctx, deps, tracker)
  }

  ctx.on('session/event', (session, event) => {
    if (session.header.origin === 'subagent') return
    if (!isSurfaceType(event.type)) return
    if (!inScope(event.type, ext().messageScope)) return
    const state = stateOf(session)
    state.pending += 1
    resetIdle(session, state)
    if (shouldExtractWindow(state.pending, ext().windowTurns)) maybeSchedule(session, state)
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
    // Disabled 2026-08-25 (方案 C): turn-boundary extraction turned off to cut
    // LLM calls; the 30-min idle timer remains the timeliness backstop. Re-enable
    // by setting extraction.turnStoppingTrigger back to true (IMPLEMENTATION.md §13.2 偏差 12).
    if (!ext().turnStoppingTrigger) return
    const session = agent.session
    if (session.header.origin === 'subagent') return
    const state = stateOf(session)
    if (shouldExtractTurn(state.pending, Date.now(), state.lastExtractAt, ext().minTurnExtract, ext().turnDebounceMs)) {
      maybeSchedule(session, state)
    }
  })

  ctx.on('session/flush', (session) => {
    if (!ext().flushTrigger) return
    if (session.header.origin === 'subagent') return
    const state = stateOf(session)
    if (shouldExtractTurn(state.pending, Date.now(), state.lastExtractAt, ext().minTurnExtract, ext().turnDebounceMs)) {
      maybeSchedule(session, state)
    }
  })

  ctx.on('session/disposed', (session) => {
    const state = states.get(session.id)
    if (state !== undefined) {
      state.idleDispose?.()
      state.cancel?.()
      states.delete(session.id)
    }
  })
}

/** Fire-and-forget extraction producer; never awaited in serial event callbacks. */
function runExtraction(
  session: Session,
  state: ExtractionState,
  ctx: Context,
  deps: MemoryDeps,
  tracker: StatusTracker,
): void {
  const controller = new AbortController()
  const cancel = (): void => {
    controller.abort('memory extraction cancelled')
  }
  state.cancel = cancel
  void (async (): Promise<void> => {
    try {
      await extractOnce(session, state, ctx, deps, controller.signal, tracker)
    } catch (error) {
      if (!controller.signal.aborted) {
        tracker.reportError(String(error))
        ctx.logger.warn('dsh-memory-lite: extraction failed: ' + String(error))
      }
    } finally {
      state.inFlight = false
      state.lastExtractAt = Date.now()
      state.cancel = null
    }
  })()
}

/** One extraction run: window -> grep -> LLM -> write -> checkpoint. */
export async function extractOnce(
  session: ExtractionSessionLike,
  state: ExtractionState,
  ctx: Context,
  deps: MemoryDeps,
  signal: AbortSignal,
  tracker: StatusTracker,
): Promise<void> {
  const config = deps.config()
  const ext = config.extraction
  const store = deps.store
  const peer = peerForHeader(session.header as Parameters<typeof peerForHeader>[0], config)
  if (state.checkpoint.checkpoint.seq === 0 && state.checkpoint.audit.length === 0) {
    const raw = await store.readSessionCheckpoint(peer, session.id)
    if (raw !== undefined) state.checkpoint = parseCheckpoint(raw)
  }
  const fromSeq = state.checkpoint.checkpoint.seq
  const events = sessionEvents(session)
  const windowEvents = selectWindow(events, fromSeq, ext.maxMessages, ext.messageScope)
  if (windowEvents.length === 0) return
  const windowStart = windowEvents[0]!.seq
  const windowEnd = windowEvents[windowEvents.length - 1]!.seq
  const windowText = windowEvents.map(event => renderEventText(event, ext.toolResultMaxBytes)).join('\n')

  let hits: readonly GrepHit[] = []
  if (ext.dedup) {
    const keywords = extractKeywords(windowText, MAX_KEYWORDS)
    hits = await grepHits(store, peer, keywords, MAX_GREP_HITS)
  }
  // Full-memory index for de-fragmentation: lets the model merge into an
  // existing file instead of creating a new one for the same topic. Already
  // sorted newest-first; read failures fall back to an empty index.
  const indexEntries = await store.readIndex(peer).catch(() => [])

  const startedAt = Date.now()
  const metrics: RunMetrics = { llmCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const route = resolveRoute(ext.llm.route, ext.llm.reasoningEffort, deps.defaultModel, session)
  const rc: RunRecordCtx = {
    ctx, state, store, peer, sessionId: session.id, windowStart, windowEnd, hits, route, metrics, startedAt,
    auditLog: ext.auditLog, tracker,
  }
  if (route === undefined) {
    await recordRun(rc, 'no-route', undefined, undefined, undefined)
    return
  }

  const system = extractionSystem()
  const user = buildExtractionUser(
    state.checkpoint.digest === '' ? undefined : state.checkpoint.digest,
    windowText,
    indexEntries,
    hits,
  )
  let text = ''
  try {
    metrics.llmCalls += 1
    const call = await callExtraction(ctx, route, system, user, signal)
    text = call.text
    addUsage(metrics, call)
  } catch (error) {
    metrics.inputTokens += digestApproxTokens(system) + digestApproxTokens(user)
    await recordRun(rc, 'llm-error: ' + String(error).slice(0, 200), undefined, undefined, undefined)
    return
  }

  let decision: ExtractionDecision
  let recovered = false
  try {
    decision = parseDecision(text)
  } catch (error) {
    const note = 'parse-error: ' + String(error).slice(0, 200)
    // Diagnostic: persist the raw failed answer so a parse-error spike can be
    // investigated (the model's output shape decides whether the repair is
    // helping). Best-effort; never blocks the run.
    void store.appendFailedAnswer(peer, {
      at: new Date().toISOString(),
      session: session.id,
      win: [windowStart, windowEnd],
      route: route === undefined ? null : route,
      error: String(error).slice(0, 300),
      text,
    })
    // Bounded one-shot repair (Phase 2.1): re-ask the model to emit valid JSON
    // from the failed answer only — cheap, no window resend. A second failure
    // is accepted and the checkpoint still advances (no infinite retry loop).
    if (ext.parseRetry) {
      metrics.llmCalls += 1
      const repairSystem = extractionSystem()
      const repairUser = buildRepairUser(text)
      const repaired = await callExtraction(ctx, route, repairSystem, repairUser, signal).catch(() => undefined)
      if (repaired !== undefined) {
        addUsage(metrics, repaired)
        try {
          decision = parseDecision(repaired.text)
          recovered = true
          text = repaired.text
        } catch {
          await recordRun(rc, note, undefined, undefined, undefined)
          return
        }
      } else {
        metrics.inputTokens += digestApproxTokens(repairSystem) + digestApproxTokens(repairUser)
        await recordRun(rc, note, undefined, undefined, undefined)
        return
      }
    } else {
      await recordRun(rc, note, undefined, undefined, undefined)
      return
    }
  }

  let path: string | undefined
  try {
    path = await applyDecision(store, peer, decision)
  } catch (error) {
    await recordRun(rc, 'apply-error: ' + String(error).slice(0, 200), decision.kind, undefined, undefined)
    return
  }

  const digest = rollDigest(state.checkpoint.digest, windowText, DIGEST_MAX_TOKENS)
  await recordRun(rc, recovered ? 'parse-error-recovered' : undefined, decision.kind, path, digest)
}

/** The repair turn: convert a failed non-JSON answer into a valid JSON decision. */
function buildRepairUser(failedAnswer: string): string {
  return [
    'An earlier extraction answer was not valid JSON. Convert it into exactly ONE JSON decision object following the schema and STRICT OUTPUT RULES in the system instructions.',
    'Reply with only the JSON object, nothing else.',
    '',
    'Failed answer:',
    failedAnswer.slice(0, 2000),
  ].join('\n')
}

/**
 * Persist the run outcome: advance the checkpoint (bounds retry loops), append
 * the run metrics to the session audit and the peer summary log, and log a
 * one-line summary. When auditLog is off the audit entry and summary log are
 * skipped but the checkpoint seq still advances (functional requirement).
 */
async function recordRun(
  rc: RunRecordCtx,
  note: string | undefined,
  decision: string | undefined,
  path: string | undefined,
  digest: string | undefined,
): Promise<void> {
  const { ctx, state, store, peer, sessionId, windowStart, windowEnd, hits, route, metrics, startedAt, auditLog, tracker } = rc
  const durationMs = Date.now() - startedAt
  const outcome = note !== undefined ? note.split(':')[0]!.trim() : (decision ?? 'error')
  const at = new Date().toISOString()
  const entry = {
    at,
    windowSeq: [windowStart, windowEnd] as [number, number],
    grepHits: hits.map(hit => hit.path + ': ' + hit.line),
    ...(route === undefined ? {} : { route }),
    maxTokens: EXTRACTION_MAX_TOKENS,
    decision: decision ?? (note ?? 'error'),
    ...(path === undefined ? {} : { path }),
    ...(note === undefined ? {} : { note }),
    llmCalls: metrics.llmCalls,
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    ...(metrics.cacheReadTokens > 0 ? { cacheReadTokens: metrics.cacheReadTokens } : {}),
    ...(metrics.cacheWriteTokens > 0 ? { cacheWriteTokens: metrics.cacheWriteTokens } : {}),
    durationMs,
  }
  state.checkpoint = auditLog
    ? withRun(state.checkpoint, windowEnd, entry)
    : { ...state.checkpoint, checkpoint: { seq: windowEnd } }
  if (digest !== undefined) {
    state.checkpoint = { ...state.checkpoint, digest }
  }
  state.pending = 0
  await store.writeSessionCheckpoint(peer, sessionId, renderCheckpoint(state.checkpoint))

  if (auditLog) {
    const logLine = {
      at,
      session: sessionId,
      win: [windowStart, windowEnd] as [number, number],
      llmCalls: metrics.llmCalls,
      inputTokens: metrics.inputTokens,
      outputTokens: metrics.outputTokens,
      cacheReadTokens: metrics.cacheReadTokens,
      cacheWriteTokens: metrics.cacheWriteTokens,
      durationMs,
      outcome,
      decision: decision ?? null,
      path: path ?? null,
      note: note ?? null,
      route: route ?? null,
    }
    await store.appendExtractionLog(peer, JSON.stringify(logLine))
    ctx.logger.info(
      'dsh-memory-lite: extraction ' + outcome + ' calls=' + metrics.llmCalls +
      ' in=' + metrics.inputTokens + ' out=' + metrics.outputTokens + ' ms=' + durationMs +
      ' win[' + windowStart + '..' + windowEnd + ']',
    )
  }
  tracker.reportRun(outcome, note ?? null, decision ?? null)
}

/** Apply one decision through the store (all writes go through the queue). */
export async function applyDecision(
  store: MemoryStore,
  peer: string,
  decision: ExtractionDecision,
): Promise<string | undefined> {
  switch (decision.kind) {
    case 'create': {
      if (!MEMORY_CATEGORIES.includes(decision.category as never)) {
        throw new Error('unknown category: ' + decision.category)
      }
      // Model sometimes writes a title ending in ".md"; strip it so the
      // slug does not produce a double extension (e.g. foo.md.md).
      const title = decision.title.replace(/\.md$/i, '')
      const path = decision.category + '/' + slugify(title) + '.md'
      // Conservative implicit-channel rule: never overwrite an existing memory
      // (it may hold explicit user content); merge into it instead.
      if (await store.fileExists(peer, path)) {
        await store.appendCurrent(peer, path, decision.content)
        await store.refreshIndexEntry(peer, path, summaryOf(decision.content))
      } else {
        await store.writeNewMemory(peer, path, decision.title, decision.content)
        await store.refreshIndexEntry(peer, path, summaryOf(decision.content))
      }
      return path
    }
    case 'merge':
      await store.appendCurrent(peer, decision.path, decision.content)
      await store.refreshIndexEntry(peer, decision.path, summaryOf(decision.content))
      return decision.path
    case 'update':
      await store.updateCurrent(peer, decision.path, decision.content)
      await store.refreshIndexEntry(peer, decision.path, summaryOf(decision.content))
      return decision.path
    default:
      return undefined
  }
}

/**
 * Model route resolution order (§17):
 * 1. extraction.llm.route (explicit "provider/model") — fixed, ignores the global default.
 * 2. The global default model selection (agent-default-model), read live each run.
 * 3. Fallback: the session's current request-header model (legacy behavior).
 * Reasoning effort travels with whichever route won: explicit config first,
 * else the selection's own effort.
 */
function resolveRoute(
  configuredRoute: string | undefined,
  configuredEffort: string | undefined,
  defaultModel: (() => { readonly provider: string; readonly model: string; readonly reasoningEffort?: string }) | undefined,
  session: ExtractionSessionLike,
): Route | undefined {
  if (configuredRoute !== undefined && configuredRoute !== '') {
    const slash = configuredRoute.indexOf('/')
    if (slash > 0 && slash < configuredRoute.length - 1) {
      return {
        provider: configuredRoute.slice(0, slash),
        model: configuredRoute.slice(slash + 1),
        ...(configuredEffort !== undefined && configuredEffort !== '' ? { reasoningEffort: ReasoningEffortId(configuredEffort) } : {}),
      }
    }
  }
  if (defaultModel !== undefined) {
    const selection = defaultModel()
    if (selection !== undefined && selection.provider !== '' && selection.model !== '') {
      return {
        provider: selection.provider,
        model: selection.model,
        ...(configuredEffort !== undefined && configuredEffort !== '' ? { reasoningEffort: ReasoningEffortId(configuredEffort) } : {}),
        ...(configuredEffort === undefined || configuredEffort === ''
          ? selection.reasoningEffort !== undefined && selection.reasoningEffort !== ''
            ? { reasoningEffort: ReasoningEffortId(selection.reasoningEffort) }
            : {}
          : {}),
      }
    }
  }
  const headerConfig = session.requestHeader()?.config
  if (headerConfig !== undefined && headerConfig.provider !== undefined && headerConfig.model !== undefined) {
    return { provider: headerConfig.provider, model: headerConfig.model }
  }
  return undefined
}

/** Assemble the streamed text and real token usage; a non-success finish throws. */
async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<{ text: string; usage: TokenUsage | undefined }> {
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'aborted' || finish.kind === 'error') {
    throw new Error('llm stream finished with ' + finish.kind)
  }
  return {
    text: assembler
      .blocks()
      .filter(block => block.type === 'text')
      .map(block => (block as { text?: string }).text ?? '')
      .join(''),
    usage: assembler.usage,
  }
}

/**
 * One extraction LLM call. Token counts prefer the provider's real usage from
 * the stream; when absent they fall back to the bytes/3 estimate so a run
 * still records a defensible figure.
 */
async function callExtraction(
  ctx: Context,
  route: Route,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<{ text: string; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> {
  const options = {
    provider: route.provider,
    model: route.model,
    ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
    messages: [createUserMessage({
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin', plugin: 'dsh-memory-lite' },
    })],
    system,
    maxTokens: EXTRACTION_MAX_TOKENS,
    signal,
  }
  const { text, usage } = await collectStream(ctx.llm.stream(options))
  return {
    text,
    inputTokens: usage?.inputTokens ?? digestApproxTokens(system) + digestApproxTokens(user),
    outputTokens: usage?.outputTokens ?? digestApproxTokens(text),
    cacheReadTokens: usage?.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.cacheWriteTokens ?? 0,
  }
}

/** Fold one call's token figures into the run-wide accumulator. */
function addUsage(
  metrics: RunMetrics,
  call: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number },
): void {
  metrics.inputTokens += call.inputTokens
  metrics.outputTokens += call.outputTokens
  metrics.cacheReadTokens += call.cacheReadTokens
  metrics.cacheWriteTokens += call.cacheWriteTokens
}

/** Light keyword heuristic: frequent Latin words and CJK characters. */
export function extractKeywords(text: string, max: number): string[] {
  const counts = new Map<string, number>()
  const bump = (token: string): void => {
    if (STOP_WORDS.has(token) || token.length < 2) return
    counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) bump(word)
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) bump(ch)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(entry => entry[0])
}

/** Deduplicated grep hits across keywords, capped. */
async function grepHits(
  store: MemoryStore,
  peer: string,
  keywords: readonly string[],
  max: number,
): Promise<GrepHit[]> {
  const seen = new Set<string>()
  const hits: GrepHit[] = []
  for (const keyword of keywords) {
    if (hits.length >= max) break
    for (const match of await store.search(peer, keyword)) {
      const key = match.path + '\u0000' + match.line
      if (seen.has(key)) continue
      seen.add(key)
      hits.push(match)
      if (hits.length >= max) break
    }
  }
  return hits
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'will', 'were',
  '的', '了', '是', '我', '你', '他', '她', '它', '在', '有', '和', '就', '不', '人', '都',
  '一个', '我们', '你们', '他们', '这个', '那个', '什么', '怎么', '为什么', '可以', '需要',
])
