import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { blankTabUrl, useBrowserStore } from './browser-store'
import { useTerminalStore } from './terminal-store'
import { useUIStore } from './ui-store'
import { useChatStore } from './chat-store'

describe('BrowserStore', () => {
  beforeEach(() => {
    useBrowserStore.setState({
      tabs: {},
      activeTabIds: {},
      modalOpen: {},
    })
  })

  it('evicts all worktree browser state and preserves other worktrees', () => {
    const firstTab = useBrowserStore.getState().addTab('worktree-1')
    const secondTab = useBrowserStore.getState().addTab('worktree-1')
    const retainedTab = useBrowserStore.getState().addTab('worktree-2')
    useBrowserStore.getState().setModalOpen('worktree-1', true)

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
    expect(useBrowserStore.getState().modalOpen).not.toHaveProperty(
      'worktree-1'
    )
  })

  it('is a no-op for an unknown worktree', () => {
    const before = useBrowserStore.getState()

    expect(useBrowserStore.getState().clearWorktreeState('missing')).toEqual([])
    expect(useBrowserStore.getState()).toBe(before)
  })
})

describe('blankTabUrl', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty('--background')
  })

  it('paints the blank page with the app background, encoded so # survives', () => {
    document.documentElement.style.setProperty('--background', '#101010')

    const url = blankTabUrl()

    expect(url.startsWith('data:text/html;charset=utf-8,')).toBe(true)
    expect(url).not.toContain('#')
    expect(decodeURIComponent(url.split(',')[1] ?? '')).toContain(
      'background:#101010'
    )
  })
})

describe('right panel browser tab (desktop)', () => {
  beforeEach(() => {
    useBrowserStore.setState({ modalOpen: {} })
    useTerminalStore.setState({ modalTerminalOpen: {} })
    useChatStore.setState({ activeWorktreeId: 'worktree-1' })
    useUIStore.setState({
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
      fileBrowserVisible: false,
      rightPanelTab: 'files',
    })
  })

  it('toggles the right panel on the browser tab', () => {
    useBrowserStore.getState().toggleModal('worktree-1')

    expect(useUIStore.getState().fileBrowserVisible).toBe(true)
    expect(useUIStore.getState().rightPanelTab).toBe('browser')
    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(true)

    useBrowserStore.getState().toggleModal('worktree-1')

    expect(useUIStore.getState().fileBrowserVisible).toBe(false)
    expect(useBrowserStore.getState().modalOpen['worktree-1']).toBe(false)
  })

  it('switches to the browser tab when the panel shows another tab', () => {
    useUIStore.setState({ fileBrowserVisible: true, rightPanelTab: 'files' })
    useBrowserStore.setState({ modalOpen: { 'worktree-1': true } })

    useBrowserStore.getState().toggleModal('worktree-1')

    expect(useUIStore.getState().fileBrowserVisible).toBe(true)
    expect(useUIStore.getState().rightPanelTab).toBe('browser')
  })

  it('keeps the panel open when another worktree closes its browser', () => {
    useUIStore.setState({ fileBrowserVisible: true, rightPanelTab: 'browser' })
    useBrowserStore.setState({ modalOpen: { other: true } })

    useBrowserStore.getState().setModalOpen('other', false)

    expect(useUIStore.getState().fileBrowserVisible).toBe(true)
  })
})
