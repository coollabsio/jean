import { beforeEach, describe, expect, it } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen, within } from '@/test/test-utils'
import { useChatStore } from '@/store/chat-store'
import { useSubSessionStore } from '@/store/sub-session-store'
import type { Session } from '@/types/chat'
import { SubSessionPanel, SubSessionStrip } from './SubSessionPanel'

const now = Math.floor(Date.now() / 1000)

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    name: partial.id,
    order: 0,
    created_at: now - 600,
    updated_at: now - 60,
    messages: [],
    ...partial,
  }
}

const lead = session({ id: 'lead', name: 'Plan the release' })
const running = session({
  id: 'child-a',
  name: 'Write changelog',
  last_run_status: 'running',
  last_run_started_at: now - 65,
  delegated_by: { origin_session_id: 'lead', origin_worktree_id: 'wt' },
})
const finished = session({
  id: 'child-b',
  name: 'Check CI',
  last_run_status: 'completed',
  updated_at: now - 30,
  delegated_by: {
    origin_session_id: 'lead',
    origin_worktree_id: 'wt',
    outcome: {
      status: 'done',
      body: 'CI is green on main.',
      ended_at: now - 120,
      reported_at: now - 100,
    },
  },
})
const unrelated = session({ id: 'other', name: 'Fix flaky test' })
const sessions = [lead, running, finished, unrelated]

beforeEach(() => {
  useChatStore.setState({
    sendingSessionIds: { 'child-a': true },
    executingModes: { 'child-a': 'build' },
    activeSessionIds: {},
  })
  useSubSessionStore.setState({
    railPanelSessionIds: new Set(),
    openStripSessionIds: new Set(),
  })
})

describe('SubSessionPanel', () => {
  it('lists the sub-sessions with live status, time, and last reply', () => {
    render(
      <SubSessionPanel leadId="lead" sessions={sessions} worktreeId="wt" />
    )

    const panel = screen.getByRole('complementary', { name: 'Sub-sessions' })
    const [first, second, ...rest] =
      within(panel).getAllByTestId('sub-session-card')
    expect(rest).toHaveLength(0)
    if (!first || !second) throw new Error('expected two sub-session cards')

    expect(first).toHaveTextContent('Write changelog')
    expect(within(first).getByRole('img', { name: 'Vibing' })).toBeVisible()
    expect(first).toHaveTextContent(/1m [56]s/)

    expect(second).toHaveTextContent('Check CI')
    expect(within(second).getByRole('img', { name: 'Completed' })).toBeVisible()
    expect(second).toHaveTextContent('2m ago')
    expect(second).toHaveTextContent('CI is green on main.')

    expect(panel).not.toHaveTextContent('Fix flaky test')
    expect(panel).not.toHaveTextContent('Plan the release')
  })

  it('opens the clicked sub-session', async () => {
    render(
      <SubSessionPanel leadId="lead" sessions={sessions} worktreeId="wt" />
    )

    await userEvent.click(screen.getByText('Check CI'))

    expect(useChatStore.getState().activeSessionIds['wt']).toBe('child-b')
  })

  it('folds to a rail with one status dot per sub-session', async () => {
    render(
      <SubSessionPanel leadId="lead" sessions={sessions} worktreeId="wt" />
    )

    await userEvent.click(
      screen.getByRole('button', { name: 'Collapse sub-session panel' })
    )

    const rail = screen.getByRole('complementary', { name: 'Sub-sessions' })
    expect(within(rail).queryByTestId('sub-session-card')).toBeNull()
    expect(
      within(rail).getByRole('button', { name: 'Write changelog: Vibing' })
    ).toBeVisible()
    await userEvent.click(
      within(rail).getByRole('button', { name: 'Check CI: Completed' })
    )
    expect(useChatStore.getState().activeSessionIds['wt']).toBe('child-b')

    await userEvent.click(
      screen.getByRole('button', { name: 'Expand sub-session panel' })
    )
    expect(screen.getAllByTestId('sub-session-card')).toHaveLength(2)
  })

  it('renders nothing for a session without sub-sessions', () => {
    render(
      <SubSessionPanel leadId="other" sessions={sessions} worktreeId="wt" />
    )

    expect(screen.queryByRole('complementary')).toBeNull()
  })
})

describe('SubSessionStrip', () => {
  it('shows the running count closed and the same cards open', async () => {
    render(
      <SubSessionStrip leadId="lead" sessions={sessions} worktreeId="wt" />
    )

    const strip = screen.getByTestId('sub-session-strip')
    expect(strip).toHaveTextContent('Sub-sessions1 running')
    expect(within(strip).queryByTestId('sub-session-card')).toBeNull()

    await userEvent.click(
      within(strip).getByRole('button', { name: /Sub-sessions/ })
    )

    const cards = within(strip).getAllByTestId('sub-session-card')
    expect(cards[0]).toHaveTextContent('Write changelog')
    expect(cards[1]).toHaveTextContent('CI is green on main.')
  })

  it('renders nothing for a session without sub-sessions', () => {
    render(
      <SubSessionStrip leadId="other" sessions={sessions} worktreeId="wt" />
    )

    expect(screen.queryByTestId('sub-session-strip')).toBeNull()
  })
})
