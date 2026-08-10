import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NewIssuesBadge } from './NewIssuesBadge'
import { OpenPRsBadge } from './OpenPRsBadge'
import { SecurityAlertsBadge } from './SecurityAlertsBadge'

const mocks = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock('@/lib/open-new-worktree', () => ({ openNewWorktree: mocks.open }))
vi.mock('@/services/github', () => ({
  useGitHubIssues: () => ({ data: { totalCount: 2 } }),
  useGitHubPRs: () => ({ data: [{ number: 1 }] }),
  useDependabotAlerts: () => ({ data: [{ number: 1 }] }),
  useRepositoryAdvisories: () => ({
    data: [{ ghsaId: 'GHSA-test', state: 'draft' }],
  }),
}))

function renderBadge(node: React.ReactNode) {
  const queryClient = new QueryClient()
  queryClient.setQueryData(['gh-cli', 'auth'], { authenticated: true })
  return render(
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  )
}

describe('new-session project badges', () => {
  beforeEach(() => vi.clearAllMocks())

  it.each([
    {
      node: <NewIssuesBadge projectId="project-1" projectPath="/repo" />,
      name: /open 2 github issues in a new session/i,
      tab: 'issues',
    },
    {
      node: <OpenPRsBadge projectId="project-1" projectPath="/repo" />,
      name: /open 1 pull request in a new session/i,
      tab: 'prs',
    },
    {
      node: <SecurityAlertsBadge projectId="project-1" projectPath="/repo" />,
      name: /open 2 security alerts in a new session/i,
      tab: 'security',
    },
  ])(
    'routes the $tab badge through the prompt-first flow',
    ({ node, name, tab }) => {
      renderBadge(node)
      fireEvent.click(screen.getByRole('button', { name }))
      expect(mocks.open).toHaveBeenCalledWith({ projectId: 'project-1', tab })
    }
  )
})
