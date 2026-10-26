import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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

describe('minimized CLI updates', () => {
  beforeEach(() => {
    useUIStore.setState({ minimizedCliUpdate: null })
  })

  it('stores progress and restores the active modal', () => {
    const store = useUIStore.getState()
    store.openCliUpdateModal('codex')
    store.setMinimizedCliUpdate({
      type: 'codex',
      name: 'Codex CLI',
      target: 'Local',
      kind: 'reinstall',
      progress: 25,
    })

    store.updateMinimizedCliUpdateProgress(60)
    expect(useUIStore.getState().minimizedCliUpdate?.progress).toBe(60)

    store.restoreMinimizedCliUpdate()
    expect(useUIStore.getState().minimizedCliUpdate).toBeNull()
    expect(useUIStore.getState().cliUpdateModalOpen).toBe(true)
  })

  it('clears minimized state when the active update closes', () => {
    useUIStore.getState().setMinimizedCliUpdate({
      type: 'gh',
      name: 'GitHub CLI',
      target: 'Local',
      kind: 'terminal',
      progress: null,
    })

    useUIStore.getState().closeCliLoginModal()
    expect(useUIStore.getState().minimizedCliUpdate).toBeNull()
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

  it('evicts worktree and session keyed UI state when a worktree is removed', () => {
    useUIStore.setState({
      autoInvestigateWorktreeIds: new Set(['worktree-1', 'worktree-2']),
      autoInvestigatePRWorktreeIds: new Set(['worktree-1', 'worktree-2']),
      autoInvestigateSecurityAlertWorktreeIds: new Set([
        'worktree-1',
        'worktree-2',
      ]),
      autoInvestigateAdvisoryWorktreeIds: new Set(['worktree-1', 'worktree-2']),
      autoInvestigateLinearIssueWorktreeIds: new Set([
        'worktree-1',
        'worktree-2',
      ]),
      autoInvestigateSentryIssueWorktreeIds: new Set([
        'worktree-1',
        'worktree-2',
      ]),
      autoOpenSessionWorktreeIds: new Set(['worktree-1', 'worktree-2']),
      pendingAutoOpenSessionIds: {
        'worktree-1': 'session-1',
        'worktree-2': 'session-2',
      },
      sessionPrimarySurface: {
        'session-1': 'terminal',
        'session-2': 'chat',
      },
      sessionTerminalIds: {
        'session-1': 'terminal-1',
        'session-2': 'terminal-2',
      },
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'worktree-1',
      newSessionModeTarget: {
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree-1',
        origin: 'canvas',
      },
    })

    useUIStore.getState().clearWorktreeState('worktree-1', ['session-1'])

    const state = useUIStore.getState()
    expect(state.autoInvestigateWorktreeIds).toEqual(new Set(['worktree-2']))
    expect(state.autoInvestigatePRWorktreeIds).toEqual(new Set(['worktree-2']))
    expect(state.autoInvestigateSecurityAlertWorktreeIds).toEqual(
      new Set(['worktree-2'])
    )
    expect(state.autoInvestigateAdvisoryWorktreeIds).toEqual(
      new Set(['worktree-2'])
    )
    expect(state.autoInvestigateLinearIssueWorktreeIds).toEqual(
      new Set(['worktree-2'])
    )
    expect(state.autoInvestigateSentryIssueWorktreeIds).toEqual(
      new Set(['worktree-2'])
    )
    expect(state.autoOpenSessionWorktreeIds).toEqual(new Set(['worktree-2']))
    expect(state.pendingAutoOpenSessionIds).toEqual({
      'worktree-2': 'session-2',
    })
    expect(state.sessionPrimarySurface).toEqual({ 'session-2': 'chat' })
    expect(state.sessionTerminalIds).toEqual({ 'session-2': 'terminal-2' })
    expect(state.sessionChatModalOpen).toBe(false)
    expect(state.sessionChatModalWorktreeId).toBeNull()
    expect(state.newSessionModeTarget).toBeNull()
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

describe('MCP login context', () => {
  beforeEach(() => useUIStore.getState().closeCliLoginModal())

  it('clears the MCP target when the modal closes', () => {
    useUIStore
      .getState()
      .openCliLoginModal('claude', '/cli', ['mcp', 'login'], 'login', {
        serverName: 'orbit-dev',
        worktreePath: '/repo',
        serverId: 'remote',
      })
    expect(useUIStore.getState().cliLoginModalMcpContext?.serverId).toBe(
      'remote'
    )
    useUIStore.getState().closeCliLoginModal()
    expect(useUIStore.getState().cliLoginModalMcpContext).toBeNull()
  })

  it('never carries an MCP directory or owner into a normal CLI login', () => {
    useUIStore
      .getState()
      .openCliLoginModal('claude', '/cli', ['mcp', 'login'], 'login', {
        serverName: 'orbit-dev',
        worktreePath: '/repo',
        serverId: 'remote',
      })
    useUIStore.getState().openCliLoginModal('codex', '/cli', ['login'])
    expect(useUIStore.getState().cliLoginModalMcpContext).toBeNull()
  })
})

describe('mobile left sidebar closes when a surface opens over it', () => {
  const desktopWidth = window.innerWidth

  function setViewportWidth(width: number) {
    Object.defineProperty(window, 'innerWidth', {
      value: width,
      configurable: true,
      writable: true,
    })
  }

  beforeEach(() => {
    useUIStore.setState({
      leftSidebarVisible: true,
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
      newWorktreeModalOpen: false,
      preferencesOpen: false,
      preferencesPane: null,
    })
  })

  afterEach(() => {
    setViewportWidth(desktopWidth)
  })

  it.each([
    [
      'session chat modal',
      () => useUIStore.getState().setSessionChatModalOpen(true, 'wt-1'),
    ],
    [
      'new worktree modal',
      () => useUIStore.getState().setNewWorktreeModalOpen(true),
    ],
    ['preferences', () => useUIStore.getState().setPreferencesOpen(true)],
    [
      'preferences pane',
      () => useUIStore.getState().openPreferencesPane('general'),
    ],
    ['preferences toggle', () => useUIStore.getState().togglePreferences()],
  ])('closes it on mobile when opening the %s', (_, open) => {
    setViewportWidth(390)

    open()

    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
  })

  it('keeps it open on desktop', () => {
    setViewportWidth(1280)

    useUIStore.getState().setSessionChatModalOpen(true, 'wt-1')
    useUIStore.getState().setNewWorktreeModalOpen(true)
    useUIStore.getState().openPreferencesPane('general')

    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
    expect(useUIStore.getState().sessionChatModalOpen).toBe(true)
    expect(useUIStore.getState().sessionChatModalWorktreeId).toBe('wt-1')
  })

  it('keeps it open on mobile when a surface closes', () => {
    setViewportWidth(390)
    useUIStore.setState({ sessionChatModalOpen: true })

    useUIStore.getState().setSessionChatModalOpen(false)
    useUIStore.getState().setNewWorktreeModalOpen(false)
    useUIStore.getState().setPreferencesOpen(false)

    expect(useUIStore.getState().leftSidebarVisible).toBe(true)
  })

  it('does not notify subscribers when reopening an already-open modal', () => {
    setViewportWidth(1280)
    useUIStore.getState().setSessionChatModalOpen(true, 'wt-1')
    const before = useUIStore.getState()

    useUIStore.getState().setSessionChatModalOpen(true, 'wt-1')

    expect(useUIStore.getState()).toBe(before)
  })
})

describe('rail section sidebar visibility', () => {
  beforeEach(() => {
    useUIStore.setState({
      railSection: 'workspace',
      railSidebarVisible: {},
      leftSidebarVisible: false,
    })
  })

  it('restores each section sidebar state when switching back', () => {
    const ui = () => useUIStore.getState()
    // Workspace collapsed; Agents never opened, so its panel shows
    ui().setRailSection('agents', true)
    expect(ui().leftSidebarVisible).toBe(true)

    ui().setRailSection('workspace', true)
    expect(ui().leftSidebarVisible).toBe(false)

    ui().setRailSection('agents', true)
    expect(ui().leftSidebarVisible).toBe(true)
  })

  it('keeps sidebar visibility when restore is off', () => {
    useUIStore.getState().setRailSection('agents')
    expect(useUIStore.getState().leftSidebarVisible).toBe(false)
    expect(useUIStore.getState().railSidebarVisible.workspace).toBe(false)
  })
})
