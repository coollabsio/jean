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
    expect(state.seenFailedWorkflowRunIds).toEqual([])
  })

  it('marks failed workflow runs as seen without no-op churn', () => {
    useUIStore.setState({ seenFailedWorkflowRunIds: [] })
    const { markFailedWorkflowRunsSeen } = useUIStore.getState()

    markFailedWorkflowRunsSeen([10, 20])
    expect(useUIStore.getState().seenFailedWorkflowRunIds).toEqual([10, 20])

    const before = useUIStore.getState().seenFailedWorkflowRunIds
    markFailedWorkflowRunsSeen([10, 20])
    expect(useUIStore.getState().seenFailedWorkflowRunIds).toBe(before)

    markFailedWorkflowRunsSeen([30])
    expect(useUIStore.getState().seenFailedWorkflowRunIds).toEqual([30, 10, 20])
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

  it('toggles file browser visibility', () => {
    useUIStore.setState({ fileBrowserVisible: false })
    const { toggleFileBrowser } = useUIStore.getState()

    toggleFileBrowser()
    expect(useUIStore.getState().fileBrowserVisible).toBe(true)

    toggleFileBrowser()
    expect(useUIStore.getState().fileBrowserVisible).toBe(false)
  })

  it('toggles zen mode and restores sidebars', () => {
    useUIStore.setState({
      zenMode: false,
      leftSidebarVisible: true,
      fileBrowserVisible: true,
    })

    useUIStore.getState().toggleZenMode()
    expect(useUIStore.getState().zenMode).toBe(true)
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
    expect(useUIStore.getState().fileBrowserVisible).toBe(false)

    useUIStore.getState().toggleZenMode()
    expect(useUIStore.getState().zenMode).toBe(false)
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
    expect(useUIStore.getState().fileBrowserVisible).toBe(true)
  })

  it('setZenMode is a no-op when already at the target value', () => {
    useUIStore.setState({ zenMode: false, leftSidebarVisible: true })
    const before = useUIStore.getState()
    useUIStore.getState().setZenMode(false)
    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
    expect(useUIStore.getState().zenMode).toBe(before.zenMode)
  })

  it('sets viewing file path for global file modal', () => {
    useUIStore.getState().setViewingFilePath('/tmp/foo.ts')
    expect(useUIStore.getState().viewingFilePath).toBe('/tmp/foo.ts')
    useUIStore.getState().setViewingFilePath(null)
    expect(useUIStore.getState().viewingFilePath).toBeNull()
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
