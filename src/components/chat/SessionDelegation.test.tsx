import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { DelegatedByRow, SessionUpdateCard } from './SessionDelegation'
import type { SessionUpdate } from './session-update'

const worktrees: Record<
  string,
  { id: string; path: string; project_id: string }
> = {
  'wt-child': { id: 'wt-child', path: '/repo/child', project_id: 'proj-1' },
  'remote-a:wt-child': {
    id: 'remote-a:wt-child',
    path: '/srv/child',
    project_id: 'remote-a:proj-1',
  },
  'remote-a:wt-origin': {
    id: 'remote-a:wt-origin',
    path: '/srv/origin',
    project_id: 'remote-a:proj-2',
  },
}

vi.mock('@/services/projects', () => ({
  useWorktree: (id: string | null) => ({
    data: id ? (worktrees[id] ?? null) : null,
  }),
}))

const update: SessionUpdate = {
  sessionId: 'child-1',
  worktreeId: 'wt-child',
  name: 'Fix login',
  status: 'failed',
  body: 'Error: tests failed',
}

describe('SessionUpdateCard', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
    })
    useChatStore.setState({ activeSessionIds: {} })
    useUIStore.setState({ pendingAutoOpenSessionIds: {} })
  })

  it('shows the child name and status', () => {
    render(<SessionUpdateCard update={update} ownerSessionId="parent-1" />)

    const card = screen.getByTestId('session-update-card')
    expect(card).toHaveTextContent('Fix login')
    expect(card).toHaveTextContent('Failed')
  })

  it('opens the child session on the local server', async () => {
    render(<SessionUpdateCard update={update} ownerSessionId="parent-1" />)

    await userEvent.click(screen.getByRole('button', { name: 'Open session' }))

    expect(useProjectsStore.getState().selectedProjectId).toBe('proj-1')
    expect(useProjectsStore.getState().selectedWorktreeId).toBe('wt-child')
    expect(useChatStore.getState().activeSessionIds['wt-child']).toBe('child-1')
    expect(useUIStore.getState().pendingAutoOpenSessionIds['wt-child']).toBe(
      'child-1'
    )
  })

  it('scopes the child to the server of the session that received it', async () => {
    render(
      <SessionUpdateCard update={update} ownerSessionId="remote-a:parent-1" />
    )

    await userEvent.click(screen.getByRole('button', { name: 'Open session' }))

    expect(useProjectsStore.getState().selectedProjectId).toBe(
      'remote-a:proj-1'
    )
    expect(useChatStore.getState().activeSessionIds['remote-a:wt-child']).toBe(
      'remote-a:child-1'
    )
  })
})

describe('DelegatedByRow', () => {
  it('opens the session that started this one', async () => {
    render(
      <DelegatedByRow
        delegator={{
          origin_session_id: 'remote-a:origin-1',
          origin_worktree_id: 'remote-a:wt-origin',
          origin_name: 'Planner',
        }}
      />
    )

    await userEvent.click(
      screen.getByRole('button', { name: /Started by Planner/ })
    )

    expect(useProjectsStore.getState().selectedWorktreeId).toBe(
      'remote-a:wt-origin'
    )
    expect(useChatStore.getState().activeSessionIds['remote-a:wt-origin']).toBe(
      'remote-a:origin-1'
    )
  })

  it('names an unnamed origin', () => {
    render(
      <DelegatedByRow
        delegator={{ origin_session_id: 's0', origin_worktree_id: 'w0' }}
      />
    )

    expect(
      screen.getByRole('button', { name: /Started by another session/ })
    ).toBeDisabled()
  })
})
