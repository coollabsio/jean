import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import {
  addTerminalTabForShortcut,
  blurFocusedTerminalForShortcut,
  closeActiveTerminalTabForShortcut,
  closeFocusedTerminalPaneForShortcut,
  findKeybindingAction,
  focusNextTerminalPaneForShortcut,
  getTerminalShortcutWorktreeId,
  isPlainSessionTerminalFocused,
  shouldAllowKeybindingThroughOpenOverlay,
  shouldLetPlanDialogHandleAction,
  splitTerminalForShortcut,
  switchActiveTerminalTabByIndexForShortcut,
} from './useMainWindowEventListeners'
import { collectLeafIds } from '@/lib/terminal-split'
import { DEFAULT_KEYBINDINGS } from '@/types/keybindings'

const { mockInvoke, mockListen, mockDisposeTerminal, isNativeAppMock } =
  vi.hoisted(() => ({
    mockInvoke: vi.fn().mockResolvedValue(undefined),
    mockListen: vi.fn().mockResolvedValue(() => {
      /* noop cleanup */
    }),
    mockDisposeTerminal: vi.fn().mockResolvedValue(undefined),
    isNativeAppMock: vi.fn(() => true),
  }))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
  listen: mockListen,
}))

vi.mock('@/lib/terminal-instances', () => ({
  disposeTerminal: mockDisposeTerminal,
  startHeadless: vi.fn(),
}))

vi.mock('@/lib/environment', async importOriginal => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, isNativeApp: () => isNativeAppMock() }
})

function focusTerminal() {
  document.body.innerHTML = ''

  const terminal = document.createElement('div')
  terminal.className = 'xterm'

  const input = document.createElement('textarea')
  terminal.appendChild(input)
  document.body.appendChild(terminal)

  input.focus()
  return input
}

function focusPlainSessionTerminal() {
  document.body.innerHTML = ''

  const root = document.createElement('div')
  root.setAttribute('data-terminal-surface', 'session')

  const terminal = document.createElement('div')
  terminal.className = 'xterm'

  const input = document.createElement('textarea')
  terminal.appendChild(input)
  root.appendChild(terminal)
  document.body.appendChild(root)

  input.focus()
  return input
}

