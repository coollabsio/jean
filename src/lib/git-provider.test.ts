import { describe, expect, it } from 'vitest'
import { buildCloneUrl } from './git-provider'

describe('buildCloneUrl', () => {
  it('adds the GitHub host to a repository path', () => {
    expect(buildCloneUrl('github', 'coollabsio/coolify')).toBe(
      'https://github.com/coollabsio/coolify'
    )
  })

  it('adds the GitLab host to a repository path', () => {
    expect(buildCloneUrl('gitlab', 'group/subgroup/project.git')).toBe(
      'https://gitlab.com/group/subgroup/project.git'
    )
  })

  it('keeps custom git URLs unchanged', () => {
    const url = 'ssh://git@example.com/team/project.git'
    expect(buildCloneUrl('custom', url)).toBe(url)
  })
})
