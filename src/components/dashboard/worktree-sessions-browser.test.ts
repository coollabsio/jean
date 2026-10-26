import { describe, expect, it, vi } from 'vitest'
import type {
  SessionCardData,
  SessionStatus,
} from '@/components/chat/session-card-utils'
import type { Session } from '@/types/chat'
import {
  BROWSE_WORKTREE_SESSIONS_EVENT,
  SESSION_BROWSER_STATUS_BUCKET,
  cycleSessionBrowserFilter,
  dispatchBrowseWorktreeSessions,
  filterSessionBrowserCards,
  formatSessionBrowserTime,
  getSessionBrowserFilterTabs,
  getSessionBrowserStatusLabels,
  visibleSessionBrowserCards,
} from './worktree-sessions-browser'

function card(
  partial: Omit<Partial<SessionCardData>, 'session'> & {
    status: SessionStatus
    session?: Partial<Session>
  }
): SessionCardData {
  const { session, ...rest } = partial
  return {
    session: {
      id: 'session',
      name: 'Session',
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

describe('session browser status labels', () => {
  it('shows live agent activity when it differs from the session status', () => {
    expect(
      getSessionBrowserStatusLabels(
        card({
          status: 'review',
          automaticStatus: 'idle',
          statusOverride: 'review',
        })
      )
    ).toEqual({
      statusLabel: 'Review ready',
      agentStatusLabel: 'Idle',
    })
  })

  it('keeps a single status when the agent is already in that state', () => {
    expect(
      getSessionBrowserStatusLabels(
        card({ status: 'planning', automaticStatus: 'planning' })
      )
    ).toEqual({
      statusLabel: 'Planning',
      agentStatusLabel: null,
    })
  })
})

describe('session browser filters', () => {
  const now = 1_700_000_000_000
  const cards = [
    card({
      status: 'review',
      automaticStatus: 'idle',
      label: { name: 'Needs testing', color: '#22c55e' },
      session: {
        id: 'review',
        name: 'Review the diff',
        updated_at: 1_699_000_000,
        backend: 'claude',
      },
    }),
    card({
      status: 'planning',
      session: {
        id: 'plan',
        name: 'Plan the auth flow',
        updated_at: 1_699_900_000,
        backend: 'codex',
      },
    }),
    card({
      status: 'idle',
      session: {
        id: 'archived',
        name: 'Old plan',
        archived_at: 10,
        updated_at: 1_699_950_000,
      },
    }),
  ]

  it('files every session status into one browser bucket', () => {
    const statuses = Object.keys(
      SESSION_BROWSER_STATUS_BUCKET
    ) as SessionStatus[]
    expect(new Set(statuses)).toEqual(
      new Set([
        'idle',
        'planning',
        'vibing',
        'yoloing',
        'reviewing',
        'waiting',
        'plan_approval',
        'input_required',
        'permission',
        'command_approval',
        'mcp_input',
        'tool_approval',
        'scheduled',
        'review',
        'completed',
        'cancelled',
        'crashed',
      ])
    )
  })

  it('hides archived sessions and sorts the rest by recent activity', () => {
    const visible = visibleSessionBrowserCards(cards)
    expect(
      filterSessionBrowserCards(visible, 'all', '').map(item => item.session.id)
    ).toEqual(['plan', 'review'])
  })

  it('filters by status, label, and search text', () => {
    const visible = visibleSessionBrowserCards(cards)
    expect(
      filterSessionBrowserCards(visible, 'in_progress', '').map(
        item => item.session.id
      )
    ).toEqual(['plan'])
    expect(
      filterSessionBrowserCards(visible, 'label:Needs testing', '').map(
        item => item.session.id
      )
    ).toEqual(['review'])
    expect(
      filterSessionBrowserCards(visible, 'all', 'codex').map(
        item => item.session.name
      )
    ).toEqual(['Plan the auth flow'])
    expect(
      filterSessionBrowserCards(visible, 'all', 'review ready').map(
        item => item.session.id
      )
    ).toEqual(['review'])
  })

  it('counts status and label tabs from visible sessions', () => {
    expect(
      getSessionBrowserFilterTabs(visibleSessionBrowserCards(cards))
    ).toEqual([
      { key: 'all', label: 'All', count: 2 },
      { key: 'waiting', label: 'Waiting', count: 0 },
      { key: 'in_progress', label: 'In progress', count: 1 },
      { key: 'review', label: 'Review', count: 1 },
      { key: 'idle', label: 'Idle', count: 0 },
      {
        key: 'label:Needs testing',
        label: 'Needs testing',
        count: 1,
        color: '#22c55e',
      },
    ])
  })

  it('cycles filter tabs from the ends', () => {
    const tabs = getSessionBrowserFilterTabs(visibleSessionBrowserCards(cards))
    expect(cycleSessionBrowserFilter(tabs, 'all', -1)).toBe(
      'label:Needs testing'
    )
    expect(cycleSessionBrowserFilter(tabs, 'label:Needs testing', 1)).toBe(
      'all'
    )
  })

  it('formats second and millisecond activity times', () => {
    expect(formatSessionBrowserTime(undefined, now)).toBeNull()
    expect(formatSessionBrowserTime(now / 1000 - 120, now)).toBe('2m ago')
    expect(formatSessionBrowserTime(now - 3 * 60 * 60 * 1000, now)).toBe(
      '3h ago'
    )
  })
})

describe('dispatchBrowseWorktreeSessions', () => {
  it('emits once immediately and again after the canvas can remount', () => {
    vi.useFakeTimers()
    const detail = {
      projectId: 'project-1',
      worktreeId: 'wt-1',
      worktreePath: '/tmp/wt-1',
    }
    const events: BrowseDetail[] = []
    const listener = (event: Event) => {
      events.push((event as CustomEvent<BrowseDetail>).detail)
    }
    window.addEventListener(BROWSE_WORKTREE_SESSIONS_EVENT, listener)

    dispatchBrowseWorktreeSessions(detail)
    expect(events).toEqual([detail])
    vi.advanceTimersByTime(50)
    expect(events).toEqual([detail, detail])

    window.removeEventListener(BROWSE_WORKTREE_SESSIONS_EVENT, listener)
    vi.useRealTimers()
  })
})

interface BrowseDetail {
  projectId: string
  worktreeId: string
  worktreePath: string
}
