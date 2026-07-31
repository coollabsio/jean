import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { GitHubPRsTab } from './GitHubPRsTab'
import type { GitHubPullRequest } from '@/types/github'

const prs: GitHubPullRequest[] = [
  {
    number: 201,
    title: 'First PR',
    body: '',
    state: 'OPEN',
    headRefName: 'feat-a',
    baseRefName: 'main',
    isDraft: false,
    created_at: '2026-01-01T00:00:00Z',
    author: { login: 'alice' },
    labels: [],
  },
  {
    number: 202,
    title: 'Second PR',
    body: '',
    state: 'OPEN',
    headRefName: 'feat-b',
    baseRefName: 'main',
    isDraft: false,
    created_at: '2026-01-02T00:00:00Z',
    author: { login: 'bob' },
    labels: [],
  },
]

function renderTab(
  overrides: Partial<ComponentProps<typeof GitHubPRsTab>> = {}
) {
  const searchInputRef = { current: null }
  return render(
    <GitHubPRsTab
      searchQuery=""
      setSearchQuery={vi.fn()}
      includeClosed={false}
      setIncludeClosed={vi.fn()}
      prs={prs}
      isLoading={false}
      isRefetching={false}
      isSearching={false}
      error={null}
      onRefresh={vi.fn()}
      selectedIndex={0}
      setSelectedIndex={vi.fn()}
      onSelectPR={vi.fn()}
      onInvestigatePR={vi.fn()}
      onBulkInvestigatePRs={vi.fn()}
      onStackPR={vi.fn()}
      onPreviewPR={vi.fn()}
      creatingFromNumber={null}
      stackingFromPR={null}
      searchInputRef={searchInputRef}
      onGhLogin={vi.fn()}
      isGhInstalled={true}
      {...overrides}
    />
  )
}

describe('GitHubPRsTab multi-select', () => {
  it('shows bulk investigate after selecting one PR and invokes the bulk handler', async () => {
    const user = userEvent.setup()
    const onBulkInvestigatePRs = vi.fn().mockResolvedValue(undefined)
    renderTab({ onBulkInvestigatePRs })

    await user.click(screen.getByRole('checkbox', { name: /select pr #201/i }))
    expect(
      screen.getByRole('button', {
        name: /investigate 1 pr in background/i,
      })
    ).toBeInTheDocument()

    await user.click(screen.getByRole('checkbox', { name: /select pr #202/i }))
    await user.click(
      screen.getByRole('button', {
        name: /investigate 2 prs in background/i,
      })
    )

    expect(onBulkInvestigatePRs).toHaveBeenCalledTimes(1)
    const selected = onBulkInvestigatePRs.mock.calls[0]?.[0] as
      | GitHubPullRequest[]
      | undefined
    expect(selected?.map(p => p.number).sort()).toEqual([201, 202])
  })
})
