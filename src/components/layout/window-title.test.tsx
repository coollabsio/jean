import { describe, expect, it } from 'vitest'
import { resolveWindowTitle } from './window-title'

describe('resolveWindowTitle', () => {
  const project = {
    projectName: 'Jean App',
    worktreeName: 'feature',
    worktreeBranch: 'feature/title',
    isMobile: false,
  }

  it('uses the project on mobile and project › worktree on desktop', () => {
    expect(resolveWindowTitle({ ...project, isMobile: true })).toBe('Jean App')
    expect(resolveWindowTitle(project)).toBe(
      'Jean App › feature (feature/title)'
    )
    expect(
      resolveWindowTitle({
        ...project,
        worktreeBranch: 'feature',
      })
    ).toBe('Jean App › feature')
    expect(resolveWindowTitle({ isMobile: false })).toBe('Jean')
  })
})
