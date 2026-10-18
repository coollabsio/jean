import { describe, expect, it } from 'vitest'
import type { Project, Worktree } from '@/types/projects'
import { matchesProjectSearch, matchesWorktreeSearch } from './project-search'

const project = {
  id: 'project-1',
  name: 'Jean Desktop',
  path: '/code/jean',
  default_branch: 'main',
  added_at: 1,
  order: 0,
  serverName: 'Mac Studio',
} satisfies Project

const worktree = {
  id: 'worktree-1',
  project_id: 'project-1',
  name: 'calm-panda',
  path: '/worktrees/calm-panda',
  branch: 'feature/sidebar-search',
  base_branch: 'main',
  created_at: 1,
  order: 0,
  linear_issue_identifier: 'ENG-42',
} satisfies Worktree

describe('project sidebar search', () => {
  it('matches project names, paths, branches, and server names', () => {
    expect(matchesProjectSearch(project, 'desktop')).toBe(true)
    expect(matchesProjectSearch(project, '/CODE/JEAN')).toBe(true)
    expect(matchesProjectSearch(project, 'MAIN')).toBe(true)
    expect(matchesProjectSearch(project, 'studio')).toBe(true)
    expect(matchesProjectSearch(project, 'missing')).toBe(false)
  })

  it('matches worktree names, paths, branches, and issue identifiers', () => {
    expect(matchesWorktreeSearch(worktree, 'panda')).toBe(true)
    expect(matchesWorktreeSearch(worktree, 'WORKTREES')).toBe(true)
    expect(matchesWorktreeSearch(worktree, 'sidebar-search')).toBe(true)
    expect(matchesWorktreeSearch(worktree, 'eng-42')).toBe(true)
    expect(matchesWorktreeSearch(worktree, 'missing')).toBe(false)
  })
})
