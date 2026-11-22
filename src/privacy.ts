/**
 * Trust-boundary evaluation, topic validation, and path glob matching.
 *
 * All privacy enforcement funnels through this module so L0 injection, the
 * five model-facing tools, and background extraction share one exact contract.
 * @module dsh-memory-lite/src/privacy
 */

import { resolve } from 'node:path'
import { expandHomePath } from '@deepseek-ai/dsh-home-paths'
import type { PrivacyConfig } from './config.js'
import { DEFAULT_PRIVATE_NAMESPACE, type TrustContext } from './types.js'

/** Normalize a filesystem path or pattern for matching (~ expanded, resolved, forward slashes). */
function normalizeMatchPath(raw: string): string {
  const expanded = expandHomePath(raw.trim())
  return resolve(expanded).replaceAll('\\', '/')
}

/** Escape regex metacharacters except `*`. */
function escapeRegexExceptStar(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Match a working directory against one path pattern (`~` expanded).
 * Supports exact paths, trailing `/**` (matches the directory itself and all
 * descendants, never sibling directories), `/**\/`, and single-segment `*`.
 */
export function matchPathPattern(cwd: string, pattern: string): boolean {
  const normCwd = normalizeMatchPath(cwd)
  const normPattern = normalizeMatchPath(pattern)
  if (!normPattern.includes('*')) return normCwd === normPattern
  const trailingGlobstar = normPattern.endsWith('/**')
  const core = trailingGlobstar ? normPattern.slice(0, -3) : normPattern
  const escaped = escapeRegexExceptStar(core)
    .replaceAll('/**/', '(?:/.*)?/')
    .replaceAll('**', '.*')
    .replaceAll('*', '[^/]*')
  const suffix = trailingGlobstar ? '(?:/.*)?' : ''
  return new RegExp(`^${escaped}${suffix}$`).test(normCwd)
}

/** Whether a relative memory path or topic belongs to the configured private namespace. */
export function isPrivatePath(relPathOrTopic: string, namespace = DEFAULT_PRIVATE_NAMESPACE): boolean {
  const cleaned = relPathOrTopic.replace(/^\/+|\/+$/g, '')
  return cleaned === namespace || cleaned.startsWith(namespace + '/')
}

/** Extract the topic prefix of a memory file path (everything before the filename). */
export function topicOfPath(relPath: string): string {
  const cleaned = relPath.replace(/^\/+|\/+$/g, '')
  const lastSlash = cleaned.lastIndexOf('/')
  return lastSlash <= 0 ? '' : cleaned.slice(0, lastSlash)
}

/**
 * Sanitize and validate a topic name.
 * Legal shapes:
 *   - Public topic: single segment (`infra`, `g7`, `preferences`, `video`)
 *   - Private topic: two segments under `namespace` (`private/health`, `private/quant`)
 * Rejects empty strings, `..`, leading slashes, bare `private` without subtopic,
 * or deeper nesting (> 2 segments).
 */
export function normalizeTopic(rawTopic: string, namespace = DEFAULT_PRIVATE_NAMESPACE): string {
  const trimmed = rawTopic.trim().replace(/^\/+|\/+$/g, '')
  if (trimmed === '' || trimmed.includes('\\')) {
    throw new Error(`invalid topic: ${JSON.stringify(rawTopic)}`)
  }
  const segments = trimmed.split('/')
  if (segments.some(seg => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`invalid topic path segments: ${JSON.stringify(rawTopic)}`)
  }
  const sanitizeSeg = (seg: string): string => {
    const clean = seg
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '')
    if (clean === '' || clean === '.' || clean === '..') {
      throw new Error(`invalid topic segment: ${JSON.stringify(seg)}`)
    }
    return clean.slice(0, 48)
  }
  if (segments.length === 1) {
    const seg = sanitizeSeg(segments[0]!)
    if (seg === namespace) {
      throw new Error(`private topic must include a subtopic, e.g. ${namespace}/health`)
    }
    return seg
  }
  if (segments.length === 2 && segments[0] === namespace) {
    return `${namespace}/${sanitizeSeg(segments[1]!)}`
  }
  throw new Error(`topic must be "<topic>" or "${namespace}/<subtopic>", got ${JSON.stringify(rawTopic)}`)
}

/** Unrestricted default trust context (used when privacy rules do not trigger). */
export const UNRESTRICTED_TRUST: TrustContext = { restricted: false }

/** Evaluate the trust boundary for a session, tool execution, or extraction run. */
export function evaluateTrust(params: {
  readonly cwd?: string
  readonly provider?: string
  readonly extraProviders?: readonly (string | undefined)[]
  readonly privacy: PrivacyConfig
}): TrustContext {
  const { cwd, provider, extraProviders = [], privacy } = params
  if (privacy.hidePrivate) {
    return { restricted: true, reason: 'hidePrivate' }
  }
  const providersToCheck = [provider, ...extraProviders]
    .map(p => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
  for (const p of providersToCheck) {
    if (privacy.restrictedProviders.includes(p)) {
      return { restricted: true, reason: 'provider' }
    }
  }
  if (cwd !== undefined && cwd !== '') {
    for (const pattern of privacy.restrictedPaths) {
      if (matchPathPattern(cwd, pattern)) {
        return { restricted: true, reason: 'path' }
      }
    }
    for (const rule of privacy.privatePaths) {
      if (matchPathPattern(cwd, rule.pattern)) {
        return { restricted: false, forcedPrivateTopic: rule.topic }
      }
    }
  }
  return UNRESTRICTED_TRUST
}
