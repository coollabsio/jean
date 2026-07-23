import { describe, expect, it } from 'vitest'
import type { Worktree } from '@/types/projects'
import {
  CANVAS_FILTER_TABS,
  getCanvasFilterTabCount,
  matchesCanvasFilterTab,
  shouldShowCanvasWorktreeSection,
} from './canvas-worktree-filters'

function worktree(overrides: Partial<Worktree>): Worktree {
  return {
    id: overrides.id ?? 'wt-1',
    project_id: 'project-1',
    name: overrides.name ?? 'worktree',
    path: `/tmp/${overrides.name ?? 'worktree'}`,
    branch: overrides.branch ?? 'branch',
    created_at: 1,
    session_type: 'worktree',
    order: 0,
    ...overrides,
  }
}

describe('canvas worktree filters', () => {
  it('marks the Mr. Robot tab as configurable from project settings', () => {
    const mrRobotTab = CANVAS_FILTER_TABS.find(tab => tab.value === 'auto_fix')

    expect(mrRobotTab?.settingsPane).toBe('auto-fix')
    expect(mrRobotTab?.settingsPlacement).toBe('inside')
    expect(mrRobotTab?.badge).toBe('Beta')
  })

  it('hides auto-fix issue worktrees from All and Issues', () => {
    const autoFixIssue = worktree({
      id: 'auto-fix-issue',
      issue_number: 123,
      origin: 'auto_fix',
    })

    expect(matchesCanvasFilterTab(autoFixIssue, 'all')).toBe(false)
    expect(matchesCanvasFilterTab(autoFixIssue, 'issues')).toBe(false)
    expect(matchesCanvasFilterTab(autoFixIssue, 'auto_fix')).toBe(true)
  })

  it('counts auto-fix worktrees separately from All', () => {
    const worktrees = [
      worktree({ id: 'manual' }),
      worktree({ id: 'issue', issue_number: 123 }),
      worktree({ id: 'auto', issue_number: 456, origin: 'auto_fix' }),
    ]

    expect(getCanvasFilterTabCount(worktrees, 'all')).toBe(2)
    expect(getCanvasFilterTabCount(worktrees, 'issues')).toBe(1)
    expect(getCanvasFilterTabCount(worktrees, 'auto_fix')).toBe(1)
  })

  it('shows the base branch even when it has no sessions', () => {
    const base = worktree({
      id: 'base',
      name: 'main',
      branch: 'main',
      session_type: 'base',
    })
    const regular = worktree({ id: 'regular' })

    expect(shouldShowCanvasWorktreeSection(base, 0)).toBe(true)
    expect(shouldShowCanvasWorktreeSection(regular, 0)).toBe(false)
  })
})
