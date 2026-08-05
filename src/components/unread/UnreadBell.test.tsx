import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AllSessionsResponse, Session } from '@/types/chat'
import { UnreadBell } from './UnreadBell'

const invokeMock = vi.fn()
let allSessions: AllSessionsResponse
let unreadCount = 2

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))

vi.mock('@/services/chat', () => ({
  useAllSessions: () => ({ data: allSessions, isLoading: false }),
}))

let finishedSessionAnimationEnabled = true
vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      finished_session_animation_enabled: finishedSessionAnimationEnabled,
    },
  }),
}))

vi.mock('./useUnreadCount', () => ({
  useUnreadCount: () => unreadCount,
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () =>
    (globalThis as typeof globalThis & { __JEAN_TEST_IS_MOBILE__?: boolean })
      .__JEAN_TEST_IS_MOBILE__ ?? false,
}))

vi.mock('@/lib/environment', async importOriginal => ({
  ...(await importOriginal()),
  isNativeApp: () =>
    (globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean })
      .__JEAN_TEST_IS_NATIVE__ ?? true,
}))

const selectProjectMock = vi.fn()
vi.mock('@/store/projects-store', () => ({
  useProjectsStore: {
    getState: () => ({
      selectedProjectId: 'project-1',
      selectProject: selectProjectMock,
    }),
  },
}))

const setActiveSessionMock = vi.fn()
const clearActiveWorktreeMock = vi.fn()
const setLastOpenedForProjectMock = vi.fn()
vi.mock('@/store/chat-store', () => ({
  useChatStore: {
    getState: () => ({
      setActiveSession: setActiveSessionMock,
      clearActiveWorktree: clearActiveWorktreeMock,
      setLastOpenedForProject: setLastOpenedForProjectMock,
    }),
  },
}))

const markWorktreeForAutoOpenSessionMock = vi.fn()
vi.mock('@/store/ui-store', () => ({
  useUIStore: {
    getState: () => ({
      markWorktreeForAutoOpenSession: markWorktreeForAutoOpenSessionMock,
    }),
  },
}))

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    name: 'Session one',
    created_at: 1,
    updated_at: 2_000,
    last_opened_at: 1_000,
    messages: [],
    archived_at: null,
    backend: 'claude',
    backend_session_id: null,
    claude_session_id: null,
    codex_session_id: null,
    cursor_session_id: null,
    opencode_session_id: null,
    last_run_status: 'completed',
    waiting_for_input: false,
    waiting_for_input_type: null,
    is_reviewing: false,
    ...overrides,
  } as Session
}

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn()
})

function renderWithQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

async function openDropdown() {
  const user = userEvent.setup()
  renderWithQueryClient(<UnreadBell title="Jean" />)
  await user.click(screen.getByRole('button', { name: /2 finished sessions/i }))
  await screen.findByText('Session one')
  return user
}

describe('UnreadBell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_MOBILE__?: boolean }
    ).__JEAN_TEST_IS_MOBILE__ = false
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = true
    unreadCount = 2
    finishedSessionAnimationEnabled = true
    allSessions = {
      entries: [
        {
          project_id: 'project-1',
          project_name: 'Jean',
          worktree_id: 'worktree-1',
          worktree_name: 'main',
          worktree_path: '/repo',
          sessions: [
            session({
              id: 'session-1',
              name: 'Session one',
              updated_at: 2_000,
            }),
            session({
              id: 'session-2',
              name: 'Session two',
              updated_at: 1_900,
            }),
          ],
        },
      ],
    }
    invokeMock.mockResolvedValue(undefined)
  })

  it('marks the focused unread session read when R is pressed', async () => {
    const user = await openDropdown()

    await user.keyboard('{ArrowDown}')
    await user.keyboard('r')

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('set_session_last_opened', {
        sessionId: 'session-2',
      })
    })
    expect(screen.queryByText('Session two')).not.toBeInTheDocument()
    expect(screen.getByText('Session one')).toBeInTheDocument()
  })

  it('shows an R keyboard affordance on the focused unread row', async () => {
    await openDropdown()

    const firstRow = screen.getByText('Session one').closest('button')
    const secondRow = screen.getByText('Session two').closest('button')

    if (!firstRow || !secondRow) {
      throw new Error('Expected both unread session rows to render')
    }

    expect(within(firstRow).getByText('R')).toBeInTheDocument()
    expect(within(secondRow).queryByText('R')).not.toBeInTheDocument()

    fireEvent.mouseEnter(secondRow)

    expect(within(secondRow).getByText('R')).toBeInTheDocument()
    expect(within(firstRow).queryByText('R')).not.toBeInTheDocument()
  })

  it('shows the finished sessions shortcut hint on native desktop', () => {
    renderWithQueryClient(<UnreadBell title="Jean" />)

    expect(
      screen.getByText(/(?:⌘|⌃|Ctrl) \+ ⇧|Shift \+ F/i)
    ).toBeInTheDocument()
  })

  it('uses a bell ring animation on the finished-sessions badge by default', () => {
    const { container } = renderWithQueryClient(<UnreadBell title="Jean" />)

    const bell = container.querySelector('svg')
    expect(bell?.getAttribute('class') ?? '').toContain('bell-ring')
    expect(container.querySelector('.finished-session-glow')).toBeNull()
    expect(container.querySelector('.card-border-spin')).toBeNull()
  })

  it('disables the finished-sessions animation when preference is off', () => {
    finishedSessionAnimationEnabled = false
    const { container } = renderWithQueryClient(<UnreadBell title="Jean" />)

    const bell = container.querySelector('svg')
    expect(bell?.getAttribute('class') ?? '').not.toContain('bell-ring')
    expect(container.querySelector('.finished-session-glow')).toBeNull()
    expect(container.querySelector('.card-border-spin')).toBeNull()
    expect(
      screen.getByRole('button', { name: /2 finished sessions/i })
    ).toBeInTheDocument()
  })

  it('hides unread keyboard affordances in web access', async () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_NATIVE__?: boolean }
    ).__JEAN_TEST_IS_NATIVE__ = false

    const user = await openDropdown()

    expect(
      screen.queryByText(/(?:⌘|⌃|Ctrl) \+ (?:⇧|Shift) \+ F/i)
    ).not.toBeInTheDocument()

    const firstRow = screen.getByText('Session one').closest('button')
    if (!firstRow) throw new Error('Expected first unread session row')
    expect(within(firstRow).queryByText('R')).not.toBeInTheDocument()

    await user.keyboard('r')

    expect(invokeMock).not.toHaveBeenCalled()
    expect(screen.getByText('Session one')).toBeInTheDocument()
  })

  it('hides unread keyboard affordances on mobile', async () => {
    ;(
      globalThis as typeof globalThis & { __JEAN_TEST_IS_MOBILE__?: boolean }
    ).__JEAN_TEST_IS_MOBILE__ = true

    const user = await openDropdown()

    expect(
      screen.queryByText(/(?:⌘|⌃|Ctrl) \+ (?:⇧|Shift) \+ F/i)
    ).not.toBeInTheDocument()

    const firstRow = screen.getByText('Session one').closest('button')
    if (!firstRow) throw new Error('Expected first unread session row')
    expect(within(firstRow).queryByText('R')).not.toBeInTheDocument()

    await user.keyboard('r')

    expect(invokeMock).not.toHaveBeenCalled()
    expect(screen.getByText('Session one')).toBeInTheDocument()
  })
})
