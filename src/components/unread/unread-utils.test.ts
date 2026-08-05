import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/chat'
import { isUnreadSession } from './unread-utils'

function session(overrides: Partial<Session>): Session {
  return {
    id: 'session-1',
    worktree_id: 'worktree-1',
    name: 'Code Review',
    created_at: 1,
    updated_at: 2_000,
    last_opened_at: null,
    messages: [],
    archived_at: null,
    backend: 'claude',
    backend_session_id: null,
    claude_session_id: null,
    codex_session_id: null,
    cursor_session_id: null,
    opencode_session_id: null,
    last_run_status: null,
    waiting_for_input: false,
    waiting_for_input_type: null,
    is_reviewing: false,
    ...overrides,
  } as Session
}

describe('isUnreadSession', () => {
  it('treats completed code review sessions as unread even without a run status', () => {
    expect(
      isUnreadSession(
        session({
          review_results: {
            summary: 'Review done',
            findings: [],
            approval_status: 'approved',
          },
        })
      )
    ).toBe(true)
  })

  it('treats pending Codex command approvals as unread even without waiting_for_input (issue #626)', () => {
    expect(
      isUnreadSession(
        session({
          waiting_for_input: false,
          pending_codex_command_approval_requests: [
            {
              rpc_id: 1,
              item_id: 'item-1',
              thread_id: 'thread-1',
              turn_id: 'turn-1',
              command: 'npm test',
            },
          ],
        })
      )
    ).toBe(true)
  })
})
