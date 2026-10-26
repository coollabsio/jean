import { describe, expect, it } from 'vitest'
import {
  distinctGitHubRepos,
  filterWorktreeBranches,
  isSameGitHubCreateTarget,
  primaryGitHubRemote,
  reusesPrimaryGitHubSource,
  worktreeBaseBranchOption,
  worktreeBranchCheckoutRef,
  worktreeBranchRemoteCount,
  type RemoteBranch,
} from './remote-worktree-sources'

const originMain: RemoteBranch = {
  remote: 'origin',
  name: 'main',
  qualified: 'origin/main',
}
const upstreamMain: RemoteBranch = {
  remote: 'upstream',
  name: 'main',
  qualified: 'upstream/main',
}
const originFeature: RemoteBranch = {
  remote: 'origin',
  name: 'feature/login',
  qualified: 'origin/feature/login',
}
const upstreamFeature: RemoteBranch = {
  remote: 'upstream',
  name: 'feature/login',
  qualified: 'upstream/feature/login',
}

describe('worktree branch sources', () => {
  const branches = [originMain, upstreamMain, originFeature, upstreamFeature]

  it('keeps the same branch name distinct and checks out the qualified ref', () => {
    expect(worktreeBranchRemoteCount(branches)).toBe(2)
    const visible = filterWorktreeBranches(branches, 'main', '')
    expect(visible.map(branch => branch.qualified)).toEqual([
      'upstream/main',
      'origin/feature/login',
      'upstream/feature/login',
    ])
    expect(visible.map(branch => worktreeBranchCheckoutRef(branch, 2))).toEqual([
      'upstream/main',
      'origin/feature/login',
      'upstream/feature/login',
    ])
  })

  it('uses the short name when the project has one remote', () => {
    const onlyOrigin = [originMain, originFeature]
    expect(worktreeBranchRemoteCount(onlyOrigin)).toBe(1)
    expect(
      filterWorktreeBranches(onlyOrigin, 'main', 'login').map(branch =>
        worktreeBranchCheckoutRef(branch, 1)
      )
    ).toEqual(['feature/login'])
  })

  it('searches the remote and the branch name', () => {
    expect(
      filterWorktreeBranches(branches, undefined, 'upstream').map(
        branch => branch.qualified
      )
    ).toEqual(['upstream/main', 'upstream/feature/login'])
  })
})

describe('github source identity', () => {
  it('treats only the primary remote as the existing worktree source', () => {
    const originItem = { remote: 'origin', repo: 'coollabsio/jean' }
    const forkItem = { remote: 'fork', repo: 'octocat/jean' }
    const items = [originItem, forkItem]
    const primary = primaryGitHubRemote(items)
    expect(primary).toBe('origin')
    expect(distinctGitHubRepos(items)).toEqual([
      'coollabsio/jean',
      'octocat/jean',
    ])
    expect(reusesPrimaryGitHubSource(originItem, true, primary)).toBe(true)
    expect(reusesPrimaryGitHubSource(forkItem, true, primary)).toBe(false)
    expect(reusesPrimaryGitHubSource(forkItem, false, primary)).toBe(true)
    expect(
      isSameGitHubCreateTarget(
        { number: 12, repo: 'octocat/jean' },
        12,
        'octocat/jean'
      )
    ).toBe(true)
    expect(
      isSameGitHubCreateTarget(
        { number: 12, repo: 'coollabsio/jean' },
        12,
        'octocat/jean'
      )
    ).toBe(false)
    expect(worktreeBaseBranchOption(originFeature)).toBe('feature/login')
    expect(worktreeBaseBranchOption(upstreamFeature)).toBe(
      'upstream/feature/login'
    )
  })
})
