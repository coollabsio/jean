import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test/test-utils'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { DelegatedByRow, SessionUpdateLine } from './SessionDelegation'

const worktrees: Record<
  string,
  { id: string; path: string; project_id: string }
> = {
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

describe('SessionUpdateLine', () => {
  it('names each sub-session with its outcome and nothing else', () => {
    render(
      <SessionUpdateLine
        updates={[
          {
            sessionId: 'a',
            worktreeId: 'w',
            name: 'Write changelog',
            status: 'done',
            body: 'Added 1.2.0 notes.',
          },
          {
            sessionId: 'b',
            worktreeId: 'w',
            name: 'Check CI',
            status: 'failed',
            body: 'Error: tests failed',
          },
        ]}
      />
    )

    const line = screen.getByTestId('session-update-line')
    expect(line).toHaveTextContent('Write changelog finished, Check CI failed')
    expect(line).not.toHaveTextContent('Added 1.2.0 notes.')
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

describe('DelegatedByRow', () => {
  beforeEach(() => {
    useProjectsStore.setState({
      selectedProjectId: null,
      selectedWorktreeId: null,
    })
    useChatStore.setState({ activeSessionIds: {} })
    useUIStore.setState({ pendingAutoOpenSessionIds: {} })
  })

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
