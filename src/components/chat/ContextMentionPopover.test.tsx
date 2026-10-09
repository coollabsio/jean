import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { render as renderWithoutProviders } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ContextMentionPopover } from './ContextMentionPopover'
import type { ContextMentionItem } from './hooks/useContextMentionData'
import type { GitHubIssue } from '@/types/github'
import type * as EnvironmentModule from '@/lib/environment'

const useContextMentionDataMock = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ native: false, mobile: false }))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal<typeof EnvironmentModule>()),
  isNativeApp: () => platform.native,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => platform.mobile,
}))

const items: [ContextMentionItem, ContextMentionItem] = [
  {
    id: 'issue:123',
    type: 'issue',
    label: '#123',
    title: 'Fix login bug',
  },
  {
    id: 'pr:45',
    type: 'pr',
    label: 'PR #45',
    title: 'Add context mentions',
  },
]

const linkUsage = vi.hoisted(() => ({
  getMatches: vi.fn((): unknown[] => []),
  open: vi.fn(),
}))

vi.mock('@/hooks/useContextLinkUsage', async importOriginal => ({
  ...(await importOriginal<typeof import('@/hooks/useContextLinkUsage')>()),
  useContextLinkUsage: () => ({ getMatches: linkUsage.getMatches }),
  openContextLinkMatch: linkUsage.open,
}))

vi.mock('@/components/worktree/IssuePreviewModal', () => ({
  IssuePreviewModal: ({ type, number }: { type: string; number: number }) => (
    <div role="dialog">
      Preview {type} {number}
    </div>
  ),
}))

vi.mock('./hooks/useContextMentionData', () => ({
  useContextMentionData: useContextMentionDataMock,
}))

