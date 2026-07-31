import type { ComponentProps } from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { GitHubIssuesTab } from './GitHubIssuesTab'
import type { GitHubIssue } from '@/types/github'

const issues: GitHubIssue[] = [
  {
    number: 101,
    title: 'First issue',
    body: 'Body 1',
    state: 'OPEN',
    labels: [],
    created_at: '2026-01-01T00:00:00Z',
    author: { login: 'alice' },
  },
  {
    number: 102,
    title: 'Second issue',
    body: 'Body 2',
    state: 'OPEN',
    labels: [],
    created_at: '2026-01-02T00:00:00Z',
    author: { login: 'bob' },
  },
  {
    number: 103,
    title: 'Third issue',
    body: 'Body 3',
    state: 'OPEN',
    labels: [],
    created_at: '2026-01-03T00:00:00Z',
    author: { login: 'carol' },
  },
]

function renderTab(overrides: Partial<ComponentProps<typeof GitHubIssuesTab>> = {}) {
  const searchInputRef = { current: null }
  return render(
    <GitHubIssuesTab
      searchQuery=""
      setSearchQuery={vi.fn()}
      includeClosed={false}
      setIncludeClosed={vi.fn()}
      issues={issues}
      isLoading={false}
      isRefetching={false}
      isSearching={false}
      error={null}
      onRefresh={vi.fn()}
      selectedIndex={0}
      setSelectedIndex={vi.fn()}
      onSelectIssue={vi.fn()}
      onInvestigateIssue={vi.fn()}
      onBulkInvestigateIssues={vi.fn()}
      onPreviewIssue={vi.fn()}
      creatingFromNumber={null}
      isBulkInvestigating={false}
      searchInputRef={searchInputRef}
      onGhLogin={vi.fn()}
      isGhInstalled={true}
      {...overrides}
    />
  )
}

describe('GitHubIssuesTab multi-select', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('shows the bulk investigate bar when one or more issues are checked', async () => {
    const user = userEvent.setup()
    renderTab()

    expect(
      screen.queryByRole('button', { name: /investigate .* in background/i })
    ).toBeNull()

    await user.click(
      screen.getByRole('checkbox', { name: /select issue #101/i })
    )
    expect(
      screen.getByRole('button', {
        name: /investigate 1 issue in background/i,
      })
    ).toBeInTheDocument()
    expect(screen.getByText('1 selected')).toBeInTheDocument()

    await user.click(
      screen.getByRole('checkbox', { name: /select issue #102/i })
    )
    expect(
      screen.getByRole('button', {
        name: /investigate 2 issues in background/i,
      })
    ).toBeInTheDocument()
    expect(screen.getByText('2 selected')).toBeInTheDocument()
  })

  it('calls onBulkInvestigateIssues with the checked issues and clears selection', async () => {
    const user = userEvent.setup()
    const onBulkInvestigateIssues = vi.fn().mockResolvedValue(undefined)
    renderTab({ onBulkInvestigateIssues })

    await user.click(
      screen.getByRole('checkbox', { name: /select issue #101/i })
    )
    await user.click(
      screen.getByRole('checkbox', { name: /select issue #103/i })
    )

    await user.click(
      screen.getByRole('button', {
        name: /investigate 2 issues in background/i,
      })
    )

    expect(onBulkInvestigateIssues).toHaveBeenCalledTimes(1)
    const selected = onBulkInvestigateIssues.mock.calls[0]?.[0] as
      | GitHubIssue[]
      | undefined
    expect(selected?.map(i => i.number).sort()).toEqual([101, 103])

    // Selection cleared after bulk action
    expect(
      screen.queryByRole('button', { name: /investigate .* in background/i })
    ).toBeNull()
  })

  it('selects all visible issues via the select-all control', async () => {
    const user = userEvent.setup()
    renderTab()

    await user.click(
      screen.getByRole('checkbox', { name: /select all visible issues/i })
    )

    expect(screen.getByText('3 selected')).toBeInTheDocument()
    expect(
      screen.getByRole('button', {
        name: /investigate 3 issues in background/i,
      })
    ).toBeInTheDocument()

    // Individual checkboxes are checked
    for (const n of [101, 102, 103]) {
      expect(
        screen.getByRole('checkbox', { name: `Select issue #${n}` })
      ).toBeChecked()
    }
  })

  it('clears selection from the bulk bar clear control', async () => {
    const user = userEvent.setup()
    renderTab()

    await user.click(
      screen.getByRole('checkbox', { name: /select issue #101/i })
    )
    await user.click(
      screen.getByRole('checkbox', { name: /select issue #102/i })
    )
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^clear$/i }))
    expect(screen.queryByText('2 selected')).toBeNull()
    expect(
      screen.queryByRole('button', { name: /investigate .* in background/i })
    ).toBeNull()
  })

  it('shows starting state when isBulkInvestigating and items are selected', async () => {
    const user = userEvent.setup()
    const { rerender } = renderTab({ isBulkInvestigating: false })

    await user.click(
      screen.getByRole('checkbox', { name: /select issue #101/i })
    )
    await user.click(
      screen.getByRole('checkbox', { name: /select issue #102/i })
    )

    const searchInputRef = { current: null }
    rerender(
      <GitHubIssuesTab
        searchQuery=""
        setSearchQuery={vi.fn()}
        includeClosed={false}
        setIncludeClosed={vi.fn()}
        issues={issues}
        isLoading={false}
        isRefetching={false}
        isSearching={false}
        error={null}
        onRefresh={vi.fn()}
        selectedIndex={0}
        setSelectedIndex={vi.fn()}
        onSelectIssue={vi.fn()}
        onInvestigateIssue={vi.fn()}
        onBulkInvestigateIssues={vi.fn()}
        onPreviewIssue={vi.fn()}
        creatingFromNumber={null}
        isBulkInvestigating
        searchInputRef={searchInputRef}
        onGhLogin={vi.fn()}
        isGhInstalled={true}
      />
    )

    expect(screen.getByRole('button', { name: /starting/i })).toBeDisabled()
  })
})
