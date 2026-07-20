import { beforeEach, describe, expect, it, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { fireEvent, render, screen, waitFor } from '@/test/test-utils'
import { NewSessionModeModal } from './NewSessionModeModal'
import { useChatStore } from '@/store/chat-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'

const mutate = vi.fn()
const invoke = vi.fn()
let sessionsData: { sessions: unknown[] }
let nativeSessionsData: unknown[]
let opencodeInstalled: boolean
let cursorInstalled: boolean
let piInstalled: boolean
let commandCodeInstalled: boolean
let grokInstalled: boolean
let kimiInstalled: boolean
let isMobile: boolean
let defaultExecutionMode: 'plan' | 'build' | 'yolo'

vi.mock('@/services/preferences', () => ({
  usePreferences: () => ({
    data: {
      default_new_session_kind: 'chat',
      default_execution_mode: defaultExecutionMode,
    },
  }),
}))

vi.mock('@/services/chat', () => ({
  useCreateSession: () => ({
    mutate,
    isPending: false,
  }),
  useSessions: () => ({
    data: sessionsData,
    isLoading: false,
  }),
  useNativeCliSessions: () => ({
    data: nativeSessionsData,
    isLoading: false,
  }),
}))

vi.mock('@/lib/transport', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}))

vi.mock('@/hooks/use-mobile', () => ({
  useIsMobile: () => isMobile,
}))

vi.mock('@/services/claude-cli', () => ({
  useClaudeCliStatus: () => ({
    data: { installed: true, path: '/usr/local/bin/claude' },
    isLoading: false,
  }),
}))

vi.mock('@/services/codex-cli', () => ({
  useCodexCliStatus: () => ({
    data: { installed: true, path: '/usr/local/bin/codex' },
    isLoading: false,
  }),
}))

vi.mock('@/services/opencode-cli', () => ({
  useOpencodeCliStatus: () => ({
    data: {
      installed: opencodeInstalled,
      path: opencodeInstalled ? '/usr/local/bin/opencode' : null,
    },
    isLoading: false,
  }),
}))

vi.mock('@/services/cursor-cli', () => ({
  useCursorCliStatus: () => ({
    data: {
      installed: cursorInstalled,
      path: cursorInstalled ? '/usr/local/bin/cursor-agent' : null,
    },
    isLoading: false,
  }),
}))

vi.mock('@/services/pi-cli', () => ({
  usePiCliStatus: () => ({
    data: {
      installed: piInstalled,
      path: piInstalled ? '/usr/local/bin/pi' : null,
    },
    isLoading: false,
  }),
}))

vi.mock('@/services/commandcode-cli', () => ({
  useCommandCodeCliStatus: () => ({
    data: {
      installed: commandCodeInstalled,
      path: commandCodeInstalled ? '/usr/local/bin/cmd' : null,
    },
    isLoading: false,
  }),
}))

vi.mock('@/services/grok-cli', () => ({
  useGrokCliStatus: () => ({
    data: {
      installed: grokInstalled,
      path: grokInstalled ? '/usr/local/bin/grok' : null,
    },
    isLoading: false,
  }),
}))

vi.mock('@/services/kimi-cli', () => ({
  useKimiCliStatus: () => ({
    data: {
      installed: kimiInstalled,
      path: kimiInstalled ? '/usr/local/bin/kimi' : null,
    },
    isLoading: false,
  }),
}))

