import { describe, expect, it } from 'vitest'
import { skillQueryKeys } from './skills'

describe('skillQueryKeys', () => {
  it('defines skill cache keys for every Jean AI backend with skills', () => {
    expect(skillQueryKeys.codexSkills('worktree-1', '/repo')).toEqual([
      'cli-skills',
      'codex',
      'skills',
      '/repo',
      'worktree-1',
    ])
    expect(skillQueryKeys.opencodeSkills()).toEqual([
      'cli-skills',
      'opencode',
      'skills',
    ])
    expect(skillQueryKeys.cursorSkills()).toEqual([
      'cli-skills',
      'cursor',
      'skills',
    ])
  })
})
