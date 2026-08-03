import type { FileDiffMetadata } from '@pierre/diffs'
import type { DiffFile } from '@/types/git-diff'

export interface DiffLineStats {
  additions: number
  deletions: number
}

export function getHunkLineStats(
  hunks: FileDiffMetadata['hunks']
): DiffLineStats {
  return hunks.reduce<DiffLineStats>(
    (stats, hunk) => {
      stats.additions += hunk.additionLines
      stats.deletions += hunk.deletionLines
      return stats
    },
    { additions: 0, deletions: 0 }
  )
}

export function findBackendFileStats(
  fileDiff: Pick<FileDiffMetadata, 'name' | 'prevName'>,
  backendFiles?: DiffFile[]
): DiffLineStats | null {
  if (!backendFiles?.length) return null

  const candidates = [fileDiff.name, fileDiff.prevName].filter(
    (value): value is string => Boolean(value && value !== 'unknown')
  )

  if (candidates.length === 0) return null

  const candidateSet = new Set(candidates)
  const match = backendFiles.find(file => {
    if (candidateSet.has(file.path)) return true
    return Boolean(file.old_path && candidateSet.has(file.old_path))
  })

  if (!match) return null

  return {
    additions: match.additions,
    deletions: match.deletions,
  }
}

export function getFileLineStats(
  fileDiff: Pick<FileDiffMetadata, 'name' | 'prevName' | 'hunks'>,
  backendFiles?: DiffFile[]
): DiffLineStats {
  return (
    findBackendFileStats(fileDiff, backendFiles) ??
    getHunkLineStats(fileDiff.hunks)
  )
}
