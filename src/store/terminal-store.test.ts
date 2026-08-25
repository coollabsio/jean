import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTerminalStore } from './terminal-store'

// Mock crypto.randomUUID
vi.stubGlobal('crypto', {
  randomUUID: vi.fn(
    () => 'mock-uuid-' + Math.random().toString(36).slice(2, 9)
  ),
})

describe('TerminalStore', () => {
  beforeEach(() => {
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
  })

  describe('visibility', () => {
    it('sets terminal visible', () => {
      const { setTerminalVisible } = useTerminalStore.getState()

      setTerminalVisible(true)
      expect(useTerminalStore.getState().terminalVisible).toBe(true)

      setTerminalVisible(false)
      expect(useTerminalStore.getState().terminalVisible).toBe(false)
    })

    it('sets terminal panel open per worktree', () => {
      const { setTerminalPanelOpen, isTerminalPanelOpen } =
        useTerminalStore.getState()
      const worktreeId = 'test-worktree'

      setTerminalPanelOpen(worktreeId, true)
      expect(isTerminalPanelOpen(worktreeId)).toBe(true)

      setTerminalPanelOpen(worktreeId, false)
      expect(isTerminalPanelOpen(worktreeId)).toBe(false)
    })

    it('toggles terminal visibility', () => {
      const { toggleTerminal, isTerminalPanelOpen } =
        useTerminalStore.getState()
      const worktreeId = 'test-worktree'

      toggleTerminal(worktreeId)
      const state1 = useTerminalStore.getState()
      expect(state1.terminalVisible).toBe(true)
      expect(isTerminalPanelOpen(worktreeId)).toBe(true)

      toggleTerminal(worktreeId)
      expect(useTerminalStore.getState().terminalVisible).toBe(false)
    })

    it('sets terminal height', () => {
      const { setTerminalHeight } = useTerminalStore.getState()

      setTerminalHeight(50)
      expect(useTerminalStore.getState().terminalHeight).toBe(50)
    })

    it('sets modal terminal dock mode', () => {
      const { setModalTerminalDockMode } = useTerminalStore.getState()

      setModalTerminalDockMode('right')
      expect(useTerminalStore.getState().modalTerminalDockMode).toBe('right')

      setModalTerminalDockMode('bottom')
      expect(useTerminalStore.getState().modalTerminalDockMode).toBe('bottom')
    })

    it('sets modal terminal height', () => {
      const { setModalTerminalHeight } = useTerminalStore.getState()

      setModalTerminalHeight(320)
      expect(useTerminalStore.getState().modalTerminalHeight).toBe(320)
    })

    it('avoids replacing modal terminal open state on no-op updates', () => {
      const { setModalTerminalOpen } = useTerminalStore.getState()

      setModalTerminalOpen('worktree-1', true)
      const firstOpenState = useTerminalStore.getState().modalTerminalOpen

      setModalTerminalOpen('worktree-1', true)

      expect(useTerminalStore.getState().modalTerminalOpen).toBe(firstOpenState)
    })
  })

  describe('terminal instance management', () => {
    it('registers a run terminal started outside the UI', () => {
      useTerminalStore
        .getState()
        .registerStartedRun('worktree-1', 'run-from-mcp', 'bun run dev')

      const state = useTerminalStore.getState()
      expect(state.terminals['worktree-1']).toEqual([
        expect.objectContaining({
          id: 'run-from-mcp',
          worktreeId: 'worktree-1',
          command: 'bun run dev',
          kind: 'panel',
        }),
      ])
      expect(state.activeTerminalIds['worktree-1']).toBe('run-from-mcp')
      expect(state.runningTerminals.has('run-from-mcp')).toBe(true)
      expect(state.terminalPanelOpen['worktree-1']).toBe(true)
      expect(state.terminalVisible).toBe(true)
    })

    it('adds a terminal and returns ID', () => {
      const { addTerminal } = useTerminalStore.getState()

      const id = addTerminal('worktree-1')

      expect(id).toBeDefined()
      const state = useTerminalStore.getState()
      const { isTerminalPanelOpen } = useTerminalStore.getState()
      expect(state.terminals['worktree-1']).toHaveLength(1)
      expect(state.terminals['worktree-1']?.[0]?.id).toBe(id)
      expect(state.terminals['worktree-1']?.[0]?.label).toBe('Shell')
      expect(state.activeTerminalIds['worktree-1']).toBe(id)
      expect(isTerminalPanelOpen('worktree-1')).toBe(true)
      expect(state.terminalVisible).toBe(true)
    })

    it('adds terminal with command', () => {
      const { addTerminal, getTerminals } = useTerminalStore.getState()

      addTerminal('worktree-1', 'bun run dev')

      const terminals = getTerminals('worktree-1')
      expect(terminals[0]?.command).toBe('bun run dev')
      expect(terminals[0]?.label).toBe('bun')
    })

    it('adds terminal with custom label', () => {
      const { addTerminal, getTerminals } = useTerminalStore.getState()

      addTerminal('worktree-1', 'bun run dev', 'Dev Server')

      const terminals = getTerminals('worktree-1')
      expect(terminals[0]?.label).toBe('Dev Server')
    })

    it('adds session terminals without activating or opening the panel', () => {
      const { addTerminal, getTerminals, isTerminalPanelOpen } =
        useTerminalStore.getState()

      const id = addTerminal('worktree-1', null, 'Terminal', {
        kind: 'session',
        activate: false,
        openPanel: false,
      })

      const state = useTerminalStore.getState()
      expect(getTerminals('worktree-1')).toHaveLength(1)
      expect(getTerminals('worktree-1')[0]).toMatchObject({
        id,
        kind: 'session',
        label: 'Terminal',
      })
      expect(state.activeTerminalIds['worktree-1']).toBeUndefined()
      expect(isTerminalPanelOpen('worktree-1')).toBe(false)
      expect(state.terminalVisible).toBe(false)
    })

    it('removes a terminal', () => {
      const { addTerminal, removeTerminal, getTerminals } =
        useTerminalStore.getState()

      const id1 = addTerminal('worktree-1')
      const id2 = addTerminal('worktree-1')

      removeTerminal('worktree-1', id1)

      const terminals = getTerminals('worktree-1')
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.id).toBe(id2)
    })

    it('updates active terminal when removing active terminal', () => {
      const { addTerminal, removeTerminal } = useTerminalStore.getState()

      const id1 = addTerminal('worktree-1')
      const id2 = addTerminal('worktree-1')

      // id2 is now active
      expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
        id2
      )

      // Remove active terminal, should fall back to id1
      removeTerminal('worktree-1', id2)
      expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
        id1
      )
    })

    it('does not fall back to session terminals when removing the active panel terminal', () => {
      const { addTerminal, removeTerminal } = useTerminalStore.getState()

      const panelId = addTerminal('worktree-1')
      addTerminal('worktree-1', null, 'Terminal', {
        kind: 'session',
        activate: false,
        openPanel: false,
      })

      removeTerminal('worktree-1', panelId)

      expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
        ''
      )
    })

    it('sets active terminal', () => {
      const { addTerminal, setActiveTerminal } = useTerminalStore.getState()

      const id1 = addTerminal('worktree-1')
      addTerminal('worktree-1')

      setActiveTerminal('worktree-1', id1)
      expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
        id1
      )
    })

    it('does not set a session terminal as the active panel terminal', () => {
      const { addTerminal, setActiveTerminal } = useTerminalStore.getState()

      const panelId = addTerminal('worktree-1')
      const sessionId = addTerminal('worktree-1', 'codex', 'Codex', {
        kind: 'session',
        activate: false,
        openPanel: false,
      })

      setActiveTerminal('worktree-1', sessionId)

      expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
        panelId
      )
    })

    it('keeps the Jean session id on native CLI terminals', () => {
      const terminalId = useTerminalStore
        .getState()
        .addTerminal('worktree-1', 'codex', 'Codex', {
          kind: 'session',
          sessionId: 'session-codex-1',
        })

      const terminal = useTerminalStore
        .getState()
        .terminals['worktree-1']?.find(item => item.id === terminalId)
      expect(terminal?.sessionId).toBe('session-codex-1')
    })

    it('reorders panel terminals while preserving session terminals and active terminal', () => {
      const { addTerminal, reorderPanelTerminals } = useTerminalStore.getState()

      const panelA = addTerminal('worktree-1', null, 'A')
      const sessionId = addTerminal('worktree-1', null, 'Session Terminal', {
        kind: 'session',
        activate: false,
        openPanel: false,
      })
      const panelB = addTerminal('worktree-1', null, 'B')
      const panelC = addTerminal('worktree-1', null, 'C')

      reorderPanelTerminals('worktree-1', [panelC, panelA, panelB])

      const state = useTerminalStore.getState()
      expect(state.terminals['worktree-1']?.map(t => t.id)).toEqual([
        panelC,
        sessionId,
        panelA,
        panelB,
      ])
      expect(state.activeTerminalIds['worktree-1']).toBe(panelC)
    })

    it('gets terminals for worktree', () => {
      const { addTerminal, getTerminals } = useTerminalStore.getState()

      addTerminal('worktree-1')
      addTerminal('worktree-1')
      addTerminal('worktree-2')

      expect(getTerminals('worktree-1')).toHaveLength(2)
      expect(getTerminals('worktree-2')).toHaveLength(1)
      expect(getTerminals('worktree-3')).toHaveLength(0)
    })

    it('gets active terminal for worktree', () => {
      const { addTerminal, getActiveTerminal } = useTerminalStore.getState()

      expect(getActiveTerminal('worktree-1')).toBeNull()

      const id = addTerminal('worktree-1')
      const active = getActiveTerminal('worktree-1')
      expect(active?.id).toBe(id)
    })
  })

  describe('running state', () => {
    it('sets terminal running state', () => {
      const { addTerminal, setTerminalRunning, isTerminalRunning } =
        useTerminalStore.getState()

      const id = addTerminal('worktree-1')

      expect(isTerminalRunning(id)).toBe(false)

      setTerminalRunning(id, true)
      expect(isTerminalRunning(id)).toBe(true)

      setTerminalRunning(id, false)
      expect(isTerminalRunning(id)).toBe(false)
    })

    it('clears running state when terminal is removed', () => {
      const {
        addTerminal,
        setTerminalRunning,
        isTerminalRunning,
        removeTerminal,
      } = useTerminalStore.getState()

      const id = addTerminal('worktree-1')
      setTerminalRunning(id, true)

      removeTerminal('worktree-1', id)
      expect(isTerminalRunning(id)).toBe(false)
    })
  })

  describe('startRun', () => {
    it('creates new terminal for command', () => {
      const { startRun, getTerminals } = useTerminalStore.getState()

      const id = startRun('worktree-1', 'bun test')

      const terminals = getTerminals('worktree-1')
      expect(terminals).toHaveLength(1)
      expect(terminals[0]?.id).toBe(id)
      expect(terminals[0]?.command).toBe('bun test')
    })

    it('reuses existing running terminal with same command', () => {
      const { startRun, setTerminalRunning, getTerminals } =
        useTerminalStore.getState()

      const id1 = startRun('worktree-1', 'bun test')
      setTerminalRunning(id1, true)

      const id2 = startRun('worktree-1', 'bun test')

      expect(id1).toBe(id2)
      expect(getTerminals('worktree-1')).toHaveLength(1)
    })

    it('creates new terminal if existing terminal is not running', () => {
      const { startRun, getTerminals } = useTerminalStore.getState()

      startRun('worktree-1', 'bun test')
      // Not marked as running
      const id2 = startRun('worktree-1', 'bun test')

      const terminals = getTerminals('worktree-1')
      expect(terminals).toHaveLength(2)
      expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
        id2
      )
    })

    it('shows terminal panel when starting run', () => {
      useTerminalStore.setState({
        terminalVisible: false,
        terminalPanelOpen: {},
      })
      const { startRun, isTerminalPanelOpen } = useTerminalStore.getState()

      startRun('worktree-1', 'bun test')

      const state = useTerminalStore.getState()
      expect(state.terminalVisible).toBe(true)
      expect(isTerminalPanelOpen('worktree-1')).toBe(true)
    })

    it('does not reuse a running session terminal for side-panel runs', () => {
      const { addTerminal, startRun, setTerminalRunning, getTerminals } =
        useTerminalStore.getState()

      const sessionTerminalId = addTerminal('worktree-1', 'codex', 'Codex', {
        kind: 'session',
        activate: false,
        openPanel: false,
      })
      setTerminalRunning(sessionTerminalId, true)

      const runTerminalId = startRun('worktree-1', 'codex')

      expect(runTerminalId).not.toBe(sessionTerminalId)
      expect(getTerminals('worktree-1')).toHaveLength(2)
      expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
        runTerminalId
      )
    })
  })

  describe('closeAllTerminals', () => {
    it('returns the same state reference when there is nothing to close', () => {
      const { closeAllTerminals } = useTerminalStore.getState()
      const before = useTerminalStore.getState()

      const closedIds = closeAllTerminals('worktree-1')

      expect(closedIds).toHaveLength(0)
      expect(useTerminalStore.getState()).toBe(before)
    })

    it('removes all terminals for worktree and returns IDs', () => {
      const { addTerminal, closeAllTerminals, getTerminals } =
        useTerminalStore.getState()

      const id1 = addTerminal('worktree-1')
      const id2 = addTerminal('worktree-1')
      addTerminal('worktree-2')

      const closedIds = closeAllTerminals('worktree-1')

      expect(closedIds).toContain(id1)
      expect(closedIds).toContain(id2)
      expect(closedIds).toHaveLength(2)
      expect(getTerminals('worktree-1')).toHaveLength(0)
      expect(getTerminals('worktree-2')).toHaveLength(1)
    })

    it('clears running state for closed terminals', () => {
      const {
        addTerminal,
        setTerminalRunning,
        closeAllTerminals,
        isTerminalRunning,
      } = useTerminalStore.getState()

      const id1 = addTerminal('worktree-1')
      const id2 = addTerminal('worktree-1')
      setTerminalRunning(id1, true)
      setTerminalRunning(id2, true)

      closeAllTerminals('worktree-1')

      expect(isTerminalRunning(id1)).toBe(false)
      expect(isTerminalRunning(id2)).toBe(false)
    })

    it('closes panel for worktree but preserves global visibility', () => {
      const { addTerminal, closeAllTerminals, isTerminalPanelOpen } =
        useTerminalStore.getState()

      addTerminal('worktree-1')
      closeAllTerminals('worktree-1')

      const state = useTerminalStore.getState()
      expect(isTerminalPanelOpen('worktree-1')).toBe(false)
      // terminalVisible is global and should NOT be affected by closing terminals in one worktree
      // This prevents closing terminals in worktree A from affecting worktree B's terminal panel
      expect(state.terminalVisible).toBe(true)
    })

    it('returns empty array for worktree with no terminals', () => {
      const { closeAllTerminals } = useTerminalStore.getState()

      const closedIds = closeAllTerminals('worktree-1')
      expect(closedIds).toHaveLength(0)
    })
  })

  describe('closePanelTerminals', () => {
    it('closes only panel terminals and preserves session terminals', () => {
      const { addTerminal, closePanelTerminals, getTerminals } =
        useTerminalStore.getState()

      const panelId = addTerminal('worktree-1')
      const sessionId = addTerminal('worktree-1', null, 'Terminal', {
        kind: 'session',
        activate: false,
        openPanel: false,
      })

      const closedIds = closePanelTerminals('worktree-1')

      expect(closedIds).toEqual([panelId])
      expect(getTerminals('worktree-1')).toHaveLength(1)
      expect(getTerminals('worktree-1')[0]).toMatchObject({
        id: sessionId,
        kind: 'session',
      })
      expect(useTerminalStore.getState().activeTerminalIds['worktree-1']).toBe(
        ''
      )
      expect(useTerminalStore.getState().terminalPanelOpen['worktree-1']).toBe(
        false
      )
    })
  })

  describe('label generation', () => {
    it('generates "Shell" label for null command', () => {
      const { addTerminal, getTerminals } = useTerminalStore.getState()

      addTerminal('worktree-1', null)
      expect(getTerminals('worktree-1')[0]?.label).toBe('Shell')
    })

    it('extracts first word from command', () => {
      const { addTerminal, getTerminals } = useTerminalStore.getState()

      addTerminal('worktree-1', 'bun run build')
      expect(getTerminals('worktree-1')[0]?.label).toBe('bun')
    })

    it('removes path from command', () => {
      const { addTerminal, getTerminals } = useTerminalStore.getState()

      addTerminal('worktree-1', '/usr/local/bin/python script.py')
      expect(getTerminals('worktree-1')[0]?.label).toBe('python')
    })

    it('truncates long command names', () => {
      const { addTerminal, getTerminals } = useTerminalStore.getState()

      addTerminal(
        'worktree-1',
        'verylongcommandnamethatexceedstwentycharacters'
      )
      const label = getTerminals('worktree-1')[0]?.label
      expect(label?.length).toBeLessThanOrEqual(20)
      expect(label?.endsWith('...')).toBe(true)
    })
  })
})
