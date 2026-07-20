import { createElement, type PropsWithChildren } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { useChatStore } from '@/store/chat-store'
import type { UIState } from '@/types/ui-state'

let nativeApp = false

vi.mock('@/lib/environment', () => ({
  isNativeApp: () => nativeApp,
  isLocalBackend: () => nativeApp,
  hasBackend: () => true,
}))

const {
  mockInvoke,
  mockSaveUIState,
  mockUseUIState,
  mockUseSaveUIState,
  mockUseProjects,
} = vi.hoisted(() => ({
  mockInvoke: vi.fn(),
  mockSaveUIState: vi.fn(),
  mockUseUIState: vi.fn(),
  mockUseSaveUIState: vi.fn(),
  mockUseProjects: vi.fn(),
}))

vi.mock('@/lib/transport', () => ({
  invoke: mockInvoke,
}))

vi.mock('@/services/ui-state', () => ({
  useUIState: mockUseUIState,
  useSaveUIState: mockUseSaveUIState,
  uiStateQueryKeys: { all: ['ui-state'], state: () => ['ui-state'] },
}))

vi.mock('@/services/projects', () => ({
  useProjects: mockUseProjects,
}))

const { mockDisposeTerminal } = vi.hoisted(() => ({
  mockDisposeTerminal: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/terminal-instances', () => ({
  disposeTerminal: mockDisposeTerminal,
  disposePanelWorktreeTerminals: vi.fn(),
}))

import { useUIStatePersistence } from './useUIStatePersistence'

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: PropsWithChildren) {
    return createElement(QueryClientProvider, { client: queryClient }, children)
  }
}

function buildUiState(overrides: Partial<UIState> = {}): UIState {
  return {
    version: 1,
    ...overrides,
  } as UIState
}

