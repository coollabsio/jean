import { describe, expect, it } from 'vitest'
import {
  buildInvestigatePrompt,
  planInvestigationBatches,
} from './context-mention-investigation'
import type { ContextMentionItem } from './hooks/useContextMentionData'
import type {
  DependabotAlert,
  GitHubIssue,
  GitHubPullRequest,
  RepositoryAdvisory,
} from '@/types/github'

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
const alert = (number: number): ContextMentionItem => ({
  id: `security:${number}`,
  type: 'security',
  label: `Security #${number}`,
  title: `Alert ${number}`,
  securityAlert: {
    number,
    packageName: 'lodash',
    severity: 'high',
  } as DependabotAlert,
})
const advisory = (ghsaId: string): ContextMentionItem => ({
  id: `advisory:${ghsaId}`,
  type: 'advisory',
  label: ghsaId,
  title: `Advisory ${ghsaId}`,
  advisory: { ghsaId, severity: 'critical' } as RepositoryAdvisory,
})

describe('buildInvestigatePrompt', () => {
  it('lists all issues and PRs with plural words', () => {
    expect(
      buildInvestigatePrompt([issue(1), pr(5), issue(2)], {
        issue: 'Look at {issueWord} {issueRefs}',
        pr: 'Review {prWord} {prRefs}',
      })
    ).toBe('Look at issues #1, #2\n\nReview PR #5')
  })

  it('uses only the issue prompt when no PR is selected', () => {
    expect(
      buildInvestigatePrompt([issue(3)], {
        issue: 'Look at {issueWord} {issueRefs}',
        pr: '',
      })
    ).toBe('Look at issue #3')
  })

  it('lists security alerts and advisories with their own prompts', () => {
    expect(
      buildInvestigatePrompt(
        [advisory('GHSA-aaaa'), alert(4), advisory('GHSA-bbbb')],
        {
          securityAlert: 'Check {alertWord} {alertRefs}',
          advisory: 'Fix {advisoryWord} {advisoryRefs}',
        }
      )
    ).toBe(
      'Check alert #4 lodash (high)\n\nFix advisories GHSA-aaaa (critical), GHSA-bbbb (critical)'
    )
  })

  it('falls back to the default advisory prompt for a blank template', () => {
    expect(
      buildInvestigatePrompt([advisory('GHSA-cccc')], { advisory: '  ' })
    ).toContain(
      'Investigate the loaded security advisory (GHSA-cccc (critical))'
    )
  })
})

describe('planInvestigationBatches', () => {
  it('gives each PR its own worktree and shares one session for the rest', () => {
    const items = [issue(1), pr(5), alert(2), pr(6)]
    expect(planInvestigationBatches(items, false)).toEqual([
      { kind: 'session', items: [issue(1), alert(2)] },
      { kind: 'pr-worktree', pr: items[1]?.pr },
      { kind: 'pr-worktree', pr: items[3]?.pr },
    ])
  })

  it('starts one session per non-PR item when separate', () => {
    const items = [issue(1), advisory('GHSA-1'), pr(5)]
    expect(planInvestigationBatches(items, true)).toEqual([
      { kind: 'session', items: [issue(1)] },
      { kind: 'session', items: [advisory('GHSA-1')] },
      { kind: 'pr-worktree', pr: items[2]?.pr },
    ])
  })

  it('starts no session when only PRs are selected', () => {
    expect(planInvestigationBatches([pr(5)], false)).toEqual([
      { kind: 'pr-worktree', pr: pr(5).pr },
    ])
  })

  it('runs only the first session batch in the empty session', () => {
    const items = [issue(1), issue(2), pr(5)]
    expect(planInvestigationBatches(items, true, 'empty')).toEqual([
      { kind: 'session', items: [issue(1)], reuseSessionId: 'empty' },
      { kind: 'session', items: [issue(2)] },
      { kind: 'pr-worktree', pr: items[2]?.pr },
    ])
  })

  it('does not reuse the empty session for PR worktrees', () => {
    expect(planInvestigationBatches([pr(5), pr(6)], false, 'empty')).toEqual([
      { kind: 'pr-worktree', pr: pr(5).pr },
      { kind: 'pr-worktree', pr: pr(6).pr },
    ])
  })
})