describe('ContextMentionPopover', () => {
  beforeEach(() => {
    platform.native = false
    platform.mobile = false
    linkUsage.getMatches.mockReset().mockReturnValue([])
    linkUsage.open.mockReset()
    useContextMentionDataMock.mockImplementation(() => ({
      groups: [
        { id: 'issue', heading: 'GitHub Issues', items: [items[0]] },
        { id: 'pr', heading: 'GitHub Pull Requests', items: [items[1]] },
      ],
      isFetching: false,
    }))
  })

  beforeAll(() => {
    class ResizeObserverMock {
      observe = vi.fn()
      unobserve = vi.fn()
      disconnect = vi.fn()
    }

    vi.stubGlobal('ResizeObserver', ResizeObserverMock)
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('renders grouped context mention results', () => {
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={vi.fn()}
        searchQuery="123"
        anchorPosition={{ top: 0, left: 0 }}
        containerWidth={480}
      />
    )

    expect(screen.getByText('GitHub Issues')).toBeInTheDocument()
    expect(screen.getByText('GitHub Pull Requests')).toBeInTheDocument()
    expect(screen.getByText('#123')).toBeInTheDocument()
    expect(screen.getByText('Fix login bug')).toBeInTheDocument()
    expect(screen.getByText('PR #45')).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Refresh context links' })
        .parentElement
    ).toContainElement(
      screen.getByRole('button', { name: 'Include closed/merged' })
    )
  })

  it('opens the issue preview without selecting or closing the list', () => {
    const onOpenChange = vi.fn()
    const onSelectContext = vi.fn()
    useContextMentionDataMock.mockImplementation(() => ({
      groups: [
        {
          id: 'issue',
          heading: 'GitHub Issues',
          items: [{ ...items[0], issue: { number: 123 } as GitHubIssue }],
        },
      ],
      isFetching: false,
    }))
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={onOpenChange}
        onSelectContext={onSelectContext}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'Preview #123' }))

    expect(screen.getByText('Preview issue 123')).toBeInTheDocument()
    expect(onSelectContext).not.toHaveBeenCalled()
    expect(onOpenChange).not.toHaveBeenCalled()
  })

  it('opens the existing investigation instead of starting a new one', () => {
    const match = {
      worktreeId: 'wt-1',
      worktreeName: 'fix-login',
      worktreePath: '/tmp/wt-1',
      sessionId: 'session-2',
      sessionName: 'Investigate #123',
    }
    linkUsage.getMatches.mockReturnValue([match])
    const onSelectContext = vi.fn()
    useContextMentionDataMock.mockImplementation(() => ({
      groups: [
        {
          id: 'issue',
          heading: 'GitHub Issues',
          items: [{ ...items[0], issue: { number: 123 } as GitHubIssue }],
        },
      ],
      isFetching: false,
    }))
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        sessionId="session-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={onSelectContext}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    expect(screen.getByTestId('context-link-badge')).toHaveTextContent(
      'fix-login › Investigate #123'
    )
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Open existing investigation of #123',
      })
    )

    expect(linkUsage.open).toHaveBeenCalledWith(match)
    expect(onSelectContext).not.toHaveBeenCalled()

    // Attaching context to the current session is still allowed
    fireEvent.click(
      screen.getByRole('button', { name: 'Add #123 to session context' })
    )
    expect(onSelectContext).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'issue:123' }),
      false
    )
  })

  it('searches from the menu without changing the chat query', () => {
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={vi.fn()}
        searchQuery="123"
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    const search = screen.getByRole('combobox', {
      name: 'Search issues and context links',
    })
    fireEvent.change(search, { target: { value: 'login failure details' } })

    expect(useContextMentionDataMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: 'login failure details' })
    )
    fireEvent.change(search, { target: { value: '' } })
    expect(useContextMentionDataMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ query: '123' })
    )
  })

  it('selects a search result with the keyboard', () => {
    const onSelectContext = vi.fn()
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={onSelectContext}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    const search = screen.getByRole('combobox', {
      name: 'Search issues and context links',
    })
    fireEvent.keyDown(search, { key: 'ArrowDown' })
    fireEvent.keyDown(search, { key: 'Enter' })

    expect(onSelectContext).toHaveBeenCalledWith(items[1], false)
  })

  it('offers separate add and investigate actions for issues and PRs', () => {
    const onSelectContext = vi.fn()
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={onSelectContext}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Add #123 to session context' })
    )
    expect(onSelectContext).toHaveBeenCalledWith(items[0], false)

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Add PR #45 and start investigating',
      })
    )
    expect(onSelectContext).toHaveBeenCalledWith(items[1], true)
  })

  it('uses Shift+Enter to investigate the selected issue', () => {
    const onSelectContext = vi.fn()
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={onSelectContext}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    fireEvent.keyDown(screen.getByRole('combobox'), {
      key: 'Enter',
      shiftKey: true,
    })
    expect(onSelectContext).toHaveBeenCalledWith(items[0], true)
  })

  it('shows keyboard hints in tooltips on native desktop', async () => {
    platform.native = true
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={vi.fn()}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    expect(screen.queryByText('Shift+Enter')).not.toBeInTheDocument()
    fireEvent.focus(
      screen.getByRole('button', {
        name: `Add ${items[0].label} and start investigating`,
      })
    )
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Shift+Enter')
  })

  it('hides keyboard hints on mobile and web access', () => {
    platform.native = true
    platform.mobile = true
    const props = {
      projectPath: '/tmp/repo',
      projectId: 'project-1',
      open: true,
      onOpenChange: vi.fn(),
      onSelectContext: vi.fn(),
      searchQuery: '',
      anchorPosition: { top: 0, left: 0 },
    }
    const { rerender } = render(<ContextMentionPopover {...props} />)
    expect(screen.queryByText('Shift+Enter')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Refresh context links' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: `Add ${items[0].label} and start investigating`,
      })
    ).not.toHaveTextContent('Investigate')
    expect(screen.queryByText('Attach')).not.toBeInTheDocument()

    platform.native = false
    platform.mobile = false
    rerender(<ContextMentionPopover {...props} />)
    expect(screen.queryByText('Shift+Enter')).not.toBeInTheDocument()
  })

  it('loads more issues and PRs independently, then resets for a new search', () => {
    const issues = Array.from(
      { length: 10 },
      (_, index): ContextMentionItem => ({
        ...items[0],
        type: 'issue',
        id: `issue:${index + 1}`,
        label: `#${index + 1}`,
        title: `Issue ${index + 1}`,
      })
    )
    const prs = Array.from(
      { length: 10 },
      (_, index): ContextMentionItem => ({
        ...items[1],
        type: 'pr',
        id: `pr:${index + 1}`,
        label: `PR #${index + 1}`,
        title: `Pull request ${index + 1}`,
      })
    )
    useContextMentionDataMock.mockImplementation(
      ({ issueLimit, prLimit }: { issueLimit: number; prLimit: number }) => ({
        groups: [
          {
            id: 'issue',
            heading: 'GitHub Issues',
            items: issues.slice(0, issueLimit),
            hasMore: issues.length > issueLimit,
          },
          {
            id: 'pr',
            heading: 'GitHub Pull Requests',
            items: prs.slice(0, prLimit),
            hasMore: prs.length > prLimit,
          },
        ],
        isFetching: false,
      })
    )

    const onSelectContext = vi.fn()
    render(
      <ContextMentionPopover
        projectPath="/tmp/repo"
        projectId="project-1"
        open
        onOpenChange={vi.fn()}
        onSelectContext={onSelectContext}
        searchQuery=""
        anchorPosition={{ top: 0, left: 0 }}
      />
    )

    expect(screen.queryByText('Issue 9')).not.toBeInTheDocument()
    expect(screen.queryByText('Pull request 9')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more issues' }))
    expect(screen.getByText('Issue 9')).toBeInTheDocument()
    expect(screen.queryByText('Pull request 9')).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Load more issues' })
    ).toBeNull()

    const search = screen.getByRole('combobox')
    for (let index = 0; index < 8; index++) {
      fireEvent.keyDown(search, { key: 'ArrowDown' })
    }
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onSelectContext).toHaveBeenCalledWith(issues[8], false)

    fireEvent.click(
      screen.getByRole('button', { name: 'Load more pull requests' })
    )
    expect(screen.getByText('Pull request 9')).toBeInTheDocument()
    fireEvent.change(search, { target: { value: 'new search' } })
    expect(screen.queryByText('Issue 9')).not.toBeInTheDocument()
    expect(screen.queryByText('Pull request 9')).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Load more issues' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Load more pull requests' })
    ).toBeInTheDocument()
  })

  it('refreshes only context queries for the current project', async () => {
    const client = new QueryClient()
    const refreshedKeys = [
      ['github', 'issues', '/tmp/repo', 'open', 'project-1'],
      ['github', 'prs', '/tmp/repo', 'open', 'project-1'],
      ['github', 'issue-search', '/tmp/repo', 'login'],
      ['github', 'security-alerts', '/tmp/repo', 'open'],
      ['linear', 'issues', 'project-1'],
    ]
    const untouchedKeys = [
      ['github', 'issues', '/tmp/other', 'open', 'project-2'],
      ['github', 'labels', '/tmp/repo'],
      ['linear', 'issues', 'project-2'],
    ]
    for (const key of [...refreshedKeys, ...untouchedKeys]) {
      client.setQueryData(key, [])
    }

    renderWithoutProviders(
      <QueryClientProvider client={client}>
        <ContextMentionPopover
          projectPath="/tmp/repo"
          projectId="project-1"
          open
          onOpenChange={vi.fn()}
          onSelectContext={vi.fn()}
          searchQuery=""
          anchorPosition={{ top: 0, left: 0 }}
        />
      </QueryClientProvider>
    )

    fireEvent.click(
      screen.getByRole('button', { name: 'Refresh context links' })
    )
    await waitFor(() => {
      for (const key of refreshedKeys) {
        expect(client.getQueryState(key)?.isInvalidated).toBe(true)
      }
    })
    for (const key of untouchedKeys) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(false)
    }
  })

  it('blocks a second refresh while the first refresh runs', async () => {
    const client = new QueryClient()
    let finishRefresh: (() => void) | undefined
    vi.spyOn(client, 'invalidateQueries').mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishRefresh = resolve
        })
    )

    renderWithoutProviders(
      <QueryClientProvider client={client}>
        <ContextMentionPopover
          projectPath="/tmp/repo"
          projectId="project-1"
          open
          onOpenChange={vi.fn()}
          onSelectContext={vi.fn()}
          searchQuery=""
          anchorPosition={{ top: 0, left: 0 }}
        />
      </QueryClientProvider>
    )

    const refresh = screen.getByRole('button', {
      name: 'Refresh context links',
    })
    fireEvent.click(refresh)
    expect(refresh).toBeDisabled()
    await act(async () => finishRefresh?.())
    expect(refresh).not.toBeDisabled()
  })
})
