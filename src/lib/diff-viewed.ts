import type { FileDiffMetadata } from '@pierre/diffs'

export type ViewedDiffType = 'uncommitted' | 'branch'

/** GitHub `FileViewedState` for one PR file. */
export interface GithubFileViewedState {
  path: string
  state: 'VIEWED' | 'UNVIEWED' | 'DISMISSED'
}

export interface DiffViewedFiles {
  /** path -> patch hash at the time the file was marked viewed */
  local: Record<string, string>
  github: GithubFileViewedState[] | null
}

/** cyrb53: a fast, stable 53-bit string hash. */
function hashString(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

/** Hash of a file's change content; any edit to the patch yields a new hash. */
export function hashFileDiff(fileDiff: FileDiffMetadata): string {
  return hashString(
    [
      fileDiff.type,
      fileDiff.prevName ?? '',
      fileDiff.newObjectId ?? '',
      fileDiff.deletionLines.join(''),
      '\u0000',
      fileDiff.additionLines.join(''),
    ].join('\u0001')
  )
}

/**
 * A file is viewed when its local mark matches the current patch, or (branch
 * diffs only) GitHub reports it VIEWED.
 */
export function computeViewedPaths(
  files: readonly { path: string; hash: string }[],
  data: DiffViewedFiles | undefined,
  diffType: ViewedDiffType
): Set<string> {
  const viewed = new Set<string>()
  if (!data) return viewed
  const githubViewed = new Set(
    diffType === 'branch'
      ? (data.github ?? [])
          .filter(file => file.state === 'VIEWED')
          .map(file => file.path)
      : []
  )
  for (const { path, hash } of files) {
    if (data.local[path] === hash || githubViewed.has(path)) viewed.add(path)
  }
  return viewed
}

/** Optimistic cache update for a toggle. Unchecking clears both sources. */
export function applyViewedToggle(
  data: DiffViewedFiles | undefined,
  path: string,
  hash: string,
  viewed: boolean
): DiffViewedFiles {
  const { [path]: _previous, ...rest } = data?.local ?? {}
  const local = viewed ? { ...rest, [path]: hash } : rest
  const github =
    data?.github?.map(file =>
      file.path === path
        ? {
            ...file,
            state: viewed ? ('VIEWED' as const) : ('UNVIEWED' as const),
          }
        : file
    ) ?? null
  return { local, github }
}
