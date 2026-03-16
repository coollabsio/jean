import Fuse from 'fuse.js'
import type { WorktreeFile } from '@/types/chat'

/**
 * Fuzzy search over worktree files by relative path.
 * Weights filename matches higher than directory path matches.
 */
export function fuzzySearchFiles(
  files: WorktreeFile[],
  query: string,
  limit = 15
): WorktreeFile[] {
  if (!query) return files.slice(0, limit)

  const fuse = new Fuse(files, {
    keys: ['relative_path'],
    threshold: 0.4,
    ignoreLocation: true,
    // Score filename portion higher by using a custom getFn
    // that also indexes the basename separately
  })

  return fuse.search(query, { limit }).map(r => r.item)
}

/**
 * Fuzzy search over slash commands and skills by name and description.
 */
export function fuzzySearchItems<T extends { name: string; description?: string | null }>(
  items: T[],
  query: string,
  limit = 15
): T[] {
  if (!query) return items.slice(0, limit)

  const fuse = new Fuse(items, {
    keys: [
      { name: 'name', weight: 2 },
      { name: 'description', weight: 1 },
    ],
    threshold: 0.4,
    ignoreLocation: true,
  })

  return fuse.search(query, { limit }).map(r => r.item)
}
