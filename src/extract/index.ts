/**
 * Implicit extraction (channel B): trigger wiring and the background extraction
 * job for the Unified Topic Vault.
 *
 * Enforces the dual trust boundary: if EITHER the session (cwd/provider) OR the
 * extraction LLM route is restricted, `private/` is completely withheld from
 * the extractor and any write targeting `private/` is dropped cleanly.
 * @module dsh-memory-lite/src/extract
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { BlockAssembler, createUserMessage, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-timer'
import type { MemoryStore } from '../memory-store.js'
import type { TrustContext } from '../types.js'
import { trustForSession, type MemoryDeps, type SessionContextLike } from '../tool-utils.js'
import type { StatusTracker } from '../status.js'
import { parseMemoryFile, slugify, summaryOf } from '../memory-store.js'
import { isPrivatePath, normalizeTopic, topicOfPath, UNRESTRICTED_TRUST } from '../privacy.js'
import { MemoryPathError } from '../path.js'
import { numberedView, PatchError } from '../patch.js'
import { countsTowardExtraction, selectWindow, renderEventText } from './window.js'
import { shouldExtractIdle, shouldExtractTurn, shouldExtractWindow } from './triggers.js'
import { parseDecision, parseReconcile, type ExtractionDecision, type ReconcileDecision } from './decision.js'
import { digestApproxTokens, rollDigest } from './digest.js'
import { emptyCheckpoint, parseCheckpoint, withRun, renderCheckpoint, type CheckpointFile } from './checkpoint.js'
import { buildExtractionUser, buildReconcileUser, extractionSystem, reconcileSystem } from './prompt.js'

const DIGEST_MAX_TOKENS = 100
const MAX_KEYWORDS = 8
const MAX_GREP_HITS = 8
const EXTRACTION_MAX_TOKENS = 32768

interface Route {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: import('@deepseek-ai/dsh-llm').ReasoningEffortId
}

interface GrepHit {
  readonly path: string
  readonly line: string
}

interface RunMetrics {
  llmCalls: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

interface RunRecordCtx {
  readonly ctx: Context
  readonly state: ExtractionState
  readonly store: MemoryStore
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
  readonly events?: readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
  snapshotEvents?(fromSeq?: number, toSeqExclusive?: number): readonly { readonly type: string; readonly seq: number; readonly data: unknown }[]
  requestHeader(): { readonly config?: { readonly provider?: string; readonly model?: string } } | undefined
}

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
    if (!countsTowardExtraction(event, ext().messageScope)) return
    const state = stateOf(session)
    state.pending += 1
    resetIdle(session, state)
    if (shouldExtractWindow(state.pending, ext().windowTurns)) maybeSchedule(session, state)
  })

  ctx.on('agent/turn-stopping', ({ agent }) => {
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

/** One extraction run: window -> trust gate -> grep -> LLM -> reconcile -> checkpoint. */
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
  if (state.checkpoint.checkpoint.seq === 0 && state.checkpoint.audit.length === 0) {
    const raw = await store.readSessionCheckpoint(session.id)
    if (raw !== undefined) state.checkpoint = parseCheckpoint(raw)
  }
  const events = sessionEvents(session)
  let maxSeq = 0
  for (const event of events) {
    if (event.seq > maxSeq) maxSeq = event.seq
  }
  const storedSeq = state.checkpoint.checkpoint.seq
  const fromSeq = storedSeq > maxSeq ? 0 : storedSeq
  const windowEvents = selectWindow(events, fromSeq, ext.maxMessages, ext.messageScope)
  if (windowEvents.length === 0) {
    state.pending = 0
    return
  }
  const windowStart = windowEvents[0]!.seq
  const windowEnd = windowEvents[windowEvents.length - 1]!.seq
  const windowText = windowEvents.map(event => renderEventText(event, ext.toolResultMaxBytes)).join('\n')

  const startedAt = Date.now()
  const metrics: RunMetrics = { llmCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const route = resolveRoute(ext.llm.route, ext.llm.reasoningEffort, deps.defaultModel, session)

  // Dual trust gate: restricted if EITHER the session OR the extraction model provider is restricted.
  const trust = trustForSession(session as unknown as SessionContextLike, deps, [route?.provider])

  let hits: readonly GrepHit[] = []
  if (ext.dedup) {
    const keywords = extractKeywords(windowText, MAX_KEYWORDS)
    hits = await grepHits(store, keywords, MAX_GREP_HITS, trust)
  }
  const indexEntries = await store.readIndex(trust).catch(() => [])
  const existingTopics = [...new Set(indexEntries.map(e => e.topic))]

  const rc: RunRecordCtx = {
    ctx, state, store, sessionId: session.id, windowStart, windowEnd, hits, route, metrics, startedAt,
    auditLog: ext.auditLog, tracker,
  }
  if (route === undefined) {
    await recordRun(rc, 'no-route', undefined, undefined, undefined, false)
    return
  }

  const system = extractionSystem({
    restricted: trust.restricted,
    privateNamespace: config.privacy.namespace,
  })
  const user = buildExtractionUser(
    state.checkpoint.digest === '' ? undefined : state.checkpoint.digest,
    windowText,
    indexEntries,
    hits,
    existingTopics,
  )

  let text = ''
  try {
    metrics.llmCalls += 1
    const call = await callExtraction(ctx, route, system, user, signal)
    text = call.text
    addUsage(metrics, call)
  } catch (error) {
    metrics.inputTokens += digestApproxTokens(system) + digestApproxTokens(user)
    await recordRun(rc, 'llm-error: ' + String(error).slice(0, 200), undefined, undefined, undefined, false)
    return
  }

  let decision: ExtractionDecision
  let recovered = false
  try {
    decision = parseDecision(text)
  } catch (error) {
    const note = 'parse-error: ' + String(error).slice(0, 200)
    void store.appendFailedAnswer({
      at: new Date().toISOString(),
      session: session.id,
      win: [windowStart, windowEnd],
      route,
      error: String(error).slice(0, 300),
      text,
    })
    if (ext.parseRetry) {
      metrics.llmCalls += 1
      const repairUser = buildRepairUser(text)
      const repaired = await callExtraction(ctx, route, system, repairUser, signal).catch(() => undefined)
      if (repaired !== undefined) {
        addUsage(metrics, repaired)
        try {
          decision = parseDecision(repaired.text)
          recovered = true
          text = repaired.text
        } catch {
          await recordRun(rc, note, undefined, undefined, undefined, false)
          return
        }
      } else {
        metrics.inputTokens += digestApproxTokens(system) + digestApproxTokens(repairUser)
        await recordRun(rc, note, undefined, undefined, undefined, false)
        return
      }
    } else {
      await recordRun(rc, note, undefined, undefined, undefined, false)
      return
    }
  }

  const hooks: ApplyHooks = {
    trust,
    ...(ext.reconcile
      ? {
          reconcile: async (request): Promise<ReconcileAnswer> => {
            const view = numberedView(request.current, ext.reconcileMaxBytes)
            if (view === undefined) return { kind: 'fallback', reason: 'current-too-large' }
            const reconcileSystemText = reconcileSystem()
            const reconcileUser = buildReconcileUser(request.title, view.text, view.truncated, request.kind, request.content)
            metrics.llmCalls += 1
            let call: Awaited<ReturnType<typeof callExtraction>>
            try {
              call = await callExtraction(ctx, route, reconcileSystemText, reconcileUser, signal)
            } catch (error) {
              if (signal.aborted) throw error
              metrics.inputTokens += digestApproxTokens(reconcileSystemText) + digestApproxTokens(reconcileUser)
              return { kind: 'fallback', reason: 'llm-error: ' + String(error).slice(0, 160) }
            }
            addUsage(metrics, call)
            try {
              return parseReconcile(call.text)
            } catch (error) {
              void store.appendFailedAnswer({
                at: new Date().toISOString(),
                session: session.id,
                win: [windowStart, windowEnd],
                route,
                stage: 'reconcile',
                error: String(error).slice(0, 300),
                text: call.text,
              })
              return { kind: 'fallback', reason: 'parse-error: ' + String(error).slice(0, 160) }
            }
          },
        }
      : {}),
  }

  let applied: AppliedDecision
  try {
    applied = await applyDecisionDetailed(store, decision, hooks)
  } catch (error) {
    await recordRun(rc, 'apply-error: ' + String(error).slice(0, 200), decision.kind, undefined, undefined, false)
    return
  }
  if (applied.fallback !== undefined) {
    ctx.logger.warn('dsh-memory-lite: reconcile fell back to append for ' + String(applied.path) + ' (' + applied.fallback + ')')
  }
  if (applied.path !== undefined && applied.applied !== 'skip' && applied.applied !== 'noop') {
    const topic = topicOfPath(applied.path)
    if (topic !== '') void deps.affinity?.record(session.header.cwd, topic)
  }

  const digest = rollDigest(state.checkpoint.digest, windowText, DIGEST_MAX_TOKENS)
  await recordRun(
    rc,
    recovered ? 'parse-error-recovered' : undefined,
    applied.applied,
    applied.path,
    digest,
    true,
    applied.fallback === undefined ? undefined : { reconcileFallback: applied.fallback },
  )
}

