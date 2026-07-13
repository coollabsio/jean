import { create } from 'zustand'
import { getFilename } from '@/lib/path-utils'
import { generateId } from '@/lib/uuid'
import type { ModalTerminalDockMode } from '@/types/ui-state'
import { useBrowserStore } from './browser-store'

/** A single terminal instance */
export type TerminalKind = 'panel' | 'session'

export interface TerminalInstance {
  id: string
  worktreeId: string
  command: string | null
  commandArgs?: string[] | null
  label: string
  /** Panel terminals belong to side/bottom/drawer tabs; session terminals are single full-screen sessions. */
  kind?: TerminalKind
  /** Jean session id backing this terminal (session terminals only). Enables Claude Code attention hooks. */
  sessionId?: string
}

export interface AddTerminalOptions {
  kind?: TerminalKind
  commandArgs?: string[] | null
  /** Whether this terminal should become active in the side/drawer terminal tab strip. */
  activate?: boolean
  /** Whether adding this terminal should open/show the side/bottom terminal panel. */
  openPanel?: boolean
  /** Jean session id backing this terminal (session terminals only). */
  sessionId?: string
}

export function isPanelTerminal(terminal: TerminalInstance): boolean {
  return (terminal.kind ?? 'panel') === 'panel'
}

interface TerminalState {
  // Terminal instances per worktree (worktreeId -> terminals)
  terminals: Record<string, TerminalInstance[]>
  // Active terminal ID per worktree
  activeTerminalIds: Record<string, string>
  // Set of running terminal IDs (have active PTY process)
  runningTerminals: Set<string>
  // Set of terminal IDs that exited with non-zero exit code (crash/failure)
  failedTerminals: Set<string>
  // Whether terminal panel is expanded (false = collapsed/minimized) - global since only one worktree visible
  terminalVisible: boolean
  // Whether terminal panel is open per worktree (worktreeId -> open)
  terminalPanelOpen: Record<string, boolean>
  terminalHeight: number

  // Modal terminal drawer state
  modalTerminalOpen: Record<string, boolean>
  modalTerminalDockMode: ModalTerminalDockMode
  modalTerminalWidth: number
  modalTerminalHeight: number

  setTerminalVisible: (visible: boolean) => void
  setTerminalPanelOpen: (worktreeId: string, open: boolean) => void
  isTerminalPanelOpen: (worktreeId: string) => boolean
  toggleTerminal: (worktreeId: string) => void
  setTerminalHeight: (height: number) => void

  // Modal terminal drawer methods
  setModalTerminalOpen: (worktreeId: string, open: boolean) => void
  toggleModalTerminal: (worktreeId: string) => void
  setModalTerminalDockMode: (dockMode: ModalTerminalDockMode) => void
  setModalTerminalWidth: (width: number) => void
  setModalTerminalHeight: (height: number) => void

  // Terminal instance management
  addTerminal: (
    worktreeId: string,
    command?: string | null,
    label?: string,
    options?: AddTerminalOptions
  ) => string
  removeTerminal: (worktreeId: string, terminalId: string) => void
  reorderPanelTerminals: (
    worktreeId: string,
    panelTerminalIds: string[]
  ) => void
  setActiveTerminal: (worktreeId: string, terminalId: string) => void
  getTerminals: (worktreeId: string) => TerminalInstance[]
  getActiveTerminal: (worktreeId: string) => TerminalInstance | null

  // Running state (terminal has active PTY)
  setTerminalRunning: (terminalId: string, running: boolean) => void
  isTerminalRunning: (terminalId: string) => boolean

  // Failed state (terminal exited with non-zero code)
  setTerminalFailed: (terminalId: string, failed: boolean) => void
  isTerminalFailed: (terminalId: string) => boolean

  // Start a run command (creates new terminal with command)
  startRun: (worktreeId: string, command: string) => string

  // Close all terminals for a worktree (returns terminal IDs that need to be stopped)
  closeAllTerminals: (worktreeId: string) => string[]
  // Close only side/drawer panel terminals for a worktree
  closePanelTerminals: (worktreeId: string) => string[]
}

