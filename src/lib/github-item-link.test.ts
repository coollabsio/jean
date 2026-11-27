import { describe, expect, it } from 'vitest'
import { githubLinkRepoArg, parseGitHubItemUrl } from './github-item-link'

describe('parseGitHubItemUrl', () => {
  it.each([
    ['https://github.com/acme/app/pull/12', 'pr', 12],
    ['https://github.com/acme/app/pull/12/files#diff-1', 'pr', 12],
    ['https://www.github.com/acme/app/issues/7?x=1', 'issue', 7],
  ])('parses %s', (url, kind, number) => {
    expect(parseGitHubItemUrl(url)).toEqual({ repo: 'acme/app', kind, number })
  })

  it.each([
    'https://github.com/acme/app',
    'https://github.com/acme/app/issues',
    'https://github.com/acme/app/issues/7x',
    'https://gitlab.com/acme/app/issues/7',
    'https://github.com.evil.io/acme/app/pull/1',
    'not a url',
  ])('rejects %s', url => {
    expect(parseGitHubItemUrl(url)).toBeNull()
  })
})

describe('githubLinkRepoArg', () => {
  const link = (repo: string) => ({ repo, kind: 'pr' as const, number: 1 })
  const remotes = [
    { name: 'fork', url: 'https://github.com/me/app.git' },
    { name: 'origin', url: 'https://github.com/Acme/App' },
  ]

  it('omits repo for the primary (origin) remote, case-insensitively', () => {
    expect(githubLinkRepoArg(link('acme/app'), remotes)).toBeUndefined()
  })

  it('passes the repo of another remote', () => {
    expect(githubLinkRepoArg(link('me/app'), remotes)).toBe('me/app')
  })

  it('returns null when no remote matches', () => {
    expect(githubLinkRepoArg(link('other/lib'), remotes)).toBeNull()
  })
})
