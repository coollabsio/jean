import { describe, expect, it } from 'vitest'
import type { UnmanagedWorktree } from '@/types/projects'
import {
  comparableImportPath,
  existingWorktreeImportBlock,
  parseUnmanagedWorktreeListing,
} from './import-existing-worktree'

const feature: UnmanagedWorktree = {
  path: '/repo/.worktrees/feature',
  branch: 'feature',
  head: 'abcdef1234567890',
  headShort: 'abcdef1',
  prunable: false,
  locked: false,
  detached: false,
  bare: false,
}

describe('existing worktree import paths', () => {
  it('ignores trailing separators when comparing paths', () => {
    expect(comparableImportPath('/repo/main/')).toBe('/repo/main')
    expect(comparableImportPath('C:\\repo\\main\\')).toBe('C:\\repo\\main')
    expect(comparableImportPath('  /repo/main  ')).toBe('/repo/main')
  })

  it('names the project checkout and a different main checkout', () => {
    const blocked = [
      { path: '/repo/', kind: 'project' as const },
      { path: '/repo-main', kind: 'main' as const },
    ]

    expect(existingWorktreeImportBlock('/repo', blocked)).toBe(
      'Cannot import the project checkout: /repo'
    )
    expect(existingWorktreeImportBlock('/repo-main/', blocked)).toBe(
      "Cannot import the repository's main checkout: /repo-main/"
    )
    expect(existingWorktreeImportBlock('/repo/feature', blocked)).toBeNull()
  })

  it('accepts the listing object and a bare array', () => {
    expect(
      parseUnmanagedWorktreeListing({
        worktrees: [feature],
        blockedPaths: [{ path: '/repo', kind: 'project' }],
      })
    ).toEqual({
      worktrees: [feature],
      blockedPaths: [{ path: '/repo', kind: 'project' }],
    })

    expect(parseUnmanagedWorktreeListing([feature])).toEqual({
      worktrees: [feature],
      blockedPaths: [],
    })

    expect(() => parseUnmanagedWorktreeListing(null)).toThrow(
      'Failed to list unmanaged worktrees'
    )
  })
})
