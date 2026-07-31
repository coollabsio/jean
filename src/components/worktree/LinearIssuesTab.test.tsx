import { render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { LinearIssuesTab } from './LinearIssuesTab'

vi.mock('@/store/ui-store', () => ({
  useUIStore: (
    selector: (state: { openPreferencesPane: () => void }) => unknown
  ) => selector({ openPreferencesPane: vi.fn() }),
}))

const baseProps = {
  searchQuery: '',
  setSearchQuery: vi.fn(),
  issues: [],
  isLoading: false,
  isRefetching: false,
  isSearching: false,
  onRefresh: vi.fn(),
  selectedIndex: 0,
  setSelectedIndex: vi.fn(),
  onSelectIssue: vi.fn(),
  onInvestigateIssue: vi.fn(),
  creatingFromId: null,
  searchInputRef: createRef<HTMLInputElement>(),
}

describe('LinearIssuesTab', () => {
  it('shows LinearAuthError when no Linear API key is configured', () => {
    render(
      <LinearIssuesTab
        {...baseProps}
        error={
          new Error(
            'No Linear API key configured. Add one in Settings → Integrations, or override per-project.'
          )
        }
      />
    )

    expect(
      screen.getByText('Linear access is not configured')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Open Integrations' })
    ).toBeInTheDocument()
    expect(screen.queryByText('No active issues found')).not.toBeInTheDocument()
  })

  it('handles string auth rejections without crashing', () => {
    render(
      <LinearIssuesTab
        {...baseProps}
        error="No Linear API key configured. Add one in Settings → Integrations."
      />
    )

    expect(
      screen.getByText('Linear access is not configured')
    ).toBeInTheDocument()
  })
})