describe('useMainWindowEventListeners terminal shortcuts', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''

    useChatStore.setState({
      activeWorktreeId: null,
      activeWorktreePath: null,
      activeSessionIds: {},
      reviewResults: {},
      reviewSidebarVisible: false,
      fixedReviewFindings: {},
      worktreePaths: {},
      sendingSessionIds: {},
      sendStartedAt: {},
      waitingForInputSessionIds: {},
      sessionWorktreeMap: {},
      streamingContents: {},
      activeToolCalls: {},
      streamingContentBlocks: {},
      streamingThinkingContent: {},
      inputDrafts: {},
      executionModes: {},
      thinkingLevels: {},
      selectedModels: {},
      answeredQuestions: {},
      submittedAnswers: {},
      errors: {},
      lastSentMessages: {},
      setupScriptResults: {},
      pendingImages: {},
      pendingFiles: {},
      pendingTextFiles: {},
      activeTodos: {},
      fixedFindings: {},
      streamingPlanApprovals: {},
      messageQueues: {},
      executingModes: {},
      approvedTools: {},
      pendingPermissionDenials: {},
      deniedMessageContext: {},
      lastCompaction: {},
      compactingSessions: {},
      reviewingSessions: {},
      sessionLabels: {},
      savingContext: {},
      skippedQuestionSessions: {},
    })

    useTerminalStore.setState({
      terminals: {},
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: false,
      terminalPanelOpen: {},
      terminalHeight: 30,
      modalTerminalOpen: {},
      modalTerminalDockMode: 'floating',
      modalTerminalWidth: 400,
      modalTerminalHeight: 280,
    })

    useUIStore.setState({
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
      loadContextModalOpen: false,
      magicModalOpen: false,
      openInModalOpen: false,
      newWorktreeModalOpen: false,
      commandPaletteOpen: false,
      preferencesOpen: false,
      releaseNotesModalOpen: false,
      updatePrModalOpen: false,
      planDialogOpen: false,
      gitDiffModalOpen: false,
      githubDashboardOpen: false,
      sessionPrimarySurface: {},
      sessionTerminalIds: {},
      newSessionModeTarget: null,
    })
  })

  it('maps Option+Cmd arrow shortcuts to medium chat scroll actions', () => {
    expect(findKeybindingAction('mod+alt+arrowup', DEFAULT_KEYBINDINGS)).toBe(
      'scroll_chat_up_medium'
    )
    expect(findKeybindingAction('mod+alt+arrowdown', DEFAULT_KEYBINDINGS)).toBe(
      'scroll_chat_down_medium'
    )
  })

  it('does not resolve terminal shortcuts when the terminal is open but unfocused', () => {
    useChatStore.setState({ activeWorktreeId: 'canvas-worktree' })
    useTerminalStore.setState({
      terminalPanelOpen: { 'canvas-worktree': true },
      terminalVisible: true,
    })

    expect(getTerminalShortcutWorktreeId()).toBeNull()
  })

  it('resolves terminal shortcuts against the modal worktree', () => {
    focusTerminal()

    useChatStore.setState({ activeWorktreeId: 'canvas-worktree' })
    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'modal-worktree',
    })
    useTerminalStore.setState({
      modalTerminalOpen: { 'modal-worktree': true },
    })

    expect(getTerminalShortcutWorktreeId()).toBe('modal-worktree')
  })

  it('resolves terminal shortcuts when the modal terminal is docked', () => {
    focusTerminal()

    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'modal-worktree',
    })
    useTerminalStore.setState({
      modalTerminalOpen: { 'modal-worktree': true },
      modalTerminalDockMode: 'bottom',
    })

    expect(getTerminalShortcutWorktreeId()).toBe('modal-worktree')
  })

  it('uses the terminal shortcut path to open a new terminal tab for the modal worktree', () => {
    focusTerminal()

    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'modal-worktree',
    })
    useTerminalStore.setState({
      terminals: {
        'modal-worktree': [
          {
            id: 'term-1',
            worktreeId: 'modal-worktree',
            command: null,
            label: 'Shell',
          },
        ],
      },
      activeTerminalIds: { 'modal-worktree': 'term-1' },
      modalTerminalOpen: { 'modal-worktree': true },
      terminalVisible: true,
    })

    expect(addTerminalTabForShortcut()).toBe(true)

    expect(
      useTerminalStore.getState().terminals['modal-worktree']
    ).toHaveLength(2)
  })

  it('lets focused full-screen plain terminal sessions own keybindings', () => {
    focusPlainSessionTerminal()

    useChatStore.setState({ activeWorktreeId: 'worktree-1' })
    useUIStore.setState({
      sessionPrimarySurface: { 'session-1': 'terminal' },
      sessionTerminalIds: { 'session-1': 'term-1' },
    })

    expect(isPlainSessionTerminalFocused()).toBe(true)
    expect(getTerminalShortcutWorktreeId()).toBeNull()
    expect(addTerminalTabForShortcut()).toBe(false)
  })

  it('unfocuses focused full-screen plain terminal sessions for the escape hatch shortcut', () => {
    const input = focusPlainSessionTerminal()

    expect(document.activeElement).toBe(input)
    expect(blurFocusedTerminalForShortcut()).toBe(true)
    expect(document.activeElement).not.toBe(input)
    expect(isPlainSessionTerminalFocused()).toBe(false)
  })

  it('unfocuses focused side terminals for the escape hatch shortcut', () => {
    const input = focusTerminal()

    expect(document.activeElement).toBe(input)
    expect(blurFocusedTerminalForShortcut()).toBe(true)
    expect(document.activeElement).not.toBe(input)
    expect(getTerminalShortcutWorktreeId()).toBeNull()
  })

  it('uses the terminal shortcut path to close the active terminal tab for the modal worktree', () => {
    focusTerminal()

    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'modal-worktree',
    })
    useTerminalStore.setState({
      terminals: {
        'modal-worktree': [
          {
            id: 'term-1',
            worktreeId: 'modal-worktree',
            command: null,
            label: 'Shell',
          },
        ],
      },
      activeTerminalIds: { 'modal-worktree': 'term-1' },
      modalTerminalOpen: { 'modal-worktree': true },
      terminalVisible: true,
    })

    expect(closeActiveTerminalTabForShortcut()).toBe(true)

    expect(mockInvoke).toHaveBeenCalledWith('stop_terminal', {
      terminalId: 'term-1',
    })
    expect(mockDisposeTerminal).toHaveBeenCalledWith('term-1')
    expect(useTerminalStore.getState().terminals['modal-worktree']).toEqual([])
    expect(
      useTerminalStore.getState().modalTerminalOpen['modal-worktree']
    ).toBe(false)
  })

  it('switches the active terminal tab by index for the modal worktree', () => {
    focusTerminal()

    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'modal-worktree',
    })
    useTerminalStore.setState({
      terminals: {
        'modal-worktree': [
          {
            id: 'term-1',
            worktreeId: 'modal-worktree',
            command: null,
            label: 'Shell',
          },
          {
            id: 'term-2',
            worktreeId: 'modal-worktree',
            command: 'bun run dev',
            label: 'dev',
          },
        ],
      },
      groups: {
        'modal-worktree': [
          {
            id: 'gm1',
            layout: { type: 'leaf', terminalId: 'term-1' },
            focusedTerminalId: 'term-1',
          },
          {
            id: 'gm2',
            layout: { type: 'leaf', terminalId: 'term-2' },
            focusedTerminalId: 'term-2',
          },
        ],
      },
      activeGroupIds: { 'modal-worktree': 'gm1' },
      activeTerminalIds: { 'modal-worktree': 'term-1' },
      modalTerminalOpen: { 'modal-worktree': true },
      terminalVisible: true,
    })

    // Tabs are views (groups) now; index 1 = the second view (term-2).
    expect(switchActiveTerminalTabByIndexForShortcut(1)).toBe(true)
    expect(
      useTerminalStore.getState().activeTerminalIds['modal-worktree']
    ).toBe('term-2')
  })

  it('consumes invalid terminal tab indexes without falling back to session switching', () => {
    focusTerminal()

    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'modal-worktree',
    })
    useTerminalStore.setState({
      terminals: {
        'modal-worktree': [
          {
            id: 'term-1',
            worktreeId: 'modal-worktree',
            command: null,
            label: 'Shell',
          },
        ],
      },
      activeTerminalIds: { 'modal-worktree': 'term-1' },
      modalTerminalOpen: { 'modal-worktree': true },
      terminalVisible: true,
    })

    expect(switchActiveTerminalTabByIndexForShortcut(8)).toBe(true)
    expect(
      useTerminalStore.getState().activeTerminalIds['modal-worktree']
    ).toBe('term-1')
  })
})

