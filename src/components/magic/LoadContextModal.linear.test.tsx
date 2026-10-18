import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, waitFor } from '@/test/test-utils'
import { LoadContextModal } from './LoadContextModal'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  invalidateQueries: vi.fn(),
  refetch: vi.fn(),
  toastError: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({ invoke: mocks.invoke }))

vi.mock('sonner', () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
    loading: vi.fn(() => 'toast-1'),
  },
}))

vi.mock('@tanstack/react-query', async importOriginal => ({
  ...(await importOriginal()),
  useQueryClient: () => ({
    invalidateQueries: mocks.invalidateQueries,
  }),
}))

vi.mock('@/hooks/useGhLogin', () => ({
  useGhLogin: () => ({ triggerLogin: vi.fn(), isGhInstalled: true }),
}))

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({ data: {} }),
}))

vi.mock('@/services/github', () => ({
  githubQueryKeys: {
    issues: (path: string, state: string) => ['issues', path, state],
    prs: (path: string, state: string) => ['prs', path, state],
    securityAlerts: (path: string, state: string) => [
      'security-alerts',
      path,
      state,
    ],
    advisories: (path: string, state: string) => ['advisories', path, state],
    loadedContexts: (sessionId: string) => ['loaded-contexts', sessionId],
    loadedPrContexts: (sessionId: string) => ['loaded-pr-contexts', sessionId],
    attachedContexts: (sessionId: string) => ['attached-contexts', sessionId],
    loadedSecurityContexts: (sessionId: string) => [
      'loaded-security-contexts',
      sessionId,
    ],
    loadedAdvisoryContexts: (sessionId: string) => [
      'loaded-advisory-contexts',
      sessionId,
    ],
  },
}))

vi.mock('@/services/linear', () => ({
  linearQueryKeys: {
    issues: (projectId: string) => ['linear', 'issues', projectId],
    loadedContexts: (sessionId: string) => [
      'linear',
      'loaded-contexts',
      sessionId,
    ],
  },
  isLinearAuthError: () => false,
}))

vi.mock('@/components/ui/markdown', () => ({
  Markdown: ({ children }: { children: string }) => <div>{children}</div>,
}))

vi.mock('./hooks/useLoadContextData', () => ({
  useLoadContextData: () => ({
    loadedIssueContexts: [],
    isLoadingIssueContexts: false,
    refetchIssueContexts: mocks.refetch,
    loadedPRContexts: [],
    isLoadingPRContexts: false,
    refetchPRContexts: mocks.refetch,
    loadedSecurityContexts: [],
    isLoadingSecurityContexts: false,
    refetchSecurityContexts: mocks.refetch,
    loadedAdvisoryContexts: [],
    isLoadingAdvisoryContexts: false,
    refetchAdvisoryContexts: mocks.refetch,
    attachedSavedContexts: [],
    isLoadingAttachedContexts: false,
    refetchAttachedContexts: mocks.refetch,
    isLoadingIssues: false,
    isRefetchingIssues: false,
    isSearchingIssues: false,
    issuesError: null,
    refetchIssues: mocks.refetch,
    isLoadingPRs: false,
    isRefetchingPRs: false,
    isSearchingPRs: false,
    prsError: null,
    refetchPRs: mocks.refetch,
    isLoadingSecurityAlerts: false,
    isRefetchingSecurityAlerts: false,
    securityError: null,
    refetchSecurityAlerts: mocks.refetch,
    isLoadingAdvisories: false,
    isRefetchingAdvisories: false,
    refetchAdvisories: mocks.refetch,
    isLoadingContexts: false,
    isLoadingSessions: false,
    contextsError: null,
    refetchContexts: mocks.refetch,
    loadedLinearContexts: [
      {
        identifier: 'ENG-123',
        title: 'Fix Linear context viewer',
        commentCount: 1,
        projectName: 'Jean',
        url: 'https://linear.app/acme/issue/ENG-123',
      },
    ],
    loadedSentryContexts: [
      {
        id: '123',
        shortId: 'COOLIFY-BXB',
        title: 'Failed Sentry context',
        permalink: 'https://sentry.io/issues/123',
        content: '# Sentry Issue COOLIFY-BXB: Failed Sentry context',
      },
    ],
    isLoadingSentryContexts: false,
    refetchSentryContexts: mocks.refetch,
    isLoadingSentryIssues: false,
    isRefetchingSentryIssues: false,
    sentryIssuesError: null,
    refetchSentryIssues: mocks.refetch,
    isLoadingLinearContexts: false,
    refetchLinearContexts: mocks.refetch,
    isLoadingLinearIssues: false,
    isRefetchingLinearIssues: false,
    isSearchingLinearIssues: false,
    linearIssuesError: null,
    refetchLinearIssues: mocks.refetch,
    filteredIssues: [],
    filteredPRs: [],
    filteredSecurityAlerts: [],
    filteredAdvisories: [],
    filteredLinearIssues: [],
    filteredSentryIssues: [],
    filteredContexts: [],
    filteredEntries: [],
    renameMutation: { mutate: vi.fn() },
    hasLoadedIssueContexts: false,
    hasLoadedPRContexts: false,
    hasLoadedSecurityContexts: false,
    hasLoadedAdvisoryContexts: false,
    hasLoadedLinearContexts: true,
    hasLoadedSentryContexts: true,
    hasAttachedContexts: false,
    hasContexts: false,
    hasSessions: false,
  }),
}))

