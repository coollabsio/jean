import { describe, expect, it } from 'vitest'
import type { AllSessionsEntry, Session } from '@/types/chat'
import { filterLoadContextSessions } from './load-context-sessions'

function session(overrides: Partial<Session> & { id: string }): Session {
  return {
    name: overrides.id,
    order: 0,
    created_at: 0,
    updated_at: 0,
    messages: [],
    ...overrides,
  } as Session
}

const entry: AllSessionsEntry = {
  project_id: 'project-1',
  project_name: 'Jean',
  worktree_id: 'worktree-1',
  worktree_name: 'main',
  worktree_path: '/projects/jean',
  sessions: [
    session({ id: 'with-history', name: 'Parser work', message_count: 2 }),
    session({ id: 'empty', message_count: 0 }),
  ],
}

describe('filterLoadContextSessions', () => {
  it('uses metadata counts when session message bodies are not loaded', () => {
    const result = filterLoadContextSessions([entry], {
      searchQuery: '',
      activeSessionId: null,
      attachedSlugs: new Set(),
    })

    expect(result[0]?.sessions.map(item => item.id)).toEqual(['with-history'])
  })

  it('includes sessions matched by the backend content search', () => {
    const result = filterLoadContextSessions([entry], {
      searchQuery: 'database migration',
      activeSessionId: null,
      attachedSlugs: new Set(),
      contentMatchIds: new Set(['with-history']),
    })

    expect(result[0]?.sessions.map(item => item.id)).toEqual(['with-history'])
  })
})
