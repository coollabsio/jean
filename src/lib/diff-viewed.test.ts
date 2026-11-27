import { describe, expect, it } from 'vitest'
import type { FileDiffMetadata } from '@pierre/diffs'
import {
  applyViewedToggle,
  computeViewedPaths,
  hashFileDiff,
  type DiffViewedFiles,
} from './diff-viewed'

function fileDiff(overrides: Partial<FileDiffMetadata> = {}): FileDiffMetadata {
  return {
    name: 'src/a.ts',
    type: 'change',
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: ['old line\n'],
    additionLines: ['new line\n'],
    ...overrides,
  } as FileDiffMetadata
}

describe('hashFileDiff', () => {
  it('is stable for equal content and changes when the patch changes', () => {
    expect(hashFileDiff(fileDiff())).toBe(hashFileDiff(fileDiff()))
    expect(hashFileDiff(fileDiff())).not.toBe(
      hashFileDiff(fileDiff({ additionLines: ['new line!\n'] }))
    )
    expect(hashFileDiff(fileDiff())).not.toBe(
      hashFileDiff(fileDiff({ type: 'new' }))
    )
  })

  it('separates deletions from additions', () => {
    expect(
      hashFileDiff(fileDiff({ deletionLines: ['x'], additionLines: [] }))
    ).not.toBe(
      hashFileDiff(fileDiff({ deletionLines: [], additionLines: ['x'] }))
    )
  })
})

describe('computeViewedPaths', () => {
  const files = [
    { path: 'a.ts', hash: 'h-a' },
    { path: 'b.ts', hash: 'h-b' },
    { path: 'c.ts', hash: 'h-c' },
  ]
  const data: DiffViewedFiles = {
    local: { 'a.ts': 'h-a', 'b.ts': 'stale' },
    github: [
      { path: 'c.ts', state: 'VIEWED' },
      { path: 'b.ts', state: 'DISMISSED' },
    ],
  }

  it('uses matching local hashes and GitHub VIEWED on branch diffs', () => {
    expect([...computeViewedPaths(files, data, 'branch')]).toEqual([
      'a.ts',
      'c.ts',
    ])
  })

  it('ignores GitHub state on uncommitted diffs', () => {
    expect([...computeViewedPaths(files, data, 'uncommitted')]).toEqual([
      'a.ts',
    ])
  })

  it('is empty before data loads', () => {
    expect(computeViewedPaths(files, undefined, 'branch').size).toBe(0)
  })
})

describe('applyViewedToggle', () => {
  it('unchecking clears both the local mark and GitHub VIEWED', () => {
    const data: DiffViewedFiles = {
      local: { 'c.ts': 'h-c' },
      github: [{ path: 'c.ts', state: 'VIEWED' }],
    }
    const next = applyViewedToggle(data, 'c.ts', 'h-c', false)
    expect(next).toEqual({
      local: {},
      github: [{ path: 'c.ts', state: 'UNVIEWED' }],
    })
    expect(
      computeViewedPaths([{ path: 'c.ts', hash: 'h-c' }], next, 'branch').size
    ).toBe(0)
  })

  it('checking stores the current hash', () => {
    expect(applyViewedToggle(undefined, 'a.ts', 'h-a', true)).toEqual({
      local: { 'a.ts': 'h-a' },
      github: null,
    })
  })
})
