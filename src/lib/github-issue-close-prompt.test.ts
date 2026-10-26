import { describe, expect, it } from 'vitest'
import { buildCommentAndCloseIssuePrompt } from './github-issue-close-prompt'

describe('buildCommentAndCloseIssuePrompt', () => {
  it('names only the effective issue targets with their repositories', () => {
    const prompt = buildCommentAndCloseIssuePrompt([
      {
        number: 42,
        title: 'Fix login',
        commentCount: 0,
        repoOwner: 'owner',
        repoName: 'repo',
      },
    ])

    expect(prompt).toContain('owner/repo#42')
    expect(prompt).toContain('brief comment')
    expect(prompt).toContain('do not look up the latest commit')
    expect(prompt).toContain('close only these issues')
  })
})