describe('useUIStatePersistence — terminal restore on web refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nativeApp = false
    // Defaults: no live PTYs, empty persisted state.
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_active_terminals') return []
      if (command === 'load_ui_state') return buildUiState()
      return undefined
    })
    mockUseUIState.mockReturnValue({
      data: buildUiState(),
      isSuccess: true,
    })
    mockUseProjects.mockReturnValue({ data: [], isSuccess: true })
    mockUseSaveUIState.mockReturnValue({ mutate: mockSaveUIState })

    useTerminalStore.setState({
      terminals: {},
      activeTerminalIds: {},
      runningTerminals: new Set(),
      failedTerminals: new Set(),
      terminalVisible: false,
      terminalPanelOpen: {},
      modalTerminalOpen: {},
    })
    useUIStore.setState({
      uiStateInitialized: false,
      sessionTerminalIds: {},
      sessionPrimarySurface: {},
    })
    useChatStore.setState({
      activeWorktreeId: null,
      activeWorktreePath: null,
      activeSessionIds: {},
      sessionWorktreeMap: {},
      inputDrafts: {},
      pendingImages: {},
      pendingTextFiles: {},
    })
  })

  it('restores unsent input drafts for every session', async () => {
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        input_drafts: {
          'session-1': 'first unsent message',
          'session-2': 'second unsent message',
        },
      }),
      isSuccess: true,
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useChatStore.getState().inputDrafts).toEqual({
        'session-1': 'first unsent message',
        'session-2': 'second unsent message',
      })
    })
  })

  it('restores unsent image and pasted-text attachments', async () => {
    mockInvoke.mockImplementation(async (command: string, args?: unknown) => {
      if (command === 'get_active_terminals') return []
      if (command === 'load_ui_state') return buildUiState()
      if (command === 'read_pasted_text') {
        const path = (args as { path?: string })?.path
        if (path === '/tmp/pasted-texts/paste-1.txt') {
          return { content: 'hydrated paste body', size: 19 }
        }
        throw new Error(`unexpected path: ${path}`)
      }
      return undefined
    })
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        pending_images: {
          'session-1': [
            {
              id: 'img-1',
              path: '/tmp/pasted-images/image-1.png',
              filename: 'image-1.png',
            },
          ],
        },
        pending_text_files: {
          'session-1': [
            {
              id: 'txt-1',
              path: '/tmp/pasted-texts/paste-1.txt',
              filename: 'paste-1.txt',
              size: 12,
            },
          ],
        },
      }),
      isSuccess: true,
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useChatStore.getState().pendingImages).toEqual({
        'session-1': [
          {
            id: 'img-1',
            path: '/tmp/pasted-images/image-1.png',
            filename: 'image-1.png',
          },
        ],
      })
    })

    await waitFor(() => {
      expect(useChatStore.getState().pendingTextFiles).toEqual({
        'session-1': [
          {
            id: 'txt-1',
            path: '/tmp/pasted-texts/paste-1.txt',
            filename: 'paste-1.txt',
            size: 19,
            content: 'hydrated paste body',
          },
        ],
      })
    })
  })

  it('debounces persistence when a session input draft changes', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useUIStore.getState().uiStateInitialized).toBe(true)
    })

    useChatStore.getState().setInputDraft('session-1', 'unsent message')

    await waitFor(() => {
      expect(mockSaveUIState).toHaveBeenCalledTimes(1)
    })
    expect(mockSaveUIState).toHaveBeenLastCalledWith(
      expect.objectContaining({
        input_drafts: { 'session-1': 'unsent message' },
      })
    )
  })

  it('debounces persistence when pending images or text files change', async () => {
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useUIStore.getState().uiStateInitialized).toBe(true)
    })

    useChatStore.getState().addPendingImage('session-1', {
      id: 'img-1',
      path: '/tmp/pasted-images/image-1.png',
      filename: 'image-1.png',
    })
    useChatStore.getState().addPendingTextFile('session-1', {
      id: 'txt-1',
      path: '/tmp/pasted-texts/paste-1.txt',
      filename: 'paste-1.txt',
      size: 12,
      content: 'pasted body',
    })
    // Loading placeholders must not be persisted.
    useChatStore.getState().addPendingImage('session-1', {
      id: 'img-loading',
      path: '',
      filename: 'Processing...',
      loading: true,
    })

    await waitFor(() => {
      expect(mockSaveUIState).toHaveBeenCalled()
      const lastCall = mockSaveUIState.mock.calls.at(-1)?.[0]
      expect(lastCall).toEqual(
        expect.objectContaining({
          pending_images: {
            'session-1': [
              {
                id: 'img-1',
                path: '/tmp/pasted-images/image-1.png',
                filename: 'image-1.png',
              },
            ],
          },
          pending_text_files: {
            'session-1': [
              {
                id: 'txt-1',
                path: '/tmp/pasted-texts/paste-1.txt',
                filename: 'paste-1.txt',
                size: 12,
              },
            ],
          },
        })
      )
    })
  })

  it('clears stale terminal store + disposes xterm instances when backend reports zero live PTYs', async () => {
    // Frontend had a phantom terminal from before restore completed.
    useTerminalStore.setState({
      terminals: {
        'worktree-1': [
          {
            id: 'phantom-1',
            worktreeId: 'worktree-1',
            command: null,
            commandArgs: null,
            label: 'Shell',
            kind: 'panel',
          },
        ],
      },
      activeTerminalIds: { 'worktree-1': 'phantom-1' },
      runningTerminals: new Set(['phantom-1']),
      terminalPanelOpen: { 'worktree-1': true },
      terminalVisible: true,
    })
    // Persisted state has 2 terminals whose PTYs are gone on the backend.
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        terminal_instances: {
          'worktree-1': [
            {
              id: 'persisted-1',
              command: null,
              command_args: null,
              label: 'Shell',
              kind: 'panel',
            },
            {
              id: 'persisted-2',
              command: 'pnpm dev',
              command_args: null,
              label: 'pnpm dev',
              kind: 'panel',
            },
          ],
        },
      }),
      isSuccess: true,
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useTerminalStore.getState().terminals).toEqual({})
      expect(useTerminalStore.getState().activeTerminalIds).toEqual({})
      expect(useTerminalStore.getState().terminalPanelOpen).toEqual({})
      expect(useTerminalStore.getState().terminalVisible).toBe(false)
      expect(useTerminalStore.getState().runningTerminals.size).toBe(0)
    })

    // Wait for the dynamic import + dispose to flush.
    await waitFor(() => {
      expect(mockDisposeTerminal).toHaveBeenCalledWith('phantom-1')
    })
  })

  it('clears persisted session-terminal mappings when their PTYs are dead', async () => {
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        session_terminal_ids: { 'session-1': 'dead-term-1' },
        session_primary_surface: { 'session-1': 'terminal' },
      }),
      isSuccess: true,
    })
    // Pre-populate ui-store as if a previous session restored these mappings.
    useUIStore.setState({
      uiStateInitialized: false,
      sessionTerminalIds: { 'session-1': 'dead-term-1' },
      sessionPrimarySurface: { 'session-1': 'terminal' },
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      const uiState = useUIStore.getState()
      expect(uiState.sessionTerminalIds['session-1']).toBeUndefined()
      expect(uiState.sessionPrimarySurface['session-1']).toBeUndefined()
    })
  })

  it('restores only persisted terminals whose IDs are still live on the backend', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_active_terminals') return ['live-1']
      if (command === 'load_ui_state') return buildUiState()
      return undefined
    })
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        terminal_instances: {
          'worktree-1': [
            {
              id: 'live-1',
              command: 'pnpm dev',
              command_args: null,
              label: 'pnpm dev',
              kind: 'panel',
            },
            {
              id: 'dead-1',
              command: null,
              command_args: null,
              label: 'Shell',
              kind: 'panel',
            },
          ],
        },
        terminal_active_ids: { 'worktree-1': 'live-1' },
        terminal_panel_open: { 'worktree-1': true },
        terminal_visible: true,
      }),
      isSuccess: true,
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      const restored = useTerminalStore.getState().terminals['worktree-1']
      expect(restored?.map(t => t.id)).toEqual(['live-1'])
    })

    expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
      'live-1'
    )
    expect(useTerminalStore.getState().terminalPanelOpen['worktree-1']).toBe(
      true
    )
    expect(useTerminalStore.getState().terminalVisible).toBe(true)
    expect(useTerminalStore.getState().runningTerminals.has('live-1')).toBe(
      true
    )
  })

  it('does not restore terminals at all in native mode (terminal_runtime is web-only)', async () => {
    nativeApp = true
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        terminal_instances: {
          'worktree-1': [
            {
              id: 'should-be-ignored',
              command: null,
              command_args: null,
              label: 'Shell',
              kind: 'panel',
            },
          ],
        },
      }),
      isSuccess: true,
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useUIStore.getState().uiStateInitialized).toBe(true)
    })

    expect(useTerminalStore.getState().terminals).toEqual({})
    expect(mockInvoke).not.toHaveBeenCalledWith('get_active_terminals')
  })

  it('regression: failed active-terminal query hydrates fallback terminals before uiStateInitialized flips', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_active_terminals') {
        throw new Error('transient websocket failure')
      }
      if (command === 'load_ui_state') return buildUiState()
      return undefined
    })
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        terminal_instances: {
          'worktree-1': [
            {
              id: 'fallback-panel',
              command: null,
              command_args: null,
              label: 'Shell',
              kind: 'panel',
            },
            {
              id: 'fallback-session',
              command: 'codex',
              command_args: ['resume', 'abc123'],
              label: 'Codex',
              kind: 'session',
            },
          ],
        },
        terminal_active_ids: { 'worktree-1': 'fallback-panel' },
        terminal_panel_open: { 'worktree-1': true },
        terminal_visible: true,
        session_terminal_ids: { 'session-1': 'fallback-session' },
        session_primary_surface: { 'session-1': 'terminal' },
      }),
      isSuccess: true,
    })

    const order: string[] = []
    const unsubTerm = useTerminalStore.subscribe(state => {
      if (state.terminals['worktree-1']?.length === 2) {
        order.push('fallback_terminals_restored')
      }
    })
    const unsubUI = useUIStore.subscribe(state => {
      if (state.uiStateInitialized) {
        order.push('uiStateInitialized_true')
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useUIStore.getState().uiStateInitialized).toBe(true)
    })

    unsubTerm()
    unsubUI()

    const terminalState = useTerminalStore.getState()
    expect(terminalState.terminals['worktree-1']?.map(t => t.id)).toEqual([
      'fallback-panel',
      'fallback-session',
    ])
    expect(terminalState.activeTerminalIds['worktree-1']).toBe('fallback-panel')
    expect(terminalState.runningTerminals.has('fallback-panel')).toBe(true)
    expect(terminalState.runningTerminals.has('fallback-session')).toBe(true)
    expect(terminalState.terminalPanelOpen['worktree-1']).toBe(true)
    expect(terminalState.terminalVisible).toBe(true)
    expect(useUIStore.getState().sessionTerminalIds['session-1']).toBe(
      'fallback-session'
    )
    expect(useUIStore.getState().sessionPrimarySurface['session-1']).toBe(
      'terminal'
    )

    const restoreIdx = order.indexOf('fallback_terminals_restored')
    const flagIdx = order.indexOf('uiStateInitialized_true')
    expect(restoreIdx).toBeGreaterThanOrEqual(0)
    expect(flagIdx).toBeGreaterThanOrEqual(0)
    expect(restoreIdx).toBeLessThan(flagIdx)
  })

  // REGRESSION GUARD for the race in TerminalView's auto-create effect.
  //
  // TerminalView's effect only fires once `useUIStore.uiStateInitialized`
  // flips to `true`. For that to be safe, the terminal store MUST be
  // populated (or cleared) BEFORE that flip — otherwise TerminalView sees an
  // empty store at flip time and spawns a phantom shell. The implementation
  // guarantees this by awaiting `restoreTerminalRuntimeState()` inside
  // `finally()` and only scheduling `setIsInitialized` via `queueMicrotask`
  // after that resolve. This test pins the ordering.
  it('regression: terminal store is populated BEFORE uiStateInitialized flips', async () => {
    mockInvoke.mockImplementation(async (command: string) => {
      if (command === 'get_active_terminals') return ['live-1']
      if (command === 'load_ui_state') return buildUiState()
      return undefined
    })
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        terminal_instances: {
          'worktree-1': [
            {
              id: 'live-1',
              command: null,
              command_args: null,
              label: 'Shell',
              kind: 'panel',
            },
          ],
        },
      }),
      isSuccess: true,
    })

    const order: string[] = []
    const unsubTerm = useTerminalStore.subscribe(state => {
      if (state.terminals['worktree-1']?.length) {
        order.push('terminals_populated')
      }
    })
    const unsubUI = useUIStore.subscribe(state => {
      if (state.uiStateInitialized) {
        order.push('uiStateInitialized_true')
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useUIStore.getState().uiStateInitialized).toBe(true)
    })

    unsubTerm()
    unsubUI()

    // The terminal restore must happen BEFORE the flag flips. Without this
    // ordering, TerminalView's effect sees an empty store at flip time and
    // races to spawn a phantom shell.
    const termIdx = order.indexOf('terminals_populated')
    const flagIdx = order.indexOf('uiStateInitialized_true')
    expect(termIdx).toBeGreaterThanOrEqual(0)
    expect(flagIdx).toBeGreaterThanOrEqual(0)
    expect(termIdx).toBeLessThan(flagIdx)
  })

  // Same ordering invariant, dead-PTY path: the terminal store must be
  // cleared (and phantom xterm instances disposed) BEFORE the flag flips,
  // otherwise TerminalView would see the stale entries as "restored" and try
  // to attach to dead PTYs.
  it('regression: dead-PTY branch clears terminal store BEFORE uiStateInitialized flips', async () => {
    useTerminalStore.setState({
      terminals: {
        'worktree-1': [
          {
            id: 'stale-1',
            worktreeId: 'worktree-1',
            command: null,
            commandArgs: null,
            label: 'Shell',
            kind: 'panel',
          },
        ],
      },
    })
    // Need persistedTerminalState so `restoreTerminalRuntimeState` reaches
    // the dead-PTY branch (the function early-returns if persisted is empty).
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        terminal_instances: {
          'worktree-1': [
            {
              id: 'stale-1',
              command: null,
              command_args: null,
              label: 'Shell',
              kind: 'panel',
            },
          ],
        },
      }),
      isSuccess: true,
    })

    const order: string[] = []
    const unsubTerm = useTerminalStore.subscribe(state => {
      if (
        state.terminals['worktree-1'] === undefined ||
        state.terminals['worktree-1'].length === 0
      ) {
        order.push('terminals_cleared')
      }
    })
    const unsubUI = useUIStore.subscribe(state => {
      if (state.uiStateInitialized) {
        order.push('uiStateInitialized_true')
      }
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useUIStore.getState().uiStateInitialized).toBe(true)
    })

    unsubTerm()
    unsubUI()

    expect(useTerminalStore.getState().terminals).toEqual({})
    const clearIdx = order.indexOf('terminals_cleared')
    const flagIdx = order.indexOf('uiStateInitialized_true')
    expect(clearIdx).toBeGreaterThanOrEqual(0)
    expect(flagIdx).toBeGreaterThanOrEqual(0)
    expect(clearIdx).toBeLessThan(flagIdx)
  })

  // PHASE 1 (always restore) of the split refactor. The user-intent
  // flags (terminal_panel_open, modal_terminal_open, terminal_visible,
  // terminal_height) must persist across refresh even when no
  // terminal_instances were persisted. This is what makes the panel
  // re-open after refresh when the user had it open with zero surviving
  // PTYs.
  it('regression: terminal_panel_open + terminal_visible restore even when no terminal_instances are persisted', async () => {
    mockUseUIState.mockReturnValue({
      data: buildUiState({
        // Note: no terminal_instances, no session_terminal_ids.
        terminal_panel_open: { 'worktree-1': true },
        modal_terminal_open: { 'worktree-1': true },
        terminal_visible: true,
        terminal_height: 42,
      }),
      isSuccess: true,
    })

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    renderHook(() => useUIStatePersistence(), {
      wrapper: createWrapper(queryClient),
    })

    await waitFor(() => {
      expect(useUIStore.getState().uiStateInitialized).toBe(true)
    })

    // UI flags must have been restored.
    expect(useTerminalStore.getState().terminalPanelOpen['worktree-1']).toBe(
      true
    )
    expect(useTerminalStore.getState().modalTerminalOpen['worktree-1']).toBe(
      true
    )
    expect(useTerminalStore.getState().terminalVisible).toBe(true)
    expect(useTerminalStore.getState().terminalHeight).toBe(42)
  })
})
