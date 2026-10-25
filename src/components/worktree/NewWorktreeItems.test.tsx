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
  it('opens a PR in the background with the web Ctrl modifier', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <PRItem
        pr={{
          number: 711,
          title: 'Web access',
          state: 'OPEN',
          labels: [],
          headRefName: 'feat/web-access',
          baseRefName: 'main',
          isDraft: false,
          created_at: '2026-01-01T00:00:00Z',
          author: { login: 'octocat' },
        }}
        index={0}
        isSelected={false}
        isCreating={false}
        isStacking={false}
        onMouseEnter={vi.fn()}
        onClick={onClick}
        onInvestigate={vi.fn()}
        onStack={vi.fn()}
        onPreview={vi.fn()}
      />
    )

    await user.keyboard('{Control>}')
    await user.click(screen.getByRole('button', { name: /^Web access/i }))
    await user.keyboard('{/Control}')

    expect(onClick).toHaveBeenCalledWith(true)
  })

  it('opens a PR when clicking anywhere on the row except its buttons', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    const onLabelClick = vi.fn()
    const onPreview = vi.fn()
    const onStack = vi.fn()
    render(
      <PRItem
        pr={{
          number: 712,
          title: 'Row click',
          state: 'OPEN',
          labels: [{ name: 'Bug', color: 'ff0000' }],
          headRefName: 'fix/row-click',
          baseRefName: 'main',
          isDraft: false,
          created_at: '2026-01-01T00:00:00Z',
          author: { login: 'octocat' },
        }}
        index={0}
        isSelected={false}
        isCreating={false}
        isStacking={false}
        onMouseEnter={vi.fn()}
        onClick={onClick}
        onInvestigate={vi.fn()}
        onStack={onStack}
        onPreview={onPreview}
        onLabelClick={onLabelClick}
      />
    )

    await user.click(screen.getByText(/#712 opened/))
    expect(onClick).toHaveBeenCalledWith(false)

    onClick.mockClear()
    await user.click(screen.getByRole('button', { name: 'Bug' }))
    await user.click(screen.getByRole('button', { name: 'Preview PR' }))
    await user.click(
      screen.getByRole('button', { name: /New worktree based on/ })
    )
    expect(onLabelClick).toHaveBeenCalledWith('Bug')
    expect(onPreview).toHaveBeenCalledTimes(1)
    expect(onStack).toHaveBeenCalledTimes(1)
    expect(onClick).not.toHaveBeenCalled()
  })

  it('shows issue labels, author and number, and filters by label on click', async () => {
    const user = userEvent.setup()
    const onLabelClick = vi.fn()
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
        onLabelClick={onLabelClick}
      />
    )
    expect(screen.getByText(/#42 opened .* ago/)).toBeInTheDocument()
    expect(screen.getByText('octocat')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Triage' }))
    expect(onLabelClick).toHaveBeenCalledWith('Triage')
  })

  it('shows PR labels and hides branch names', () => {
    const pr = {
      number: 711,
      title: 'feat(web): sign-in screen',
      state: 'OPEN',
      labels: [{ name: 'Feature', color: 'a855f7' }],
      headRefName: 'feat/web-auth-screen',
      baseRefName: 'main',
      isDraft: false,
      created_at: '2026-01-01T00:00:00Z',
      author: { login: 'octocat' },
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
    expect(screen.getByRole('button', { name: 'Feature' })).toBeInTheDocument()
    expect(screen.queryByText(/feat\/web-auth-screen/)).toBeNull()
    expect(screen.getByText(/#711 opened .* ago/)).toBeInTheDocument()
  })
})

describe('NewWorktreeItems mobile actions', () => {
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

  it('shows the remote when the same branch name exists on another remote', () => {
    render(
      <BranchItem
        branch="main"
        remote="upstream"
        index={0}
        isSelected={false}
        isCreating={false}
        onMouseEnter={vi.fn()}
        onClick={vi.fn()}
      />
    )

    expect(screen.getByRole('button', { name: 'main' })).toBeInTheDocument()
    expect(screen.getByText('upstream')).toBeInTheDocument()
  })
})

describe('existing worktree badge', () => {
  it('shows where an issue is already used without breaking the row', () => {
    render(
      <IssueItem
        issue={
          {
            number: 7,
            title: 'Crash on start',
            state: 'OPEN',
            created_at: '2020-01-01T00:00:00Z',
          } as GitHubIssue
        }
        index={0}
        isSelected={false}
        isCreating={false}
        contextMatches={[
          {
            worktreeId: 'wt-1',
            worktreeName: 'fix-crash',
            worktreePath: '/repo/fix-crash',
            sessionId: 's-1',
            sessionName: 'Investigate',
          },
          {
            worktreeId: 'wt-2',
            worktreeName: 'other',
            worktreePath: '/repo/other',
          },
        ]}
        onMouseEnter={vi.fn()}
        onClick={vi.fn()}
        onInvestigate={vi.fn()}
        onPreview={vi.fn()}
      />
    )

    const badge = screen.getByTestId('context-link-badge')
    expect(badge).toHaveTextContent('In fix-crash › Investigate')
    expect(badge).toHaveTextContent('+1')
  })
})
