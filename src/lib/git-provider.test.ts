import { describe, expect, it } from 'vitest'
import {
  branchWebUrl,
  buildCloneUrl,
  hostedRepoWebUrl,
  issueWebUrl,
  pullRequestWebUrl,
} from './git-provider'

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

describe('forge web urls', () => {
  it('keeps GitHub issue, pull, and branch paths', () => {
    const repo = hostedRepoWebUrl('github.com', 'owner', 'repo')
    expect(repo).toBe('https://github.com/owner/repo')
    expect(issueWebUrl(repo, 12, 'github')).toBe(
      'https://github.com/owner/repo/issues/12'
    )
    expect(pullRequestWebUrl(repo, 12, 'github')).toBe(
      'https://github.com/owner/repo/pull/12'
    )
    expect(branchWebUrl(repo, 'feature/one', 'github')).toBe(
      'https://github.com/owner/repo/tree/feature/one'
    )
  })

  it('uses GitLab paths for nested groups and self-hosted hosts', () => {
    const repo = hostedRepoWebUrl('gitlab.com', 'group/sub', 'repo')
    expect(issueWebUrl(repo, 7, 'gitlab')).toBe(
      'https://gitlab.com/group/sub/repo/-/issues/7'
    )
    expect(pullRequestWebUrl(repo, 7, 'gitlab')).toBe(
      'https://gitlab.com/group/sub/repo/-/merge_requests/7'
    )
    expect(branchWebUrl(repo, 'feature/one', 'gitlab')).toBe(
      'https://gitlab.com/group/sub/repo/-/tree/feature/one'
    )
    expect(
      branchWebUrl('https://git.company.com/team/app', 'main', 'gitlab')
    ).toBe('https://git.company.com/team/app/-/tree/main')
  })
})
