import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserStore } from './browser-store'

describe('BrowserStore', () => {
  beforeEach(() => {
    useBrowserStore.setState({
      tabs: {},
      activeTabIds: {},
      sidePaneOpen: {},
      modalOpen: {},
      bottomPanelOpen: {},
    })
  })

  it('evicts all worktree browser state and preserves other worktrees', () => {
    const firstTab = useBrowserStore.getState().addTab('worktree-1')
    const secondTab = useBrowserStore.getState().addTab('worktree-1')
    const retainedTab = useBrowserStore.getState().addTab('worktree-2')
    useBrowserStore.getState().setSidePaneOpen('worktree-1', true)
    useBrowserStore.getState().setModalOpen('worktree-1', true)
    useBrowserStore.getState().setBottomPanelOpen('worktree-1', true)

    const removed = useBrowserStore
      .getState()
      .clearWorktreeState('worktree-1')

    expect(removed).toEqual([firstTab, secondTab])
    expect(useBrowserStore.getState().getTabs('worktree-1')).toEqual([])
    expect(useBrowserStore.getState().getTabs('worktree-2')).toHaveLength(1)
    expect(useBrowserStore.getState().getTabs('worktree-2')[0]?.id).toBe(
      retainedTab
    )
    expect(useBrowserStore.getState().activeTabIds).not.toHaveProperty(
      'worktree-1'
    )
    expect(useBrowserStore.getState().sidePaneOpen).not.toHaveProperty(
      'worktree-1'
    )
    expect(useBrowserStore.getState().modalOpen).not.toHaveProperty(
      'worktree-1'
    )
    expect(useBrowserStore.getState().bottomPanelOpen).not.toHaveProperty(
      'worktree-1'
    )
  })

  it('is a no-op for an unknown worktree', () => {
    const before = useBrowserStore.getState()

    expect(useBrowserStore.getState().clearWorktreeState('missing')).toEqual(
      []
    )
    expect(useBrowserStore.getState()).toBe(before)
  })
})