function buildRepairUser(failedAnswer: string): string {
  return [
    'An earlier extraction answer was not valid JSON. Convert it into exactly ONE JSON decision object following the schema and STRICT OUTPUT RULES in the system instructions.',
    'Reply with only the JSON object, nothing else.',
    '',
    'Failed answer:',
    failedAnswer.slice(0, 2000),
  ].join('\n')
}

async function recordRun(
  rc: RunRecordCtx,
  note: string | undefined,
  decision: string | undefined,
  path: string | undefined,
  digest: string | undefined,
  advance: boolean,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const { ctx, state, store, sessionId, windowStart, windowEnd, hits, route, metrics, startedAt, auditLog, tracker } = rc
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
    ...extra,
  }
  const nextSeq = advance ? windowEnd : state.checkpoint.checkpoint.seq
  state.checkpoint = auditLog
    ? withRun(state.checkpoint, nextSeq, entry)
    : { ...state.checkpoint, checkpoint: { seq: nextSeq } }
  if (digest !== undefined) {
    state.checkpoint = { ...state.checkpoint, digest }
  }
  state.pending = 0
  await store.writeSessionCheckpoint(sessionId, renderCheckpoint(state.checkpoint))

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
      ...extra,
    }
    await store.appendExtractionLog(JSON.stringify(logLine))
    ctx.logger.info(
      'dsh-memory-lite: extraction ' + outcome + ' calls=' + metrics.llmCalls +
      ' in=' + metrics.inputTokens + ' out=' + metrics.outputTokens + ' ms=' + durationMs +
      ' win[' + windowStart + '..' + windowEnd + ']',
    )
  }
  tracker.reportRun(outcome, note ?? null, decision ?? null)
}