describe('LoadContextModal Linear context viewer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.invoke.mockResolvedValue([
      {
        identifier: 'ENG-123',
        title: 'Fix Linear context viewer',
        content:
          '# Linear Issue ENG-123: Fix Linear context viewer\n\nExpected markdown content from Linear.',
      },
    ])
  })

  it('opens the saved Linear context markdown when View context is clicked', async () => {
    const user = userEvent.setup()

    render(
      <LoadContextModal
        open={true}
        onOpenChange={vi.fn()}
        worktreeId="wt-1"
        worktreePath="/repo/worktree"
        activeSessionId="session-1"
        projectName="Jean"
        projectId="project-1"
      />
    )

    await screen.findByText('Loaded Linear Issues')

    await user.click(
      screen.getByRole('button', { name: 'View context for ENG-123' })
    )

    await waitFor(() => {
      expect(mocks.invoke).toHaveBeenCalledWith(
        'get_linear_issue_context_contents',
        {
          sessionId: 'session-1',
          worktreeId: 'wt-1',
          projectId: 'project-1',
        }
      )
    })
    expect(
      await screen.findByText(/Expected markdown content from Linear/)
    ).toBeInTheDocument()
  })

  it('offers Sentry as a context source', async () => {
    render(
      <LoadContextModal
        open={true}
        onOpenChange={vi.fn()}
        worktreeId="wt-1"
        worktreePath="/repo/worktree"
        activeSessionId="session-1"
        projectName="Jean"
        projectId="project-1"
      />
    )

    expect(
      await screen.findByRole('button', { name: /Sentry/ })
    ).toBeInTheDocument()
  })

  it('lets a failed loaded Sentry context be removed so it can be re-added', async () => {
    const user = userEvent.setup()
    mocks.invoke.mockResolvedValue(undefined)
    render(
      <LoadContextModal
        open={true}
        onOpenChange={vi.fn()}
        worktreeId="wt-1"
        worktreePath="/repo/worktree"
        activeSessionId="session-1"
        projectName="Jean"
        projectId="project-1"
      />
    )

    await user.click(await screen.findByRole('button', { name: /Sentry/ }))
    await user.click(
      await screen.findByRole('button', { name: 'Remove COOLIFY-BXB' })
    )

    expect(mocks.invoke).toHaveBeenCalledWith('remove_sentry_issue_context', {
      sessionId: 'session-1',
      projectId: 'project-1',
      issueId: '123',
    })
  })
})
