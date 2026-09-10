import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import {
  BranchItem,
  IssueItem,
  PRItem,
  SecurityAlertItem,
} from './NewWorktreeItems'
import type {
  DependabotAlert,
  GitHubIssue,
  GitHubPullRequest,
} from '@/types/github'

let isMobile = false

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

const alert: DependabotAlert = {
  number: 12,
  state: 'open',
  packageName: 'lodash',
  packageEcosystem: 'npm',
  manifestPath: 'package.json',
  ghsaId: 'GHSA-test-1234',
  severity: 'critical',
  summary: 'Prototype pollution',
  description: 'A test advisory',
  createdAt: '2026-01-01T00:00:00Z',
  htmlUrl: 'https://github.com/example/repo/security/dependabot/12',
}

function renderSecurityAlertItem(overrides = {}) {
  return render(
    <SecurityAlertItem
      alert={alert}
      index={0}
      isSelected={false}
      isCreating={false}
      onMouseEnter={vi.fn()}
      onClick={vi.fn()}
      onInvestigate={vi.fn()}
      onPreview={vi.fn()}
      {...overrides}
    />
  )
}

beforeEach(() => {
  isMobile = false
})

describe('compact issue and PR rows', () => {
  it('shows the new-session investigation action on desktop', async () => {
    const user = userEvent.setup()
    const onInvestigateInNewSession = vi.fn()
    render(
      <IssueItem
        issue={{
          number: 42,
          title: 'A detailed issue title',
          state: 'OPEN',
          labels: [],
          created_at: '2026-01-01T00:00:00Z',
          author: { login: 'octocat' },
        }}
        index={0}
        isSelected={false}
        isCreating={false}
        onMouseEnter={vi.fn()}
        onClick={vi.fn()}
        onInvestigate={vi.fn()}
        onInvestigateInNewSession={onInvestigateInNewSession}
        onPreview={vi.fn()}
      />
    )
    await user.click(
      screen.getByRole('button', { name: /investigate issue in new session/i })
    )
    expect(onInvestigateInNewSession).toHaveBeenCalledTimes(1)
  })

  it('hides labels and uses compact issue text', () => {
    render(
      <IssueItem
        issue={{
          number: 42,
          title: 'A detailed issue title',
          state: 'OPEN',
          labels: [{ name: 'Triage', color: 'ffff00' }],
          created_at: '2026-01-01T00:00:00Z',
          author: { login: 'octocat' },
        }}
        index={0}
        isSelected={false}
        isCreating={false}
        onMouseEnter={vi.fn()}
        onClick={vi.fn()}
        onInvestigate={vi.fn()}
        onPreview={vi.fn()}
      />
    )
    expect(screen.queryByText('Triage')).toBeNull()
    expect(screen.getByText('A detailed issue title')).toHaveClass(
      'text-[11px]'
    )
  })

  it('hides labels and branch names and uses compact PR text', () => {
    const pr = {
      number: 711,
      title: 'feat(web): sign-in screen',
      state: 'OPEN',
      labels: [{ name: 'Feature', color: 'a855f7' }],
      headRefName: 'feat/web-auth-screen',
      baseRefName: 'main',
      isDraft: false,
    } as GitHubPullRequest
    render(
      <PRItem
        pr={pr}
        index={0}
        isSelected={false}
        isCreating={false}
        isStacking={false}
        onMouseEnter={vi.fn()}
        onClick={vi.fn()}
        onInvestigate={vi.fn()}
        onStack={vi.fn()}
        onPreview={vi.fn()}
      />
    )
    expect(screen.queryByText('Feature')).toBeNull()
    expect(screen.queryByText(/feat\/web-auth-screen/)).toBeNull()
    expect(screen.getByText('feat(web): sign-in screen')).toHaveClass(
      'text-[11px]'
    )
  })
})

describe('NewWorktreeItems mobile actions', () => {
  it('offers investigating an issue in a new session', async () => {
    isMobile = true
    const user = userEvent.setup()
    const onInvestigateInNewSession = vi.fn()
    const issue: GitHubIssue = {
      number: 42,
      title: 'Investigate without a new worktree',
      body: '',
      state: 'OPEN',
      labels: [],
      created_at: '2026-01-01T00:00:00Z',
      author: { login: 'octocat' },
    }

    render(
      <IssueItem
        issue={issue}
        index={0}
        isSelected={false}
        isCreating={false}
        onMouseEnter={vi.fn()}
        onClick={vi.fn()}
        onInvestigate={vi.fn()}
        onInvestigateInNewSession={onInvestigateInNewSession}
        onPreview={vi.fn()}
      />
    )

    await user.click(screen.getByRole('button', { name: /issue actions/i }))
    await user.click(
      screen.getByRole('menuitem', { name: /investigate in new session/i })
    )

    expect(onInvestigateInNewSession).toHaveBeenCalledTimes(1)
  })

  it('puts preview, investigate, and background investigation behind a mobile overflow menu', async () => {
    isMobile = true
    const user = userEvent.setup()
    const onPreview = vi.fn()
    const onInvestigate = vi.fn()

    renderSecurityAlertItem({ onPreview, onInvestigate })

    expect(screen.queryByRole('button', { name: /preview alert/i })).toBeNull()
    expect(
      screen.queryByRole('button', { name: /investigate alert/i })
    ).toBeNull()

    await user.click(screen.getByRole('button', { name: /alert actions/i }))
    await user.click(screen.getByRole('menuitem', { name: /preview/i }))
    expect(onPreview).toHaveBeenCalledTimes(1)

    await user.click(screen.getByRole('button', { name: /alert actions/i }))
    await user.click(screen.getByRole('menuitem', { name: /^investigate$/i }))
    expect(onInvestigate).toHaveBeenLastCalledWith(false)

    await user.click(screen.getByRole('button', { name: /alert actions/i }))
    await user.click(
      screen.getByRole('menuitem', { name: /investigate in background/i })
    )
    expect(onInvestigate).toHaveBeenLastCalledWith(true)
  })
})

describe('BranchItem', () => {
  it('opens the selected branch directly without offering a child branch action', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <BranchItem
        branch="feature/existing"
        index={0}
        isSelected={false}
        isCreating={false}
        onMouseEnter={vi.fn()}
        onClick={onClick}
      />
    )

    expect(screen.getAllByRole('button')).toHaveLength(1)
    await user.click(screen.getByRole('button', { name: 'feature/existing' }))
    expect(onClick).toHaveBeenCalledWith(false)
  })
})
