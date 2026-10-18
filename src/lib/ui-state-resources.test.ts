import { describe, expect, it } from 'vitest'
import { defaultUIState } from '@/types/ui-state'
import {
  scopeUIStateResources,
  unscopeUIStateResources,
} from './ui-state-resources'

describe('remote UI-state resources', () => {
  const legacyState = {
    ...defaultUIState,
    active_worktree_id: 'worktree-1',
    last_active_worktree_id: 'worktree-1',
    active_project_id: 'project-1',
    active_session_ids: { 'worktree-1': 'session-1' },
    input_drafts: { 'session-1': 'recover this draft' },
    pending_images: { 'session-1': [] },
    pending_files: { 'session-1': [] },
    dismissed_setup_scripts: ['worktree-1'],
    pinned_recent_session_ids: ['session-1'],
    last_opened_per_project: {
      'project-1': { worktree_id: 'worktree-1', session_id: 'session-1' },
    },
  }

  it('scopes legacy draft keys to the remote session identities used by the UI', () => {
    expect(scopeUIStateResources(legacyState, 'remote')).toEqual(
      expect.objectContaining({
        active_worktree_id: 'remote:worktree-1',
        active_project_id: 'remote:project-1',
        active_session_ids: { 'remote:worktree-1': 'remote:session-1' },
        input_drafts: { 'remote:session-1': 'recover this draft' },
        pending_images: { 'remote:session-1': [] },
        pending_files: { 'remote:session-1': [] },
        dismissed_setup_scripts: ['remote:worktree-1'],
        pinned_recent_session_ids: ['remote:session-1'],
        last_opened_per_project: {
          'remote:project-1': {
            worktree_id: 'remote:worktree-1',
            session_id: 'remote:session-1',
          },
        },
      })
    )
  })

  it('is idempotent and writes matching remote identities back as raw ids', () => {
    const scoped = scopeUIStateResources(legacyState, 'remote')
    expect(scopeUIStateResources(scoped, 'remote')).toEqual(scoped)
    expect(unscopeUIStateResources(scoped, 'remote')).toEqual(legacyState)
  })

  it('does not remove identities owned by another server', () => {
    const state = {
      ...legacyState,
      input_drafts: { 'other:session-2': 'other draft' },
    }
    expect(unscopeUIStateResources(state, 'remote').input_drafts).toEqual({
      'other:session-2': 'other draft',
    })
  })
})
