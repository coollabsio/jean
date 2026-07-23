import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { QueryClient } from '@tanstack/react-query'
import {
  addTerminalTabForShortcut,
  allowsKeybindingRepeat,
  applyCacheInvalidationKeys,
  applySessionRenamedToCaches,
  blurFocusedTerminalForShortcut,
  closeActiveTerminalTabForShortcut,
  findKeybindingAction,
  getTerminalShortcutWorktreeId,
  isPlainSessionTerminalFocused,
  shouldAllowKeybindingThroughOpenOverlay,
  shouldLetPlanDialogHandleAction,
  switchActiveTerminalTabByIndexForShortcut,
} from './useMainWindowEventListeners'
import { chatQueryKeys } from '@/services/chat'
import { projectsQueryKeys } from '@/services/projects'
import { DEFAULT_KEYBINDINGS } from '@/types/keybindings'
import type {
  AllSessionsResponse,
  Session,
  WorktreeSessions,
} from '@/types/chat'

const { mockInvoke, mockListen, mockDisposeTerminal } = vi.hoisted(() => ({
  mockInvoke: vi.fn().mockResolvedValue(undefined),
  mockListen: vi.fn().mockResolvedValue(() => {
    /* noop cleanup */
  }),
  mockDisposeTerminal: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
  listen: mockListen,
}))

vi.mock('@/lib/terminal-instances', () => ({
  disposeTerminal: mockDisposeTerminal,
  startHeadless: vi.fn(),
}))

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
      runningTerminals: new Set(),
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

  it('asks for confirmation instead of killing a running terminal via shortcut (issue #56)', () => {
    focusTerminal()

    useUIStore.setState({
      sessionChatModalOpen: true,
      sessionChatModalWorktreeId: 'modal-worktree',
    })
    useTerminalStore.setState({
      terminals: {
        'modal-worktree': [
          {
            id: 'term-running',
            worktreeId: 'modal-worktree',
            command: 'bun run dev',
            label: 'dev',
          },
        ],
      },
      activeTerminalIds: { 'modal-worktree': 'term-running' },
      modalTerminalOpen: { 'modal-worktree': true },
      terminalVisible: true,
      runningTerminals: new Set(['term-running']),
    })

    const confirmListener = vi.fn()
    window.addEventListener('confirm-close-terminal', confirmListener)

    expect(closeActiveTerminalTabForShortcut()).toBe(true)

    expect(confirmListener).toHaveBeenCalledTimes(1)
    const event = confirmListener.mock.calls[0]?.[0] as CustomEvent | undefined
    expect(event?.detail).toEqual({
      worktreeId: 'modal-worktree',
      terminalId: 'term-running',
    })
    expect(mockInvoke).not.toHaveBeenCalledWith('stop_terminal', {
      terminalId: 'term-running',
    })
    expect(mockDisposeTerminal).not.toHaveBeenCalled()
    expect(useTerminalStore.getState().terminals['modal-worktree']).toHaveLength(
      1
    )

    window.removeEventListener('confirm-close-terminal', confirmListener)
  })

  it('allows key-repeat only for scroll/navigation actions (issue #56)', () => {
    expect(allowsKeybindingRepeat('scroll_chat_up')).toBe(true)
    expect(allowsKeybindingRepeat('scroll_chat_down_small')).toBe(true)
    expect(allowsKeybindingRepeat('next_session')).toBe(true)
    expect(allowsKeybindingRepeat('previous_session')).toBe(true)

    expect(allowsKeybindingRepeat('close_session_or_worktree')).toBe(false)
    expect(allowsKeybindingRepeat('new_session')).toBe(false)
    expect(allowsKeybindingRepeat('cancel_prompt')).toBe(false)
    expect(allowsKeybindingRepeat('approve_plan')).toBe(false)
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
      activeTerminalIds: { 'modal-worktree': 'term-1' },
      modalTerminalOpen: { 'modal-worktree': true },
      terminalVisible: true,
    })

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

describe('applySessionRenamedToCaches', () => {
  const worktreeId = 'wt-1'
  const sessionId = 'sess-1'

  function seedSessionCaches(queryClient: QueryClient) {
    const sessions: WorktreeSessions = {
      worktree_id: worktreeId,
      sessions: [
        {
          id: sessionId,
          name: 'Session 1',
          order: 0,
          created_at: 0,
          updated_at: 0,
          messages: [],
        } as Session,
      ],
      active_session_id: sessionId,
      version: 2,
    }
    queryClient.setQueryData(chatQueryKeys.sessions(worktreeId), sessions)
    queryClient.setQueryData(
      [...chatQueryKeys.sessions(worktreeId), 'with-counts'],
      sessions
    )
    queryClient.setQueryData(chatQueryKeys.session(sessionId), sessions.sessions[0])
    queryClient.setQueryData<AllSessionsResponse>(['all-sessions'], {
      entries: [
        {
          project_id: 'p1',
          project_name: 'Project',
          worktree_id: worktreeId,
          worktree_name: 'main',
          worktree_path: '/tmp/wt',
          sessions: sessions.sessions,
        },
      ],
    })
  }

  it('updates base sessions, with-counts, session detail, and all-sessions caches', () => {
    const queryClient = new QueryClient()
    seedSessionCaches(queryClient)

    applySessionRenamedToCaches(
      queryClient,
      worktreeId,
      sessionId,
      'Fix auto naming'
    )

    const base = queryClient.getQueryData<WorktreeSessions>(
      chatQueryKeys.sessions(worktreeId)
    )
    const withCounts = queryClient.getQueryData<WorktreeSessions>([
      ...chatQueryKeys.sessions(worktreeId),
      'with-counts',
    ])
    const detail = queryClient.getQueryData<Session>(
      chatQueryKeys.session(sessionId)
    )
    const all = queryClient.getQueryData<AllSessionsResponse>(['all-sessions'])

    expect(base?.sessions[0]?.name).toBe('Fix auto naming')
    expect(withCounts?.sessions[0]?.name).toBe('Fix auto naming')
    expect(detail?.name).toBe('Fix auto naming')
    expect(all?.entries[0]?.sessions[0]?.name).toBe('Fix auto naming')
  })
})

describe('applyCacheInvalidationKeys', () => {
  it('invalidates chat queries and all-sessions for sessions keys', () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    applyCacheInvalidationKeys(queryClient, ['sessions'])

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: chatQueryKeys.all,
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['all-sessions'],
    })
  })

  it('invalidates projects queries for projects keys', () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    applyCacheInvalidationKeys(queryClient, ['projects'])

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: projectsQueryKeys.all,
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: ['all-sessions'],
    })
  })

  it('invalidates both chat and all-sessions when sessions is among multiple keys', () => {
    const queryClient = new QueryClient()
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    applyCacheInvalidationKeys(queryClient, ['preferences', 'sessions'])

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['preferences'],
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: chatQueryKeys.all,
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: ['all-sessions'],
    })
  })
})