function generateTerminalId(): string {
  return generateId()
}

/** Close every browser surface for this worktree — terminal modal and
 * browser surfaces are mutually exclusive. Called inside terminal-store
 * actions when opening the terminal modal. */
function closeBrowserSurfacesFor(worktreeId: string): void {
  const browser = useBrowserStore.getState()
  const sideOpen = browser.sidePaneOpen[worktreeId] ?? false
  const modalOpen = browser.modalOpen[worktreeId] ?? false
  const bottomOpen = browser.bottomPanelOpen[worktreeId] ?? false
  if (!sideOpen && !modalOpen && !bottomOpen) return
  useBrowserStore.setState({
    sidePaneOpen: sideOpen
      ? { ...browser.sidePaneOpen, [worktreeId]: false }
      : browser.sidePaneOpen,
    modalOpen: modalOpen
      ? { ...browser.modalOpen, [worktreeId]: false }
      : browser.modalOpen,
    bottomPanelOpen: bottomOpen
      ? { ...browser.bottomPanelOpen, [worktreeId]: false }
      : browser.bottomPanelOpen,
  })
}

function getDefaultLabel(command: string | null): string {
  if (!command) return 'Shell'
  // Extract first word or command name
  const firstWord = command.split(' ')[0] ?? command
  // Remove path if present (cross-platform)
  const name = getFilename(firstWord)
  return name.length > 20 ? name.slice(0, 17) + '...' : name
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
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

  setTerminalVisible: visible =>
    set(state =>
      state.terminalVisible === visible ? state : { terminalVisible: visible }
    ),

  setTerminalPanelOpen: (worktreeId, open) =>
    set(state => {
      if ((state.terminalPanelOpen[worktreeId] ?? false) === open) return state
      return {
        terminalPanelOpen: {
          ...state.terminalPanelOpen,
          [worktreeId]: open,
        },
      }
    }),

  isTerminalPanelOpen: worktreeId =>
    get().terminalPanelOpen[worktreeId] ?? false,

  toggleTerminal: worktreeId =>
    set(state => ({
      terminalVisible: !state.terminalVisible,
      // Also open the panel for this worktree if making visible
      terminalPanelOpen: !state.terminalVisible
        ? { ...state.terminalPanelOpen, [worktreeId]: true }
        : state.terminalPanelOpen,
    })),

  setTerminalHeight: height =>
    set(state =>
      state.terminalHeight === height ? state : { terminalHeight: height }
    ),

  setModalTerminalOpen: (worktreeId, open) => {
    const current =
      useTerminalStore.getState().modalTerminalOpen[worktreeId] ?? false
    if (current === open) return
    if (open) closeBrowserSurfacesFor(worktreeId)
    set(state => ({
      modalTerminalOpen: { ...state.modalTerminalOpen, [worktreeId]: open },
    }))
  },

  toggleModalTerminal: worktreeId => {
    const current =
      useTerminalStore.getState().modalTerminalOpen[worktreeId] ?? false
    const next = !current
    if (next) closeBrowserSurfacesFor(worktreeId)
    set(state => ({
      modalTerminalOpen: {
        ...state.modalTerminalOpen,
        [worktreeId]: next,
      },
    }))
  },

  setModalTerminalDockMode: dockMode =>
    set(state =>
      state.modalTerminalDockMode === dockMode
        ? state
        : { modalTerminalDockMode: dockMode }
    ),

  setModalTerminalWidth: width =>
    set(state =>
      state.modalTerminalWidth === width ? state : { modalTerminalWidth: width }
    ),

  setModalTerminalHeight: height =>
    set(state =>
      state.modalTerminalHeight === height
        ? state
        : { modalTerminalHeight: height }
    ),

  addTerminal: (worktreeId, command = null, label, options) => {
    const id = generateTerminalId()
    const kind = options?.kind ?? 'panel'
    const activate = options?.activate ?? kind === 'panel'
    const openPanel = options?.openPanel ?? kind === 'panel'
    const terminal: TerminalInstance = {
      id,
      worktreeId,
      command,
      commandArgs: options?.commandArgs ?? null,
      label: label ?? getDefaultLabel(command),
      kind,
      sessionId: options?.sessionId,
    }

    set(state => {
      const existing = state.terminals[worktreeId] ?? []
      const nextState: Partial<TerminalState> = {
        terminals: {
          ...state.terminals,
          [worktreeId]: [...existing, terminal],
        },
      }
      if (activate) {
        nextState.activeTerminalIds = {
          ...state.activeTerminalIds,
          [worktreeId]: id,
        }
      }
      if (openPanel) {
        nextState.terminalPanelOpen = {
          ...state.terminalPanelOpen,
          [worktreeId]: true,
        }
        nextState.terminalVisible = true
      }
      return nextState
    })

    return id
  },

  removeTerminal: (worktreeId, terminalId) =>
    set(state => {
      const existing = state.terminals[worktreeId] ?? []
      const hadTerminal = existing.some(t => t.id === terminalId)
      const wasRunning = state.runningTerminals.has(terminalId)
      const wasFailed = state.failedTerminals.has(terminalId)
      const wasActive = state.activeTerminalIds[worktreeId] === terminalId

      if (!hadTerminal && !wasRunning && !wasFailed && !wasActive) {
        return state
      }

      const filtered = existing.filter(t => t.id !== terminalId)

      // Update running terminals
      const newRunning = new Set(state.runningTerminals)
      newRunning.delete(terminalId)

      // Update failed terminals
      const newFailed = new Set(state.failedTerminals)
      newFailed.delete(terminalId)

      // Update active terminal if needed
      const currentActiveId = state.activeTerminalIds[worktreeId] ?? ''
      const newActiveId =
        currentActiveId === terminalId
          ? (filtered.filter(isPanelTerminal).at(-1)?.id ?? '')
          : currentActiveId

      return {
        terminals: {
          ...state.terminals,
          [worktreeId]: filtered,
        },
        activeTerminalIds: {
          ...state.activeTerminalIds,
          [worktreeId]: newActiveId,
        },
        runningTerminals: newRunning,
        failedTerminals: newFailed,
      }
    }),

  reorderPanelTerminals: (worktreeId, panelTerminalIds) =>
    set(state => {
      const existing = state.terminals[worktreeId] ?? []
      const panelTerminals = existing.filter(isPanelTerminal)
      if (panelTerminals.length !== panelTerminalIds.length) return state

      const panelById = new Map(panelTerminals.map(t => [t.id, t]))
      const reorderedPanels = panelTerminalIds.map(id => panelById.get(id))
      if (reorderedPanels.some(t => !t)) return state

      const nextPanels = reorderedPanels as TerminalInstance[]
      let panelIndex = 0
      const next = existing.map(terminal => {
        if (!isPanelTerminal(terminal)) return terminal
        const nextPanel = nextPanels[panelIndex]
        panelIndex += 1
        return nextPanel ?? terminal
      })

      if (next.every((terminal, index) => terminal === existing[index])) {
        return state
      }

      return {
        terminals: {
          ...state.terminals,
          [worktreeId]: next,
        },
      }
    }),

  setActiveTerminal: (worktreeId, terminalId) =>
    set(state => {
      const terminal = (state.terminals[worktreeId] ?? []).find(
        t => t.id === terminalId
      )
      if (!terminal || !isPanelTerminal(terminal)) return state
      if (state.activeTerminalIds[worktreeId] === terminalId) return state
      return {
        activeTerminalIds: {
          ...state.activeTerminalIds,
          [worktreeId]: terminalId,
        },
      }
    }),

  getTerminals: worktreeId => get().terminals[worktreeId] ?? [],

  getActiveTerminal: worktreeId => {
    const terminals = get().terminals[worktreeId] ?? []
    const activeId = get().activeTerminalIds[worktreeId]
    return terminals.find(t => isPanelTerminal(t) && t.id === activeId) ?? null
  },

  setTerminalRunning: (terminalId, running) =>
    set(state => {
      if (running === state.runningTerminals.has(terminalId)) return state
      const newSet = new Set(state.runningTerminals)
      if (running) {
        newSet.add(terminalId)
      } else {
        newSet.delete(terminalId)
      }
      return { runningTerminals: newSet }
    }),

  isTerminalRunning: terminalId => get().runningTerminals.has(terminalId),

  setTerminalFailed: (terminalId, failed) =>
    set(state => {
      if (failed === state.failedTerminals.has(terminalId)) return state
      const newSet = new Set(state.failedTerminals)
      if (failed) {
        newSet.add(terminalId)
      } else {
        newSet.delete(terminalId)
      }
      return { failedTerminals: newSet }
    }),

  isTerminalFailed: terminalId => get().failedTerminals.has(terminalId),

  startRun: (worktreeId, command) => {
    const state = get()
    const terminals = state.terminals[worktreeId] ?? []
    const panelTerminals = terminals.filter(isPanelTerminal)

    // Check if there's already a running terminal with this command
    const existingTerminal = panelTerminals.find(
      t => t.command === command && state.runningTerminals.has(t.id)
    )

    if (existingTerminal) {
      // Focus the existing terminal instead of creating a new one
      set({
        activeTerminalIds: {
          ...state.activeTerminalIds,
          [worktreeId]: existingTerminal.id,
        },
        terminalVisible: true,
        terminalPanelOpen: {
          ...state.terminalPanelOpen,
          [worktreeId]: true,
        },
      })
      return existingTerminal.id
    }

    // Clear stale failed IDs for this worktree's command terminals
    const failedIds = panelTerminals.filter(
      t => t.command && state.failedTerminals.has(t.id)
    )
    if (failedIds.length > 0) {
      const newFailed = new Set(state.failedTerminals)
      for (const t of failedIds) newFailed.delete(t.id)
      set({ failedTerminals: newFailed })
    }

    // No existing running terminal, create a new one (addTerminal sets terminalPanelOpen)
    return get().addTerminal(worktreeId, command)
  },

  closeAllTerminals: worktreeId => {
    const state = get()
    const terminals = state.terminals[worktreeId] ?? []
    const terminalIds = terminals.map(t => t.id)

    if (
      terminalIds.length === 0 &&
      !state.activeTerminalIds[worktreeId] &&
      !(state.terminalPanelOpen[worktreeId] ?? false)
    ) {
      return []
    }

    // Remove all running/failed terminal IDs for this worktree
    const newRunning = new Set(state.runningTerminals)
    const newFailed = new Set(state.failedTerminals)
    for (const id of terminalIds) {
      newRunning.delete(id)
      newFailed.delete(id)
    }

    set({
      terminals: {
        ...state.terminals,
        [worktreeId]: [],
      },
      activeTerminalIds: {
        ...state.activeTerminalIds,
        [worktreeId]: '',
      },
      runningTerminals: newRunning,
      failedTerminals: newFailed,
      terminalPanelOpen: {
        ...state.terminalPanelOpen,
        [worktreeId]: false,
      },
      // Don't set terminalVisible=false as that's global and affects other worktrees
    })

    return terminalIds
  },

  closePanelTerminals: worktreeId => {
    const state = get()
    const terminals = state.terminals[worktreeId] ?? []
    const panelTerminalIds = terminals.filter(isPanelTerminal).map(t => t.id)
    const sessionTerminals = terminals.filter(t => !isPanelTerminal(t))

    if (
      panelTerminalIds.length === 0 &&
      !state.activeTerminalIds[worktreeId] &&
      !(state.terminalPanelOpen[worktreeId] ?? false)
    ) {
      return []
    }

    const newRunning = new Set(state.runningTerminals)
    const newFailed = new Set(state.failedTerminals)
    for (const id of panelTerminalIds) {
      newRunning.delete(id)
      newFailed.delete(id)
    }

    set({
      terminals: {
        ...state.terminals,
        [worktreeId]: sessionTerminals,
      },
      activeTerminalIds: {
        ...state.activeTerminalIds,
        [worktreeId]: '',
      },
      runningTerminals: newRunning,
      failedTerminals: newFailed,
      terminalPanelOpen: {
        ...state.terminalPanelOpen,
        [worktreeId]: false,
      },
    })

    return panelTerminalIds
  },
}))