describe('shouldLetPlanDialogHandleAction', () => {
  it('returns true for approve actions when the plan dialog is open', () => {
    expect(shouldLetPlanDialogHandleAction('approve_plan', true)).toBe(true)
    expect(shouldLetPlanDialogHandleAction('approve_plan_yolo', true)).toBe(
      true
    )
    expect(
      shouldLetPlanDialogHandleAction('approve_plan_worktree_build', true)
    ).toBe(true)
    expect(
      shouldLetPlanDialogHandleAction('approve_plan_worktree_yolo', true)
    ).toBe(true)
  })

  it('returns false for non-approve actions or when the dialog is closed', () => {
    expect(shouldLetPlanDialogHandleAction('open_plan', true)).toBe(false)
    expect(shouldLetPlanDialogHandleAction('approve_plan', false)).toBe(false)
  })
})

describe('dialog overlay keybinding passthrough', () => {
  beforeEach(() => {
    useUIStore.setState({
      gitDiffModalOpen: false,
      openInModalOpen: false,
    })
  })

  it('maps Cmd/Ctrl+O to the Open In action', () => {
    expect(
      findKeybindingAction('mod+o', {
        open_in_modal: 'mod+o',
        open_magic_modal: 'mod+m',
      })
    ).toBe('open_in_modal')
  })

  it('allows Open In through while the git diff modal is open', () => {
    useUIStore.setState({ gitDiffModalOpen: true })

    expect(
      shouldAllowKeybindingThroughOpenOverlay(
        'open_in_modal',
        useUIStore.getState()
      )
    ).toBe(true)
  })

  it('keeps unrelated shortcuts blocked by an open git diff modal', () => {
    useUIStore.setState({ gitDiffModalOpen: true })

    expect(
      shouldAllowKeybindingThroughOpenOverlay(
        'open_magic_modal',
        useUIStore.getState()
      )
    ).toBe(false)
  })

  it('does not allow Open In through other dialogs', () => {
    expect(
      shouldAllowKeybindingThroughOpenOverlay(
        'open_in_modal',
        useUIStore.getState()
      )
    ).toBe(false)
  })
})

