import { describe, expect, it, vi } from 'vitest'
import { render, screen, within } from '@/test/test-utils'
import { SentryIssueItem } from './SentryIssueItem'
import type { SentryIssue } from '@/types/sentry'

const issue: SentryIssue = {
  id: '123',
  shortId: 'COOLIFY-BXB',
  title: 'Connection timed out after 10001 milliseconds',
  culprit: '/app/Jobs/SendMessageToSlack.php',
  permalink: 'https://sentry.io/issues/123',
  level: 'error',
  status: 'unresolved',
  count: '37253',
  userCount: 1,
  firstSeen: '2026-01-01T00:00:00Z',
  lastSeen: '2026-01-02T00:00:00Z',
  project: { id: '1', name: 'Coolify', slug: 'coolify' },
}

function renderIssue() {
  return render(
    <SentryIssueItem
      issue={issue}
      index={0}
      isSelected={false}
      isCreating={false}
      onMouseEnter={vi.fn()}
      onClick={vi.fn()}
      onInvestigate={vi.fn()}
    />
  )
}

describe('SentryIssueItem', () => {
  it('keeps the desktop issue identity and details in stable columns', () => {
    renderIssue()

    const desktopLayout = screen.getByTestId('sentry-issue-desktop')
    expect(desktopLayout).toHaveClass(
      'hidden',
      'sm:grid',
      'sm:grid-cols-[6.5rem_minmax(0,1fr)]'
    )
    expect(within(desktopLayout).getByText('COOLIFY-BXB')).toHaveClass(
      'shrink-0',
      'whitespace-nowrap'
    )
    expect(
      within(desktopLayout).getByTestId('sentry-issue-metadata')
    ).toHaveClass('min-w-0')
  })

  it('shows only the useful summary on mobile', () => {
    renderIssue()

    const mobileLayout = screen.getByTestId('sentry-issue-mobile')
    const mobile = within(mobileLayout)

    expect(mobileLayout).toHaveClass('min-w-0', 'sm:hidden')
    expect(mobile.getByText(issue.title)).toHaveClass('truncate')
    expect(mobile.getByText(issue.shortId)).toBeInTheDocument()
    expect(mobile.getByText('37.3K events')).toBeInTheDocument()
    expect(mobile.getByText('1 user')).toBeInTheDocument()
    expect(mobile.queryByText(issue.level)).toBeNull()
    expect(mobile.queryByText(issue.culprit)).toBeNull()
  })
})