describe('NewSessionModeModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mutate.mockReset()
    invoke.mockReset()
    sessionsData = { sessions: [] }
    nativeSessionsData = []
    opencodeInstalled = false
    cursorInstalled = false
    piInstalled = false
    commandCodeInstalled = false
    grokInstalled = false
    kimiInstalled = false
    isMobile = false
    defaultExecutionMode = 'plan'
    invoke.mockResolvedValue({
      commandArgs: ['--context-arg', 'context-value'],
    })
    useUIStore.setState({
      newSessionModeTarget: null,
      sessionPrimarySurface: {},
      sessionTerminalIds: {},
    })
    useChatStore.setState({ activeSessionIds: {}, selectedBackends: {} })
    useTerminalStore.setState({
      terminals: {},
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: false,
      terminalPanelOpen: {},
      modalTerminalOpen: {},
    })
  })

  it('defaults Enter to a normal Jean chat session', () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-1' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: 'Enter' })

    expect(mutate).toHaveBeenCalledWith(
      { worktreeId: 'worktree-1', worktreePath: '/tmp/worktree-1' },
      expect.any(Object)
    )
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'session-1'
    )
    expect(useUIStore.getState().sessionPrimarySurface['session-1']).toBe(
      'chat'
    )
  })

  it('auto-opens the default Jean chat session without showing the picker', async () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-default' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
      intent: 'default',
    })

    render(<NewSessionModeModal />)

    await waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        { worktreeId: 'worktree-1', worktreePath: '/tmp/worktree-1' },
        expect.any(Object)
      )
    })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'session-default'
    )
  })

  it('marks Command Code and Grok, not Cursor, as beta in backend choices', () => {
    cursorInstalled = true
    commandCodeInstalled = true
    grokInstalled = true
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    expect(screen.getByText('Cursor')).toBeInTheDocument()
    expect(screen.queryByText('Cursor (Beta)')).toBeNull()
    expect(screen.getByText('Command Code (Beta)')).toBeInTheDocument()
    expect(screen.getByText('Grok (Beta)')).toBeInTheDocument()
    expect(
      screen.getByText('Open native Command Code (Beta) in a terminal session')
    ).toBeInTheDocument()
    expect(
      screen.getByText('Open native Grok (Beta) in a terminal session')
    ).toBeInTheDocument()
  })

  it('does not show Kimi when only Grok is installed', () => {
    grokInstalled = true
    kimiInstalled = false
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    expect(screen.getByText('Grok (Beta)')).toBeInTheDocument()
    expect(screen.queryByText('Kimi Code (Beta)')).toBeNull()
    expect(screen.queryByText(/Kimi/)).toBeNull()
  })

  it('shows Kimi only when its CLI is installed', () => {
    kimiInstalled = true
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    expect(screen.getByText('Kimi Code (Beta)')).toBeInTheDocument()
    expect(
      screen.getByText('Open native Kimi Code (Beta) in a terminal session')
    ).toBeInTheDocument()
  })

  it('uses compact backend choices and a normal/yolo step on mobile', () => {
    cursorInstalled = true
    commandCodeInstalled = true
    grokInstalled = true
    isMobile = true
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    expect(screen.getByText('AI backends')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Claude' })).toBeInTheDocument()
    expect(
      screen.queryByText('Open native Claude in a terminal session')
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: 'Start Claude in yolo mode' })
    ).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Claude' }))

    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(
      screen.getByText('Choose how to start Claude for this worktree.')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Start normal' })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Start yolo' })
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Start yolo' }))

    expect(screen.getByText('Claude sessions')).toBeInTheDocument()
  })

  it('opens an installed backend picker and starts a new terminal session', async () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: {
          onSuccess?: (session: {
            id: string
            name: string
            backend?: string
          }) => void
        }
      ) => {
        opts?.onSuccess?.({
          id: 'session-terminal-1',
          name: 'Codex',
          backend: 'codex',
        })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    expect(screen.getByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Claude')).toBeInTheDocument()
    expect(screen.queryByText('OpenCode')).toBeNull()
    expect(screen.getByText('Terminal')).toBeInTheDocument()
    expect(
      screen.getByTestId('new-session-backend-separator')
    ).toBeInTheDocument()

    fireEvent.keyDown(window, { key: '2' })

    expect(screen.getByText('Codex sessions')).toBeInTheDocument()
    expect(
      screen.getByText('No existing Codex sessions for this worktree.')
    ).toBeInTheDocument()
    expect(
      screen.getByTestId('native-cli-session-search-separator')
    ).toBeInTheDocument()
    const newCodexSessionButton = screen.getByRole('button', {
      name: 'New Codex session',
    })
    expect(newCodexSessionButton).toHaveClass('bg-background')
    expect(newCodexSessionButton).not.toHaveClass('bg-primary/12')
    expect(newCodexSessionButton).toContainElement(screen.getByText('↵'))

    fireEvent.click(screen.getByText('New Codex session'))

    expect(mutate).toHaveBeenCalledWith(
      {
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree-1',
        name: 'Codex',
        backend: 'codex',
        primarySurface: 'terminal',
        terminalCommand: '/usr/local/bin/codex',
        terminalCommandArgs: [],
        terminalLabel: 'Codex',
      },
      expect.any(Object)
    )
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('track_native_cli_session', {
        worktreePath: '/tmp/worktree-1',
        sessionId: 'session-terminal-1',
        backend: 'codex',
      })
      expect(invoke).toHaveBeenCalledWith('prepare_backend_terminal_context', {
        sessionId: 'session-terminal-1',
        worktreeId: 'worktree-1',
        backend: 'codex',
      })
    })
    expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(1)
    expect(
      useTerminalStore.getState().terminals['worktree-1']?.[0]
    ).toMatchObject({
      kind: 'session',
      command: '/usr/local/bin/codex',
      commandArgs: ['--context-arg', 'context-value'],
    })
    expect(
      useTerminalStore.getState().activeTerminalIds['worktree-1']
    ).toBeUndefined()
    expect(
      useTerminalStore.getState().terminalPanelOpen['worktree-1'] ?? false
    ).toBe(false)
    expect(useTerminalStore.getState().terminalVisible).toBe(false)
    expect(
      useUIStore.getState().sessionPrimarySurface['session-terminal-1']
    ).toBe('terminal')
    expect(
      useUIStore.getState().sessionTerminalIds['session-terminal-1']
    ).toEqual(expect.any(String))
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'session-terminal-1'
    )
    expect(useChatStore.getState().selectedBackends['session-terminal-1']).toBe(
      'codex'
    )
  })

  it('opens the native Claude session picker before starting a yolo session', async () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: {
          onSuccess?: (session: {
            id: string
            name: string
            backend?: string
          }) => void
        }
      ) => {
        opts?.onSuccess?.({
          id: 'session-claude-yolo',
          name: 'Claude',
          backend: 'claude',
        })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Start Claude in yolo mode' })
    )

    expect(screen.getByText('Claude sessions')).toBeInTheDocument()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('New Claude session'))

    const claudeCreateArgs = mutate.mock.calls[0]?.[0] as {
      nativeSessionId: string
      terminalCommandArgs: string[]
    }
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree-1',
        name: 'Claude',
        backend: 'claude',
        primarySurface: 'terminal',
        terminalCommand: '/usr/local/bin/claude',
        terminalLabel: 'Claude',
        nativeSessionId: expect.any(String),
        terminalCommandArgs: [
          '--permission-mode',
          'bypassPermissions',
          '--session-id',
          expect.any(String),
        ],
      }),
      expect.any(Object)
    )
    expect(claudeCreateArgs.terminalCommandArgs.at(-1)).toBe(
      claudeCreateArgs.nativeSessionId
    )
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('prepare_backend_terminal_context', {
        sessionId: 'session-claude-yolo',
        worktreeId: 'worktree-1',
        backend: 'claude',
      })
    })
    expect(
      useTerminalStore.getState().terminals['worktree-1']?.[0]
    ).toMatchObject({
      command: '/usr/local/bin/claude',
      commandArgs: [
        '--permission-mode',
        'bypassPermissions',
        '--session-id',
        claudeCreateArgs.nativeSessionId,
        '--context-arg',
        'context-value',
      ],
    })
  })

  it('opens the native Codex session picker before starting with dangerous approval bypass', async () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: {
          onSuccess?: (session: {
            id: string
            name: string
            backend?: string
          }) => void
        }
      ) => {
        opts?.onSuccess?.({
          id: 'session-codex-yolo',
          name: 'Codex',
          backend: 'codex',
        })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.click(
      screen.getByRole('button', { name: 'Start Codex in yolo mode' })
    )

    expect(screen.getByText('Codex sessions')).toBeInTheDocument()
    expect(mutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('New Codex session'))

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Codex',
        backend: 'codex',
        primarySurface: 'terminal',
        terminalCommandArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      }),
      expect.any(Object)
    )
    await waitFor(() => {
      expect(
        useTerminalStore.getState().terminals['worktree-1']?.[0]
      ).toMatchObject({
        command: '/usr/local/bin/codex',
        commandArgs: [
          '--dangerously-bypass-approvals-and-sandbox',
          '--context-arg',
          'context-value',
        ],
      })
    })
  })

  it('tracks a new OpenCode terminal session before launching it', async () => {
    opencodeInstalled = true
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: {
          onSuccess?: (session: {
            id: string
            name: string
            backend?: string
          }) => void
        }
      ) => {
        opts?.onSuccess?.({
          id: 'session-opencode',
          name: 'OpenCode',
          backend: 'opencode',
        })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)
    fireEvent.click(screen.getByText('OpenCode'))
    fireEvent.click(screen.getByText('New OpenCode session'))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('track_native_cli_session', {
        worktreePath: '/tmp/worktree-1',
        sessionId: 'session-opencode',
        backend: 'opencode',
      })
    })
    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        backend: 'opencode',
        terminalCommand: '/usr/local/bin/opencode',
      }),
      expect.any(Object)
    )
  })

  it('starts native CLI tracking only after terminal context preparation', async () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: {
          onSuccess?: (session: {
            id: string
            name: string
            backend?: string
          }) => void
        }
      ) => {
        opts?.onSuccess?.({
          id: 'session-codex-prepare-order',
          name: 'Codex',
          backend: 'codex',
        })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)
    fireEvent.click(screen.getByText('Codex'))
    fireEvent.click(screen.getByText('New Codex session'))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('prepare_backend_terminal_context', {
        sessionId: 'session-codex-prepare-order',
        worktreeId: 'worktree-1',
        backend: 'codex',
      })
    })
    expect(invoke).toHaveBeenCalledWith('track_native_cli_session', {
      worktreePath: '/tmp/worktree-1',
      sessionId: 'session-codex-prepare-order',
      backend: 'codex',
    })
    const prepareCallIndex = invoke.mock.calls.findIndex(
      ([command]) => command === 'prepare_backend_terminal_context'
    )
    const trackCallIndex = invoke.mock.calls.findIndex(
      ([command]) => command === 'track_native_cli_session'
    )
    expect(prepareCallIndex).toBeGreaterThanOrEqual(0)
    expect(trackCallIndex).toBeGreaterThanOrEqual(0)

    const prepareCallOrder = invoke.mock.invocationCallOrder[prepareCallIndex]
    const trackCallOrder = invoke.mock.invocationCallOrder[trackCallIndex]
    if (prepareCallOrder === undefined || trackCallOrder === undefined) {
      throw new Error('Expected both invoke calls to be recorded')
    }
    expect(prepareCallOrder).toBeLessThan(trackCallOrder)
    expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(1)
  })

  it('opens a plain terminal session with shortcut 1', async () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string; name: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-plain-terminal-1', name: 'Terminal' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: '1' })

    expect(screen.getByText('Terminal sessions')).toBeInTheDocument()
    expect(
      screen.getByTestId('native-cli-session-search-separator')
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'New Terminal session' })
    ).toContainElement(screen.getByText('↵'))
    fireEvent.click(screen.getByText('New Terminal session'))

    expect(mutate).toHaveBeenCalledWith(
      {
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree-1',
        name: 'Terminal',
        backend: undefined,
        primarySurface: 'terminal',
        terminalCommand: null,
        terminalCommandArgs: [],
        terminalLabel: 'Terminal',
      },
      expect.any(Object)
    )
    await waitFor(() => {
      expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(
        1
      )
    })
    expect(
      useTerminalStore.getState().terminals['worktree-1']?.[0]
    ).toMatchObject({
      kind: 'session',
      command: null,
      commandArgs: [],
      label: 'Terminal',
    })
    expect(
      useTerminalStore.getState().activeTerminalIds['worktree-1']
    ).toBeUndefined()
    expect(
      useTerminalStore.getState().terminalPanelOpen['worktree-1'] ?? false
    ).toBe(false)
    expect(useTerminalStore.getState().terminalVisible).toBe(false)
    expect(
      useUIStore.getState().sessionPrimarySurface['session-plain-terminal-1']
    ).toBe('terminal')
    expect(
      useUIStore.getState().sessionTerminalIds['session-plain-terminal-1']
    ).toEqual(expect.any(String))
    expect(useChatStore.getState().activeSessionIds['worktree-1']).toBe(
      'session-plain-terminal-1'
    )
    expect(
      useChatStore.getState().selectedBackends['session-plain-terminal-1']
    ).toBeUndefined()
    expect(invoke).not.toHaveBeenCalledWith(
      'prepare_backend_terminal_context',
      expect.any(Object)
    )
  })

  it('does not relaunch a legacy native CLI session without a resume ID', async () => {
    const expectedUpdatedAt = new Date(1710000000 * 1000).toLocaleString(
      undefined,
      {
        dateStyle: 'short',
        timeStyle: 'short',
      }
    )
    sessionsData = {
      sessions: [
        {
          id: 'existing-codex-session',
          name: 'Codex old task',
          backend: 'codex',
          primary_surface: 'terminal',
          terminal_command: '/usr/local/bin/codex',
          terminal_command_args: [],
          terminal_label: 'Codex old task',
          message_count: 0,
          updated_at: 1710000000,
          messages: [],
        },
      ],
    }
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: '2' })

    expect(
      screen.getByText(`0 messages · updated ${expectedUpdatedAt}`)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByText('Codex old task'))

    expect(mutate).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(
        useTerminalStore.getState().terminals['worktree-1'] ?? []
      ).toHaveLength(0)
    })
    expect(invoke).not.toHaveBeenCalledWith(
      'prepare_backend_terminal_context',
      expect.any(Object)
    )
  })

  it('imports native Codex history into a Jean terminal session', async () => {
    const expectedUpdatedAt = new Date(1778656196 * 1000).toLocaleString(
      undefined,
      {
        dateStyle: 'short',
        timeStyle: 'short',
      }
    )
    nativeSessionsData = [
      {
        backend: 'codex',
        id: 'native-codex-thread',
        title: 'Native Codex task',
        cwd: '/tmp/worktree-1',
        updatedAt: 1778656196,
        resumeArgs: ['resume', 'native-codex-thread'],
        sourcePath: '/Users/test/.codex/sessions/native.jsonl',
      },
    ]
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string; name: string }) => void }
      ) => {
        opts?.onSuccess?.({
          id: 'imported-native-session',
          name: 'Native Codex task',
        })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: '2' })

    expect(
      screen.getByText(`updated ${expectedUpdatedAt} · /tmp/worktree-1`)
    ).toBeInTheDocument()

    fireEvent.click(screen.getByText('Native Codex task'))

    expect(mutate).toHaveBeenCalledWith(
      {
        worktreeId: 'worktree-1',
        worktreePath: '/tmp/worktree-1',
        name: 'Native Codex task',
        backend: 'codex',
        primarySurface: 'terminal',
        terminalCommand: '/usr/local/bin/codex',
        terminalCommandArgs: ['resume', 'native-codex-thread'],
        terminalLabel: 'Native Codex task',
        nativeSessionId: 'native-codex-thread',
      },
      expect.any(Object)
    )
    await waitFor(() => {
      expect(useTerminalStore.getState().terminals['worktree-1']).toHaveLength(
        1
      )
    })
    expect(
      useTerminalStore.getState().terminals['worktree-1']?.[0]
    ).toMatchObject({
      command: '/usr/local/bin/codex',
      commandArgs: ['resume', 'native-codex-thread'],
      label: 'Native Codex task',
    })
  })

  it('filters Jean and native CLI sessions by search text', () => {
    sessionsData = {
      sessions: [
        {
          id: 'existing-codex-session',
          name: 'Fix dashboard bug',
          backend: 'codex',
          primary_surface: 'terminal',
          message_count: 0,
          updated_at: 1710000000,
          messages: [],
        },
      ],
    }
    nativeSessionsData = [
      {
        backend: 'codex',
        id: 'native-codex-thread',
        title: 'Sponsor cleanup task',
        cwd: '/tmp/worktree-1',
        updatedAt: 1778656196,
        resumeArgs: ['resume', 'native-codex-thread'],
        sourcePath: '/Users/test/.codex/sessions/native.jsonl',
      },
    ]
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: '2' })
    expect(screen.getByText('Fix dashboard bug')).toBeInTheDocument()
    expect(screen.getByText('Sponsor cleanup task')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search native CLI sessions'), {
      target: { value: 'sponsor' },
    })

    expect(screen.queryByText('Fix dashboard bug')).toBeNull()
    expect(screen.getByText('Sponsor cleanup task')).toBeInTheDocument()
  })

  it('shows only five recent sessions until search uses full history', () => {
    nativeSessionsData = Array.from({ length: 6 }, (_, index) => ({
      backend: 'codex',
      id: `native-codex-thread-${index}`,
      title:
        index === 5 ? 'Ancient hidden sponsor task' : `Recent task ${index}`,
      cwd: '/tmp/worktree-1',
      updatedAt: 1778656196 - index,
      resumeArgs: ['resume', `native-codex-thread-${index}`],
      sourcePath: `/Users/test/.codex/sessions/native-${index}.jsonl`,
    }))
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: '2' })
    expect(screen.queryByText('Ancient hidden sponsor task')).toBeNull()
    expect(screen.getByText('Recent task 0')).toBeInTheDocument()
    expect(screen.getByText('Recent task 4')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search native CLI sessions'), {
      target: { value: 'ancient' },
    })

    expect(screen.getByText('Ancient hidden sponsor task')).toBeInTheDocument()
    expect(screen.queryByText('Recent task 0')).toBeNull()
  })

  it('focuses the new CLI session button and creates on Enter', async () => {
    const user = userEvent.setup()
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: '2' })
    const newSessionButton = screen.getByRole('button', {
      name: 'New Codex session',
    })
    await waitFor(() => expect(newSessionButton).toHaveFocus())

    await user.keyboard('{Enter}')

    expect(mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Codex',
        backend: 'codex',
        primarySurface: 'terminal',
      }),
      expect.any(Object)
    )
  })

  it('does not create a new CLI session when pressing Enter in search', async () => {
    const user = userEvent.setup()
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: '2' })
    const searchInput = screen.getByLabelText('Search native CLI sessions')
    await user.click(searchInput)
    await user.keyboard('{Enter}')

    expect(mutate).not.toHaveBeenCalled()
  })

  it('marks chat sessions as chat surfaces', () => {
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-chat-1' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: 'Enter' })

    expect(useUIStore.getState().sessionPrimarySurface['session-chat-1']).toBe(
      'chat'
    )
  })

  it('applies the default execution mode to new Jean chat sessions', () => {
    defaultExecutionMode = 'yolo'
    mutate.mockImplementation(
      (
        _args: unknown,
        opts?: { onSuccess?: (session: { id: string }) => void }
      ) => {
        opts?.onSuccess?.({ id: 'session-yolo' })
      }
    )
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    fireEvent.keyDown(window, { key: 'Enter' })

    expect(useChatStore.getState().executionModes['session-yolo']).toBe('yolo')
    expect(invoke).toHaveBeenCalledWith('update_session_state', {
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      sessionId: 'session-yolo',
      selectedExecutionMode: 'yolo',
    })
  })

  it('shows fixed option descriptions without truncation', () => {
    useUIStore.getState().openNewSessionModeModal({
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/worktree-1',
      origin: 'chat',
    })

    render(<NewSessionModeModal />)

    const jeanDescription = screen.getByText(
      'Normal ChatWindow session with Jean features'
    )
    const terminalDescription = screen.getByText(
      'Open a plain terminal on this worktree'
    )

    expect(jeanDescription).not.toHaveClass('truncate')
    expect(terminalDescription).not.toHaveClass('truncate')
  })
})
