import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import { getRecentSessionStatus } from './recent-session-status'

const session = (values: Partial<Session> = {}): Session =>
  ({
    id: 'session',
    name: 'Session',
    order: 0,
    created_at: 1,
    updated_at: 1,
    messages: [],
    ...values,
  }) as Session

describe('getRecentSessionStatus', () => {
  it('uses waiting, working, and failed priority', () => {
    expect(
      getRecentSessionStatus(session({ last_run_status: 'crashed' }), {
        sending: true,
        waiting: true,
      }).label
    ).toBe('Waiting')
    expect(
      getRecentSessionStatus(session({ last_run_status: 'crashed' }), {
        sending: true,
        waiting: false,
      }).label
    ).toBe('Working')
    expect(
      getRecentSessionStatus(session({ last_run_status: 'crashed' }), {
        sending: false,
        waiting: false,
      }).label
    ).toBe('Failed')
  })

  it.each(['plan', 'build', 'yolo'] as const)(
    'shows idle instead of the previous %s mode after it stops',
    mode => {
      expect(
        getRecentSessionStatus(
          session({
            selected_execution_mode: mode,
            last_run_execution_mode: mode,
          }),
          {
            sending: false,
            waiting: false,
          }
        ).label
      ).toBe('Idle')
    }
  )

  it.each([
    [{ last_run_status: 'cancelled' }, 'Cancelled'],
    [{ status_override: 'review' }, 'Review'],
  ] as const)('shows the current terminal state', (values, label) => {
    expect(
      getRecentSessionStatus(session(values), {
        sending: false,
        waiting: false,
      }).label
    ).toBe(label)
  })

  it.each([
    { last_run_status: 'completed' },
    { status_override: 'completed' },
  ] as const)('marks completed sessions for border styling', values => {
    expect(
      getRecentSessionStatus(session(values), {
        sending: false,
        waiting: false,
      })
    ).toEqual({ label: 'Completed', tone: 'completed' })
  })

  it('treats persisted running and resumable runs as working', () => {
    for (const status of ['running', 'resumable'] as const) {
      expect(
        getRecentSessionStatus(session({ last_run_status: status }), {
          sending: false,
          waiting: false,
        }).label
      ).toBe('Working')
    }
  })
})
