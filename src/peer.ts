/**
 * Peer derivation: which memory root a session reads and writes.
 * @module dsh-memory-lite/src/peer
 */

import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type { ResolvedConfig } from './config.js'

/** The peer a session belongs to, derived from its cwd when enabled. */
export function peerForHeader(header: SessionHeader | undefined, config: ResolvedConfig): string {
  if (!config.workspacePeers.enabled) return config.defaultPeer
  const cwd = header?.cwd
  if (cwd === undefined || cwd === '') {
    const fallback = config.workspacePeers.cwdFallback
    return fallback === '' || fallback === 'default_peer' ? config.defaultPeer : fallback
  }
  return peerFromCwd(cwd)
}

/**
 * Deterministic peer name from a working directory: sanitized basename plus a
 * short hash of the full path, so distinct directories sharing a basename do
 * not silently share a memory root.
 */
export function peerFromCwd(cwd: string): string {
  const base = basename(cwd) || 'workspace'
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  const name = slug === '' ? 'workspace' : slug
  const hash = createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  return `${name}-${hash}`
}

/**
 * Human-readable display name for a working directory: the directory's own
 * basename, unmodified (CJK and other non-ASCII spellings survive verbatim).
 * Peer *directory names* stay ASCII (see peerFromCwd); this value only feeds
 * UI annotations and is never used as a path segment.
 */
export function displayNameFromCwd(cwd: string): string {
  return basename(cwd) || 'workspace'
}

/** Sanitize a configured peer name for use as one directory segment. */
export function sanitizePeerName(name: string): string {
  const slug = name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug === '' || slug === '.' || slug === '..') {
    throw new Error(`dsh-memory-lite: invalid peer name ${JSON.stringify(name)}`)
  }
  return slug
}
