import { describe, expect, it } from 'vitest'
import {
  branchWebUrl,
  buildCloneUrl,
  stripProviderHost,
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

  it('accepts a pasted GitHub URL with a trailing slash', () => {
    expect(
      buildCloneUrl('github', 'https://github.com/coollabsio/openclaw/')
    ).toBe('https://github.com/coollabsio/openclaw')
  })

  it('keeps custom git URLs unchanged', () => {
    const url = 'ssh://git@example.com/team/project.git'
    expect(buildCloneUrl('custom', url)).toBe(url)
  })
})

describe('stripProviderHost', () => {
  it.each([
    'https://github.com/coollabsio/openclaw/',
    'http://www.github.com/coollabsio/openclaw/',
    'github.com/coollabsio/openclaw/',
    'git@github.com:coollabsio/openclaw/',
    'ssh://git@github.com/coollabsio/openclaw/',
  ])('removes the GitHub host from %s', value => {
    expect(stripProviderHost('github', value)).toBe('coollabsio/openclaw/')
  })

  it('removes the GitLab host only for GitLab', () => {
    const url = 'https://gitlab.com/group/sub/project'
    expect(stripProviderHost('gitlab', url)).toBe('group/sub/project')
    expect(stripProviderHost('github', url)).toBe(url)
    expect(stripProviderHost('custom', url)).toBe(url)
  })

  it('keeps an owner/repo value unchanged', () => {
    expect(stripProviderHost('github', 'coollabsio/')).toBe('coollabsio/')
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
