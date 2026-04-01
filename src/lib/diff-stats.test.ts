import { describe, it, expect } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import type { DiffFile } from '@/types/git-diff'
import {
  findBackendFileStats,
  getFileLineStats,
  getHunkLineStats,
} from './diff-stats'

function createFileDiff(
  overrides: Partial<FileDiffMetadata> = {}
): FileDiffMetadata {
  return {
    name: 'src/example.ts',
    prevName: undefined,
    type: 'change',
    hunks: [
      {
        collapsedBefore: 0,
        splitLineStart: 0,
        splitLineCount: 3,
        unifiedLineStart: 0,
        unifiedLineCount: 4,
        additionCount: 7,
        additionStart: 10,
        additionLines: 1,
        deletionCount: 7,
        deletionStart: 10,
        deletionLines: 1,
        hunkContent: [
          {
            type: 'context',
            lines: ['const before = true'],
            noEOFCR: false,
          },
          {
            type: 'change',
            deletions: ["name: 'Web Access (Experimental)'"],
            additions: ["name: 'Web Access'"],
            noEOFCRDeletions: false,
            noEOFCRAdditions: false,
          },
          {
            type: 'context',
            lines: ['icon: Globe'],
            noEOFCR: false,
          },
        ],
        hunkContext: undefined,
        hunkSpecs: '@@ -10,7 +10,7 @@',
      },
      {
        collapsedBefore: 0,
        splitLineStart: 0,
        splitLineCount: 3,
        unifiedLineStart: 0,
        unifiedLineCount: 4,
        additionCount: 7,
        additionStart: 20,
        additionLines: 1,
        deletionCount: 7,
        deletionStart: 20,
        deletionLines: 1,
        hunkContent: [
          {
            type: 'context',
            lines: ['switch (pane) {'],
            noEOFCR: false,
          },
          {
            type: 'change',
            deletions: ["return 'Web Access (Experimental)'"],
            additions: ["return 'Web Access'"],
            noEOFCRDeletions: false,
            noEOFCRAdditions: false,
          },
          {
            type: 'context',
            lines: ['default:'],
            noEOFCR: false,
          },
        ],
        hunkContext: undefined,
        hunkSpecs: '@@ -20,7 +20,7 @@',
      },
    ],
    splitLineCount: 6,
    unifiedLineCount: 8,
    ...overrides,
  }
}

describe('getHunkLineStats', () => {
  it('counts actual changed lines, not hunk span sizes', () => {
    const fileDiff = createFileDiff()

    expect(getHunkLineStats(fileDiff.hunks)).toEqual({
      additions: 2,
      deletions: 2,
    })
  })
})

describe('findBackendFileStats', () => {
  it('matches renamed files by current or previous path', () => {
    const backendFiles: DiffFile[] = [
      {
        path: 'src/new-name.ts',
        old_path: 'src/old-name.ts',
        status: 'renamed',
        additions: 3,
        deletions: 1,
        is_binary: false,
        hunks: [],
      },
    ]

    expect(
      findBackendFileStats(
        createFileDiff({
          name: 'src/new-name.ts',
          prevName: 'src/old-name.ts',
        }),
        backendFiles
      )
    ).toEqual({
      additions: 3,
      deletions: 1,
    })
  })
})

describe('getFileLineStats', () => {
  it('prefers backend stats when available', () => {
    const backendFiles: DiffFile[] = [
      {
        path: 'src/example.ts',
        old_path: null,
        status: 'modified',
        additions: 9,
        deletions: 4,
        is_binary: false,
        hunks: [],
      },
    ]

    expect(getFileLineStats(createFileDiff(), backendFiles)).toEqual({
      additions: 9,
      deletions: 4,
    })
  })

  it('falls back to parsed hunk content when backend stats are missing', () => {
    expect(getFileLineStats(createFileDiff())).toEqual({
      additions: 2,
      deletions: 2,
    })
  })
})
