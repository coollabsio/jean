import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('WorktreeItem structure', () => {
  const source = readFileSync(
    'src/components/projects/WorktreeItem.tsx',
    'utf8'
  )

  it('does not show the branch name beside the worktree name', () => {
    expect(source).not.toContain('GitBranch')
    expect(source).not.toContain('displayBranch')
  })
})
