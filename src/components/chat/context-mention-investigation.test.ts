import { describe, expect, it } from 'vitest'
import { buildInvestigatePrompt } from './context-mention-investigation'
import type { ContextMentionItem } from './hooks/useContextMentionData'
import type { GitHubIssue, GitHubPullRequest } from '@/types/github'

const issue = (number: number): ContextMentionItem => ({
  id: `issue:${number}`,
  type: 'issue',
  label: `#${number}`,
  title: `Issue ${number}`,
  issue: { number } as GitHubIssue,
})
const pr = (number: number): ContextMentionItem => ({
  id: `pr:${number}`,
  type: 'pr',
  label: `PR #${number}`,
  title: `PR ${number}`,
  pr: { number } as GitHubPullRequest,
})

describe('buildInvestigatePrompt', () => {
  it('lists all issues and PRs with plural words', () => {
    expect(
      buildInvestigatePrompt(
        [issue(1), pr(5), issue(2)],
        'Look at {issueWord} {issueRefs}',
        'Review {prWord} {prRefs}'
      )
    ).toBe('Look at issues #1, #2\n\nReview PR #5')
  })

  it('uses only the issue prompt when no PR is selected', () => {
    expect(
      buildInvestigatePrompt([issue(3)], 'Look at {issueWord} {issueRefs}', '')
    ).toBe('Look at issue #3')
  })
})
