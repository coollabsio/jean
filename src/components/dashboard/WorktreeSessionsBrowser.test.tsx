import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen } from '@/test/test-utils'
import type {
  SessionCardData,
  SessionStatus,
} from '@/components/chat/session-card-utils'
import type { Session } from '@/types/chat'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { WorktreeSessionsBrowser } from './WorktreeSessionsBrowser'

function card(
  partial: Omit<Partial<SessionCardData>, 'session'> & {
    status: SessionStatus
    session?: Partial<Session>
  }
): SessionCardData {
  const { session, ...rest } = partial
  return {
    session: {
      id: session?.id ?? 'session',
      name: session?.name ?? 'Session',
      order: 0,
      created_at: 1_700_000_000,
      updated_at: 1_700_000_000,
      messages: [],
      ...session,
    },
    automaticStatus: partial.status,
    statusOverride: null,
    executionMode: 'plan',
    isSending: false,
    isWaiting: false,
    hasExitPlanMode: false,
    hasQuestion: false,
    hasPermissionDenials: false,
    permissionDenialCount: 0,
    planFilePath: null,
    planContent: null,
    pendingPlanMessageId: null,
    label: null,
    ...rest,
  }
}

const review = card({
  status: 'review',
  automaticStatus: 'idle',
  statusOverride: 'review',
  label: { name: 'Needs testing', color: '#22c55e' },
  session: {
    id: 'review',
    name: 'Review the diff',
    updated_at: 1_699_000_000,
    backend: 'claude',
  },
})

const planning = card({
  status: 'planning',
  session: {
    id: 'plan',
    name: 'Plan the auth flow',
    updated_at: 1_699_900_000,
    backend: 'codex',
  },
})

describe('WorktreeSessionsBrowser', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn()
    useUIStore.setState({
      magicModalOpen: false,
      planDialogOpen: false,
      commandPaletteOpen: false,
      preferencesOpen: false,
      releaseNotesModalOpen: false,
      sessionChatModalOpen: false,
    })
    useProjectsStore.setState({ projectSettingsDialogOpen: false })
  })

  it('opens a session and shows status, agent status, label, and backend', async () => {
    const user = userEvent.setup()
    const onOpenSession = vi.fn()
    render(
      <WorktreeSessionsBrowser
        worktreeName="main"
        cards={[review, planning]}
        onBack={vi.fn()}
        onOpenSession={onOpenSession}
        onCreateSession={vi.fn()}
      />
    )

    expect(screen.getByRole('heading', { name: 'main' })).toBeInTheDocument()
    expect(screen.getByText('2 sessions')).toBeInTheDocument()
    expect(screen.getByText('Review ready')).toBeInTheDocument()
    expect(screen.getByText('Agent · Idle')).toBeInTheDocument()
    expect(screen.getAllByText('Needs testing').length).toBeGreaterThan(0)
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.getByText('Planning')).toBeInTheDocument()
    expect(screen.queryByText('Agent · Planning')).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /Review the diff/ }))
    expect(onOpenSession).toHaveBeenCalledWith('review')
  })

  it('filters by status and returns to the worktree list', async () => {
    const user = userEvent.setup()
    const onBack = vi.fn()
    const onCreateSession = vi.fn()
    render(
      <WorktreeSessionsBrowser
        worktreeName="main"
        cards={[review, planning]}
        onBack={onBack}
        onOpenSession={vi.fn()}
        onCreateSession={onCreateSession}
      />
    )

    await user.click(screen.getByRole('tab', { name: /In progress/ }))
    expect(screen.getByText('Plan the auth flow')).toBeInTheDocument()
    expect(screen.queryByText('Review the diff')).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: /Needs testing/ }))
    expect(screen.getByText('Review the diff')).toBeInTheDocument()
    expect(screen.queryByText('Plan the auth flow')).not.toBeInTheDocument()

    await user.type(
      screen.getByRole('textbox', { name: 'Search sessions' }),
      'missing'
    )
    expect(
      screen.getByText('No sessions match your search')
    ).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Back to worktrees' }))
    expect(onBack).toHaveBeenCalledOnce()

    await user.click(screen.getByRole('button', { name: 'New session' }))
    expect(onCreateSession).toHaveBeenCalledOnce()
  })

  it('returns to the worktree list on Escape', () => {
    const onBack = vi.fn()
    render(
      <WorktreeSessionsBrowser
        worktreeName="main"
        cards={[review, planning]}
        onBack={onBack}
        onOpenSession={vi.fn()}
        onCreateSession={vi.fn()}
      />
    )

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(onBack).toHaveBeenCalledOnce()
  })

  it('opens the highlighted session from the keyboard', () => {
    const onOpenSession = vi.fn()
    render(
      <WorktreeSessionsBrowser
        worktreeName="main"
        cards={[review, planning]}
        onBack={vi.fn()}
        onOpenSession={onOpenSession}
        onCreateSession={vi.fn()}
      />
    )

    fireEvent.keyDown(window, { key: 'Enter' })
    expect(onOpenSession).toHaveBeenCalledWith('plan')
  })

  it('offers to create the first session when the worktree is empty', () => {
    render(
      <WorktreeSessionsBrowser
        worktreeName="main"
        cards={[]}
        onBack={vi.fn()}
        onOpenSession={vi.fn()}
        onCreateSession={vi.fn()}
      />
    )

    expect(
      screen.getByText('No sessions yet. Create one to start chatting.')
    ).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'New session' })).toHaveLength(
      2
    )
  })
})