/** What the reconcile model is asked to fold into an existing file. */
export interface ReconcileRequest {
  readonly path: string
  readonly title: string
  readonly current: string
  readonly kind: 'create' | 'merge' | 'update'
  readonly content: string
}

export type ReconcileAnswer = ReconcileDecision | { readonly kind: 'fallback'; readonly reason: string }

export interface ApplyHooks {
  readonly reconcile?: (request: ReconcileRequest) => Promise<ReconcileAnswer>
  readonly trust?: TrustContext
}

export interface AppliedDecision {
  readonly path: string | undefined
  readonly applied: 'create' | 'merge' | 'update' | 'patch' | 'noop' | 'skip'
  readonly fallback?: string
}

/** Apply one decision through the store (all writes go through the queue). */
export async function applyDecision(
  store: MemoryStore,
  decision: ExtractionDecision,
  hooks: ApplyHooks = {},
): Promise<string | undefined> {
  return (await applyDecisionDetailed(store, decision, hooks)).path
}

/** Apply one decision and report how it landed, enforcing trust-boundary rules. */
export async function applyDecisionDetailed(
  store: MemoryStore,
  decision: ExtractionDecision,
  hooks: ApplyHooks = {},
): Promise<AppliedDecision> {
  if (decision.kind === 'skip') return { path: undefined, applied: 'skip' }
  const trust = hooks.trust ?? UNRESTRICTED_TRUST
  const ns = store.privateNamespace

  let path: string
  let title: string | undefined
  if (decision.kind === 'create') {
    let topic = normalizeTopic(decision.topic, ns)
    // Restricted mode: never allow background extraction to write private/.
    if (trust.restricted && isPrivatePath(topic, ns)) {
      return { path: undefined, applied: 'skip' }
    }
    // Private-path safety net: force writes inside privatePaths into their private topic.
    if (!trust.restricted && trust.forcedPrivateTopic !== undefined && !isPrivatePath(topic, ns)) {
      topic = trust.forcedPrivateTopic
    }
    title = decision.title.replace(/\.md$/i, '')
    path = `${topic}/${slugify(title)}.md`
  } else {
    path = decision.path
    if (trust.restricted && isPrivatePath(path, ns)) {
      return { path, applied: 'skip' }
    }
    // Verify write permission early so illegal paths never slip through.
    try {
      await store.resolve(path, { write: true, trust })
    } catch (error) {
      if (error instanceof MemoryPathError && trust.restricted) {
        return { path, applied: 'skip' }
      }
      throw error
    }
  }

  const exists = await store.fileExists(path, trust).catch(() => false)
  let fallback: string | undefined

  if (exists && hooks.reconcile !== undefined) {
    const file = await store.readFile(path, trust)
    const parsed = parseMemoryFile(file.content)
    if (parsed.current !== '') {
      const answer = await hooks.reconcile({
        path,
        title: parsed.title === '' ? path : parsed.title,
        current: parsed.current,
        kind: decision.kind,
        content: decision.content,
      })
      if (answer.kind === 'noop') return { path, applied: 'noop' }
      if (answer.kind === 'patch') {
        try {
          const result = await store.patchCurrent(path, answer.ops, trust)
          if (answer.summary !== undefined) await store.refreshIndexEntry(path, answer.summary)
          else if (result.changed) await store.ensureIndexEntry(path, summaryOf(parsed.title === '' ? decision.content : parsed.title))
          return { path, applied: result.changed ? 'patch' : 'noop' }
        } catch (error) {
          if (!(error instanceof PatchError)) throw error
          fallback = 'patch-rejected: ' + error.message
        }
      } else {
        fallback = answer.reason
      }
    }
  }

  const summary = decision.kind === 'update' || decision.kind === 'create' ? decision.summary : undefined
  if (decision.kind === 'create' && !exists) {
    await store.writeNewMemory(path, title ?? decision.title, decision.content, trust)
    await store.refreshIndexEntry(path, summary ?? summaryOf(decision.content))
    return { path, applied: 'create' }
  }
  const blindReplace = decision.kind === 'update' && !(exists && hooks.reconcile !== undefined)
  if (blindReplace) {
    await store.updateCurrent(path, decision.content, trust)
    if (summary !== undefined) await store.refreshIndexEntry(path, summary)
    else await store.ensureIndexEntry(path, summaryOf(decision.content))
    return { path, applied: 'update' }
  }
  await store.appendCurrent(path, decision.content, trust)
  await store.ensureIndexEntry(path, summaryOf(decision.content))
  return { path, applied: decision.kind === 'create' ? 'create' : decision.kind, ...(fallback === undefined ? {} : { fallback }) }
}

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

