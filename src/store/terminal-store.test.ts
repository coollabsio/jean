import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTerminalStore, type TerminalGroup } from './terminal-store'
import { collectLeafIds, leaf } from '@/lib/terminal-split'

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
      groups: {},
      activeGroupIds: {},
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

    it('reorders views (tabs) by group id without changing the active view', () => {
      const { addTerminal, reorderGroups } = useTerminalStore.getState()

      addTerminal('worktree-1', null, 'A')
      addTerminal('worktree-1', null, 'B')
      addTerminal('worktree-1', null, 'C') // last added view is active

      const groupIds = (
        useTerminalStore.getState().groups['worktree-1'] ?? []
      ).map(g => g.id)
      const [gA, gB, gC] = groupIds

      reorderGroups('worktree-1', [gC as string, gA as string, gB as string])

      const state = useTerminalStore.getState()
      expect(state.groups['worktree-1']?.map(g => g.id)).toEqual([gC, gA, gB])
      // Active view is preserved across reorder.
      expect(state.activeGroupIds['worktree-1']).toBe(gC)
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

  describe('views (split panes / multiplexer)', () => {
    const requireActiveGroup = (worktreeId: string): TerminalGroup => {
      const s = useTerminalStore.getState()
      const group = (s.groups[worktreeId] ?? []).find(
        g => g.id === s.activeGroupIds[worktreeId]
      )
      if (!group) throw new Error('no active group')
      return group
    }

    it('each new terminal is its own single-pane view (tab)', () => {
      const { addTerminal } = useTerminalStore.getState()
      addTerminal('w1')
      addTerminal('w1')
      const s = useTerminalStore.getState()
      expect(s.groups['w1']).toHaveLength(2)
      expect(
        s.groups['w1']?.every(g => collectLeafIds(g.layout).length === 1)
      ).toBe(true)
    })

    it('splitTerminal adds a pane to the ACTIVE view (no new tab) and focuses it', () => {
      const { addTerminal, splitTerminal } = useTerminalStore.getState()
      const a = addTerminal('w1')
      const groupId = useTerminalStore.getState().activeGroupIds['w1']

      const newId = splitTerminal('w1', 'horizontal')

      const s = useTerminalStore.getState()
      expect(newId).toBeDefined()
      expect(s.groups['w1']).toHaveLength(1) // same view, no extra tab
      expect(s.activeGroupIds['w1']).toBe(groupId)
      const group = requireActiveGroup('w1')
      expect(group.layout.type).toBe('split')
      expect(group.layout.type === 'split' && group.layout.orientation).toBe(
        'horizontal'
      )
      expect(collectLeafIds(group.layout)).toEqual([a, newId])
      expect(s.activeTerminalIds['w1']).toBe(newId)
      expect(group.focusedTerminalId).toBe(newId)
    })

    it('does not split without an active view', () => {
      expect(
        useTerminalStore.getState().splitTerminal('w1', 'horizontal')
      ).toBeUndefined()
      expect(useTerminalStore.getState().groups['w1']).toBeUndefined()
    })

    it('supports nested mixed (H + V) splits within a view', () => {
      const { addTerminal, splitTerminal } = useTerminalStore.getState()
      const a = addTerminal('w1')
      const b = splitTerminal('w1', 'horizontal')
      const c = splitTerminal('w1', 'vertical')

      const group = requireActiveGroup('w1')
      expect(collectLeafIds(group.layout)).toEqual([a, b, c])
      expect(group.layout.type === 'split' && group.layout.orientation).toBe(
        'horizontal'
      )
    })

    it('closeSplitPane prunes a pane and keeps the view (now single pane)', () => {
      const { addTerminal, splitTerminal, closeSplitPane } =
        useTerminalStore.getState()
      const a = addTerminal('w1')
      const b = splitTerminal('w1', 'horizontal')

      closeSplitPane('w1', b as string)

      const s = useTerminalStore.getState()
      expect(s.terminals['w1']?.map(t => t.id)).toEqual([a])
      expect(s.groups['w1']).toHaveLength(1)
      expect(collectLeafIds(requireActiveGroup('w1').layout)).toEqual([a])
      expect(s.activeTerminalIds['w1']).toBe(a)
    })

    it('closeSplitPane keeps the split when 3 → 2 panes remain', () => {
      const { addTerminal, splitTerminal, closeSplitPane } =
        useTerminalStore.getState()
      const a = addTerminal('w1')
      const b = splitTerminal('w1', 'horizontal')
      const c = splitTerminal('w1', 'horizontal')

      closeSplitPane('w1', c as string)

      expect(collectLeafIds(requireActiveGroup('w1').layout)).toEqual([a, b])
    })

    it('closing the last pane removes the view and selects a neighbour', () => {
      const { addTerminal, removeTerminal } = useTerminalStore.getState()
      const a = addTerminal('w1') // view A
      const b = addTerminal('w1') // view B (active)

      removeTerminal('w1', b)

      const s = useTerminalStore.getState()
      expect(s.groups['w1']).toHaveLength(1)
      expect(s.activeGroupIds['w1']).toBe(s.groups['w1']?.[0]?.id)
      expect(s.activeTerminalIds['w1']).toBe(a)
    })

    it('removeTerminal of a tiled pane prunes its view', () => {
      const { addTerminal, splitTerminal, removeTerminal } =
        useTerminalStore.getState()
      const a = addTerminal('w1')
      const b = splitTerminal('w1', 'horizontal')

      removeTerminal('w1', a)

      expect(useTerminalStore.getState().groups['w1']).toHaveLength(1)
      expect(collectLeafIds(requireActiveGroup('w1').layout)).toEqual([b])
    })

    it('moveTerminalToPane merges a single-pane view into another view', () => {
      const { addTerminal, moveTerminalToPane } = useTerminalStore.getState()
      const a = addTerminal('w1') // view A
      const b = addTerminal('w1') // view B (active)

      moveTerminalToPane('w1', a, b, 'horizontal')

      const s = useTerminalStore.getState()
      expect(s.groups['w1']).toHaveLength(1) // source view removed
      // splitLeaf puts the target pane first, the moved terminal second.
      expect(collectLeafIds(requireActiveGroup('w1').layout)).toEqual([b, a])
      expect(s.activeTerminalIds['w1']).toBe(a)
    })

    it('moveTerminalToPane moves a pane out of a multi-pane view (source survives)', () => {
      const { addTerminal, splitTerminal, moveTerminalToPane } =
        useTerminalStore.getState()
      const a = addTerminal('w1') // view A (single)
      const bTerm = addTerminal('w1') // view B (active)
      const cTerm = splitTerminal('w1', 'horizontal') // view B = [bTerm, cTerm]

      // Move cTerm out of view B into view A.
      moveTerminalToPane('w1', cTerm as string, a, 'horizontal')

      const s = useTerminalStore.getState()
      expect(s.groups['w1']).toHaveLength(2) // both views survive
      const groups = s.groups['w1'] ?? []
      // View A now tiles [a, cTerm]; view B collapsed to [bTerm].
      const viewA = groups.find(g => collectLeafIds(g.layout).includes(a))
      const viewB = groups.find(g => collectLeafIds(g.layout).includes(bTerm))
      expect(viewA && collectLeafIds(viewA.layout)).toEqual([a, cTerm])
      expect(viewB && collectLeafIds(viewB.layout)).toEqual([bTerm])
      expect(s.activeTerminalIds['w1']).toBe(cTerm)
    })

    it('moveTerminalToPane relocates a pane within the same view', () => {
      const { addTerminal, splitTerminal, moveTerminalToPane } =
        useTerminalStore.getState()
      const a = addTerminal('w1')
      const b = splitTerminal('w1', 'horizontal') // view = [a, b] horizontal

      // Relocate a to split b vertically ⇒ [b, a] vertical, still one view.
      moveTerminalToPane('w1', a, b as string, 'vertical')

      const s = useTerminalStore.getState()
      expect(s.groups['w1']).toHaveLength(1)
      const layout = requireActiveGroup('w1').layout
      expect(collectLeafIds(layout)).toEqual([b, a])
      expect(layout.type === 'split' && layout.orientation).toBe('vertical')
      expect(s.activeTerminalIds['w1']).toBe(a)
    })

    it('detachPane pops a pane out of a split into its own view', () => {
      const { addTerminal, splitTerminal, detachPane } =
        useTerminalStore.getState()
      const a = addTerminal('w1')
      const b = splitTerminal('w1', 'horizontal') // one view [a, b]

      detachPane('w1', b as string)

      const s = useTerminalStore.getState()
      expect(s.groups['w1']).toHaveLength(2) // source view + new detached view
      const groups = s.groups['w1'] ?? []
      expect(collectLeafIds(groups[0]?.layout ?? leaf('x'))).toEqual([a])
      expect(collectLeafIds(groups[1]?.layout ?? leaf('x'))).toEqual([b])
      // The detached pane becomes the active view/terminal.
      expect(s.activeTerminalIds['w1']).toBe(b)
      expect(s.activeGroupIds['w1']).toBe(groups[1]?.id)
    })

    it('detachPane is a no-op for a single-pane view', () => {
      const { addTerminal, detachPane } = useTerminalStore.getState()
      addTerminal('w1')
      const before = useTerminalStore.getState().groups['w1']
      detachPane(
        'w1',
        collectLeafIds(before?.[0]?.layout ?? leaf('x'))[0] ?? ''
      )
      expect(useTerminalStore.getState().groups['w1']).toBe(before)
    })

    it('setDragTerminal tracks the dragged terminal and guards no-ops', () => {
      const { setDragTerminal } = useTerminalStore.getState()
      setDragTerminal('t1')
      expect(useTerminalStore.getState().dragTerminalId).toBe('t1')
      const ref = useTerminalStore.getState()
      setDragTerminal('t1') // no-op ⇒ same state reference
      expect(useTerminalStore.getState()).toBe(ref)
      setDragTerminal(null)
      expect(useTerminalStore.getState().dragTerminalId).toBeNull()
    })

    it('renameGroup sets a custom view name (trimmed); blank reverts it', () => {
      const { addTerminal, renameGroup } = useTerminalStore.getState()
      addTerminal('w1')
      const groupId = useTerminalStore.getState().groups['w1']?.[0]?.id ?? ''

      renameGroup('w1', groupId, '  Build  ')
      expect(useTerminalStore.getState().groups['w1']?.[0]?.name).toBe('Build')

      renameGroup('w1', groupId, '   ')
      expect(
        useTerminalStore.getState().groups['w1']?.[0]?.name
      ).toBeUndefined()
    })

    it('renameTerminal sets a custom label; blank reverts to the derived one', () => {
      const { addTerminal, renameTerminal, getTerminals } =
        useTerminalStore.getState()
      const id = addTerminal('w1', 'bun run dev') // derived label "bun"

      renameTerminal('w1', id, 'Dev server')
      expect(getTerminals('w1')[0]?.label).toBe('Dev server')

      renameTerminal('w1', id, '   ')
      expect(getTerminals('w1')[0]?.label).toBe('bun')
    })

    it('setActiveGroup switches the active view and its focus', () => {
      const { addTerminal, setActiveGroup } = useTerminalStore.getState()
      addTerminal('w1') // view A
      addTerminal('w1') // view B (active)

      const groupA = useTerminalStore.getState().groups['w1']?.[0]
      if (!groupA) throw new Error('missing group')
      setActiveGroup('w1', groupA.id)

      const s = useTerminalStore.getState()
      expect(s.activeGroupIds['w1']).toBe(groupA.id)
      expect(s.activeTerminalIds['w1']).toBe(groupA.focusedTerminalId)
    })

    it('setPaneSizes stores sizes on the active view and guards no-ops', () => {
      const { addTerminal, splitTerminal, setPaneSizes } =
        useTerminalStore.getState()
      addTerminal('w1')
      splitTerminal('w1', 'horizontal')

      setPaneSizes('w1', [], [30, 70])
      const group = requireActiveGroup('w1')
      expect(group.layout.type === 'split' && group.layout.sizes).toEqual([
        30, 70,
      ])

      const groupsRef = useTerminalStore.getState().groups['w1']
      setPaneSizes('w1', [], [30, 70]) // no-op ⇒ same groups reference
      expect(useTerminalStore.getState().groups['w1']).toBe(groupsRef)
    })

    it('closeAllTerminals clears all views', () => {
      const { addTerminal, splitTerminal, closeAllTerminals } =
        useTerminalStore.getState()
      addTerminal('w1')
      splitTerminal('w1', 'horizontal')

      closeAllTerminals('w1')

      expect(useTerminalStore.getState().groups['w1']).toBeUndefined()
      expect(useTerminalStore.getState().activeGroupIds['w1']).toBe('')
    })

    it('closePanelTerminals clears all views', () => {
      const { addTerminal, splitTerminal, closePanelTerminals } =
        useTerminalStore.getState()
      addTerminal('w1')
      splitTerminal('w1', 'horizontal')

      closePanelTerminals('w1')

      expect(useTerminalStore.getState().groups['w1']).toBeUndefined()
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
