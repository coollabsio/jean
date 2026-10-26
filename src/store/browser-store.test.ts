import { beforeEach, describe, expect, it } from 'vitest'
import { useBrowserStore } from './browser-store'
import { useTerminalStore } from './terminal-store'

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

    const removed = useBrowserStore.getState().clearWorktreeState('worktree-1')

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

    expect(useBrowserStore.getState().clearWorktreeState('missing')).toEqual([])
    expect(useBrowserStore.getState()).toBe(before)
  })
})

describe('toggleBrowserSurface', () => {
  beforeEach(() => {
    useBrowserStore.setState({
      tabs: {},
      activeTabIds: {},
      sidePaneOpen: {},
      modalOpen: {},
      bottomPanelOpen: {},
    })
    useTerminalStore.setState({
      modalTerminalOpen: {},
    })
  })

  it('cycles the main window through the side pane, then the bottom panel', () => {
    useBrowserStore.getState().setSidePaneOpen('other', true)

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', false)

    expect(useBrowserStore.getState().sidePaneOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBeFalsy()
    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBeFalsy()
    expect(useBrowserStore.getState().sidePaneOpen.other).toBe(true)

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', false)

    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().sidePaneOpen['worktree-1']).toBe(false)
    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBeFalsy()
    expect(useBrowserStore.getState().sidePaneOpen.other).toBe(true)

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', false)

    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBe(false)
    expect(useBrowserStore.getState().sidePaneOpen['worktree-1']).toBe(false)
    expect(useBrowserStore.getState().sidePaneOpen.other).toBe(true)
  })

  it('opens the side pane when a stale modal is the only open surface', () => {
    useBrowserStore.getState().setModalOpen('worktree-1', true)

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', false)

    expect(useBrowserStore.getState().sidePaneOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(false)
    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBeFalsy()
  })

  it('cycles session chat through the modal drawer, then the bottom panel', () => {
    useBrowserStore.getState().toggleBrowserSurface('worktree-1', true)

    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBeFalsy()
    expect(useBrowserStore.getState().sidePaneOpen['worktree-1']).toBeFalsy()

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', true)

    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(false)
    expect(useBrowserStore.getState().sidePaneOpen['worktree-1']).toBe(false)

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', true)

    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBe(false)
    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(false)
  })

  it('keeps the first session-chat press on the modal when the side pane is open', () => {
    useBrowserStore.getState().setSidePaneOpen('worktree-1', true)

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', true)

    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().sidePaneOpen['worktree-1']).toBe(false)
    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBeFalsy()
  })

  it('closes the terminal modal when opening the bottom panel or the modal drawer', () => {
    useBrowserStore.getState().setSidePaneOpen('worktree-1', true)
    useTerminalStore.setState({
      modalTerminalOpen: { 'worktree-1': true, other: true },
    })

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', false)

    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().sidePaneOpen['worktree-1']).toBe(false)
    expect(useTerminalStore.getState().modalTerminalOpen['worktree-1']).toBe(
      false
    )
    expect(useTerminalStore.getState().modalTerminalOpen.other).toBe(true)

    useBrowserStore.getState().toggleBrowserSurface('worktree-1', false)
    useTerminalStore.setState({
      modalTerminalOpen: { 'worktree-1': true },
    })
    useBrowserStore.getState().toggleBrowserSurface('worktree-1', true)

    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBe(false)
    expect(useTerminalStore.getState().modalTerminalOpen['worktree-1']).toBe(
      false
    )

    useTerminalStore.setState({
      modalTerminalOpen: { 'worktree-1': true },
    })
    useBrowserStore.getState().toggleBrowserSurface('worktree-1', true)

    expect(useBrowserStore.getState().bottomPanelOpen['worktree-1']).toBe(true)
    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(false)
    expect(useTerminalStore.getState().modalTerminalOpen['worktree-1']).toBe(
      false
    )
  })
})
