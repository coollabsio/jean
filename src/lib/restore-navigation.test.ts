import { beforeEach, describe, expect, it } from 'vitest'
import { navigateToProjectPicker } from './restore-navigation'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

describe('navigateToProjectPicker', () => {
  beforeEach(() => {
    useChatStore.setState({
      activeWorktreeId: 'wt-1',
      activeWorktreePath: '/tmp/wt-1',
      activeSessionIds: { 'wt-1': 'session-1', 'wt-2': 'session-2' },
    })
    useProjectsStore.setState({
      selectedProjectId: 'project-1',
      selectedWorktreeId: 'wt-1',
    })
    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'wt-1',
    })
  })

  it('clears worktree, project selection, and session modal', () => {
    navigateToProjectPicker('wt-1')

    const chat = useChatStore.getState()
    expect(chat.activeWorktreeId).toBeNull()
    expect(chat.activeWorktreePath).toBeNull()
    expect(chat.activeSessionIds['wt-1']).toBeUndefined()
    expect(chat.activeSessionIds['wt-2']).toBe('session-2')

    const projects = useProjectsStore.getState()
    expect(projects.selectedProjectId).toBeNull()
    expect(projects.selectedWorktreeId).toBeNull()

    const ui = useUIStore.getState()
    expect(ui.sessionChatModalOpen).toBe(false)
    expect(ui.sessionChatModalWorktreeId).toBeNull()
  })

  it('works without a worktreeId', () => {
    navigateToProjectPicker()

    expect(useChatStore.getState().activeWorktreeId).toBeNull()
    expect(useProjectsStore.getState().selectedProjectId).toBeNull()
    // Does not clear session map entries when worktreeId omitted
    expect(useChatStore.getState().activeSessionIds['wt-1']).toBe('session-1')
  })
})
