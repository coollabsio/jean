import { describe, it, expect, beforeEach } from 'vitest'
import { useUIStore } from './ui-store'

describe('Command Code CLI update modal', () => {
  beforeEach(() => {
    useUIStore.setState({
      cliUpdateModalOpen: false,
      cliUpdateModalType: null,
    })
  })

  it('accepts commandcode as a CLI update modal type', () => {
    useUIStore.getState().openCliUpdateModal('commandcode')

    expect(useUIStore.getState().cliUpdateModalOpen).toBe(true)
    expect(useUIStore.getState().cliUpdateModalType).toBe('commandcode')
  })
})

describe('UIStore', () => {
  beforeEach(() => {
    // Reset store state before each test
    useUIStore.setState({
      leftSidebarVisible: false,
      rightSidebarVisible: false,
      commandPaletteOpen: false,
      preferencesOpen: false,
      autoOpenSessionWorktreeIds: new Set(),
      pendingAutoOpenSessionIds: {},
    })
  })

  it('has correct initial state', () => {
    const state = useUIStore.getState()
    expect(state.leftSidebarVisible).toBe(false)
    expect(state.rightSidebarVisible).toBe(false)
    expect(state.commandPaletteOpen).toBe(false)
    expect(state.preferencesOpen).toBe(false)
  })

  it('toggles left sidebar visibility', () => {
    const { toggleLeftSidebar } = useUIStore.getState()

    toggleLeftSidebar()
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)

    toggleLeftSidebar()
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
  })

  it('sets left sidebar visibility directly', () => {
    const { setLeftSidebarVisible } = useUIStore.getState()

    setLeftSidebarVisible(false)
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)

    setLeftSidebarVisible(true)
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('toggles preferences dialog', () => {
    const { togglePreferences } = useUIStore.getState()

    togglePreferences()
    expect(useUIStore.getState().preferencesOpen).toBe(true)

    togglePreferences()
    expect(useUIStore.getState().preferencesOpen).toBe(false)
  })

  it('toggles command palette', () => {
    const { toggleCommandPalette } = useUIStore.getState()

    toggleCommandPalette()
    expect(useUIStore.getState().commandPaletteOpen).toBe(true)

    toggleCommandPalette()
    expect(useUIStore.getState().commandPaletteOpen).toBe(false)
  })

  it('queues and consumes explicit auto-open session requests', () => {
    const store = useUIStore.getState()

    store.markWorktreeForAutoOpenSession('worktree-1', 'session-1')

    const queuedState = useUIStore.getState()
    expect(queuedState.autoOpenSessionWorktreeIds.has('worktree-1')).toBe(true)
    expect(queuedState.pendingAutoOpenSessionIds['worktree-1']).toBe(
      'session-1'
    )

    expect(store.consumeAutoOpenSession('worktree-1')).toEqual({
      shouldOpen: true,
      sessionId: 'session-1',
    })

    const consumedState = useUIStore.getState()
    expect(consumedState.autoOpenSessionWorktreeIds.has('worktree-1')).toBe(
      false
    )
    expect(
      consumedState.pendingAutoOpenSessionIds['worktree-1']
    ).toBeUndefined()
  })

  it('does not notify subscribers for duplicate auto-open session requests', () => {
    const store = useUIStore.getState()
    let notifications = 0
    const unsubscribe = useUIStore.subscribe(() => {
      notifications += 1
    })

    store.markWorktreeForAutoOpenSession('worktree-1', 'session-1')
    store.markWorktreeForAutoOpenSession('worktree-1', 'session-1')

    unsubscribe()
    expect(notifications).toBe(1)
  })

  it('tracks app update ready / installing lifecycle without no-op churn', () => {
    const {
      setUpdateReadyVersion,
      setIsUpdateInstalling,
      setPendingUpdateVersion,
    } = useUIStore.getState()

    setIsUpdateInstalling(true)
    expect(useUIStore.getState().isUpdateInstalling).toBe(true)
    setIsUpdateInstalling(true) // no-op guard
    setPendingUpdateVersion('1.2.3')
    setIsUpdateInstalling(false)
    setUpdateReadyVersion('1.2.3')
    setPendingUpdateVersion(null)

    expect(useUIStore.getState()).toMatchObject({
      isUpdateInstalling: false,
      updateReadyVersion: '1.2.3',
      pendingUpdateVersion: null,
    })

    setUpdateReadyVersion('1.2.3') // no-op guard
    expect(useUIStore.getState().updateReadyVersion).toBe('1.2.3')
  })
})
