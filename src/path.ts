/**
 * Path canonicalization and containment — the plugin's single path-safety
 * boundary. Every file access resolves through `containWithin`.
 * @module dsh-memory-lite/src/path
 */

import { realpath, mkdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** A memory path that is malformed or escapes its root; the model-facing rejection reason. */
export class MemoryPathError extends Error {
  override readonly name = 'MemoryPathError'
}

/** Resolve symlinks through the deepest existing ancestor, appending the rest lexically. */
export async function realpathSafe(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    const parent = dirname(path)
    if (parent === path) throw new MemoryPathError(`cannot resolve path ${JSON.stringify(path)}`)
    return join(await realpathSafe(parent), basename(path))
  }
}

/** Create a directory and its parents; existing directories pass through. */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

/**
 * Contain a relative candidate inside `root`: normalize, resolve symlinks in
 * the deepest existing ancestor, and require the result to stay inside the
 * canonical root. Absolute paths, `..` escapes, and symlink escapes all throw
 * {@link MemoryPathError}. This is the enforcement point — tool descriptions
 * alone never gate file access.
 * @param root - canonical containment root (must exist or be creatable).
 * @param candidate - relative path, as supplied by the model.
 * @returns the canonical absolute path inside `root`.
 */
export async function containWithin(root: string, candidate: string): Promise<string> {
  if (isAbsolute(candidate)) {
    throw new MemoryPathError(`memory path must be relative, got absolute ${JSON.stringify(candidate)}`)
  }
  if (candidate === '') throw new MemoryPathError('memory path must not be empty')
  if (candidate.endsWith('/')) throw new MemoryPathError('memory path must name a file, not a directory')
  const rootReal = await realpathSafe(root)
  const targetReal = await realpathSafe(resolve(rootReal, candidate))
  const rel = relative(rootReal, targetReal)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new MemoryPathError(`memory path escapes the memory root: ${JSON.stringify(candidate)}`)
  }
  return targetReal
}