describe('terminal split-pane shortcuts', () => {
  const activeLayoutIds = (worktreeId: string): string[] => {
    const s = useTerminalStore.getState()
    const group = (s.groups[worktreeId] ?? []).find(
      g => g.id === s.activeGroupIds[worktreeId]
    )
    return group ? collectLeafIds(group.layout) : []
  }

  beforeEach(() => {
    vi.clearAllMocks()
    isNativeAppMock.mockReturnValue(true)
    document.body.innerHTML = ''

    useChatStore.setState({ activeWorktreeId: 'w1' })
    useUIStore.setState({
      sessionChatModalOpen: false,
      sessionChatModalWorktreeId: null,
    })
    useTerminalStore.setState({
      terminals: {},
      groups: {},
      activeGroupIds: {},
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: true,
      terminalPanelOpen: { w1: true },
      modalTerminalOpen: {},
    })
  })

  it('splits the focused pane (in the active view) on native desktop', () => {
    const a = useTerminalStore.getState().addTerminal('w1')

    expect(splitTerminalForShortcut('horizontal')).toBe(true)

    const ids = activeLayoutIds('w1')
    expect(ids).toHaveLength(2)
    expect(ids[0]).toBe(a)
  })

  it('does not split on web access (non-native)', () => {
    isNativeAppMock.mockReturnValue(false)
    useTerminalStore.getState().addTerminal('w1')

    expect(splitTerminalForShortcut('horizontal')).toBe(false)
    expect(activeLayoutIds('w1')).toHaveLength(1)
  })

  it('does not split when the terminal panel is closed', () => {
    // addTerminal opens the panel, so close it afterwards.
    useTerminalStore.getState().addTerminal('w1')
    useTerminalStore.setState({ terminalPanelOpen: {} })

    expect(splitTerminalForShortcut('horizontal')).toBe(false)
  })

  it('focus_next_pane cycles focus across panes of the active view', () => {
    const a = useTerminalStore.getState().addTerminal('w1')
    const b = useTerminalStore.getState().splitTerminal('w1', 'horizontal')

    // After split the new pane (b) is focused; next wraps to a, then back to b.
    expect(useTerminalStore.getState().activeTerminalIds.w1).toBe(b)
    focusNextTerminalPaneForShortcut()
    expect(useTerminalStore.getState().activeTerminalIds.w1).toBe(a)
    focusNextTerminalPaneForShortcut()
    expect(useTerminalStore.getState().activeTerminalIds.w1).toBe(b)
  })

  it('focus_next_pane is a no-op without a split', () => {
    useTerminalStore.getState().addTerminal('w1')
    expect(focusNextTerminalPaneForShortcut()).toBe(false)
  })

  it('close_terminal_pane stops + disposes the focused pane, view survives', () => {
    const a = useTerminalStore.getState().addTerminal('w1')
    const b = useTerminalStore.getState().splitTerminal('w1', 'horizontal')

    expect(closeFocusedTerminalPaneForShortcut()).toBe(true)

    // PTY stopped + xterm disposed for the focused pane (b).
    expect(mockInvoke).toHaveBeenCalledWith('stop_terminal', {
      terminalId: b,
    })
    expect(mockDisposeTerminal).toHaveBeenCalledWith(b)

    const state = useTerminalStore.getState()
    expect(state.terminals.w1?.map(t => t.id)).toEqual([a])
    // The view stays as a single-pane view focused on the sibling.
    expect(activeLayoutIds('w1')).toEqual([a])
    expect(state.activeTerminalIds.w1).toBe(a)
  })

  it('close_terminal_pane is a no-op for a single-pane view', () => {
    useTerminalStore.getState().addTerminal('w1')
    expect(closeFocusedTerminalPaneForShortcut()).toBe(false)
    expect(mockDisposeTerminal).not.toHaveBeenCalled()
  })
})