function finishFailureDetail(finish: {
  readonly failure?: { readonly message?: string; readonly code?: string; readonly status?: number }
}): string {
  const failure = finish.failure
  if (failure === undefined) return ''
  const message = typeof failure.message === 'string' ? failure.message : ''
  const code = typeof failure.code === 'string' && failure.code !== '' ? failure.code : ''
  const status = typeof failure.status === 'number' ? String(failure.status) : ''
  if (message === '') return code === '' ? '' : code + (status === '' ? '' : ' ' + status)
  return message + (code === '' ? '' : ' [' + code + (status === '' ? '' : ' ' + status) + ']')
}

async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<{ text: string; usage: TokenUsage | undefined }> {
  const assembler = new BlockAssembler()
  for await (const chunk of stream) assembler.push(chunk)
  const finish = assembler.finish
  if (finish.kind === 'aborted' || finish.kind === 'error') {
    const detail = finishFailureDetail(finish)
    throw new Error('llm stream finished with ' + finish.kind + (detail === '' ? '' : ': ' + detail))
  }
  if (finish.kind === 'max-tokens') {
    throw new Error('llm stream finished with max-tokens')
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
      source: { kind: 'plugin:dsh-memory-lite' },
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

async function grepHits(
  store: MemoryStore,
  keywords: readonly string[],
  max: number,
  trust: TrustContext,
): Promise<GrepHit[]> {
  const seen = new Set<string>()
  const hits: GrepHit[] = []
  for (const keyword of keywords) {
    if (hits.length >= max) break
    for (const match of await store.search(keyword, { trust })) {
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
