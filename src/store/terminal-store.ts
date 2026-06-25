import { create } from 'zustand'
import { getFilename } from '@/lib/path-utils'
import { generateId } from '@/lib/uuid'
import {
  countLeaves,
  firstLeafId,
  hasLeaf,
  leaf,
  pruneLeaf,
  setSizesAtPath,
  splitLeaf,
  type SplitNode,
  type SplitOrientation,
} from '@/lib/terminal-split'
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
}

/**
 * A terminal "view" — one tab in the strip. A view holds a split-pane layout
 * (tree of panel terminals) plus the pane that currently owns the keyboard.
 * A single-pane view (`layout` = one leaf) behaves exactly like a classic tab.
 * Views are session-only state (never persisted) and only ever tile panel
 * terminals; session terminals live outside any group.
 */
export interface TerminalGroup {
  id: string
  layout: SplitNode
  /** The focused pane (a leaf terminal id) within this view. */
  focusedTerminalId: string
  /** Optional user-given view name; falls back to the focused pane's label. */
  name?: string
}

export interface AddTerminalOptions {
  kind?: TerminalKind
  commandArgs?: string[] | null
  /** Whether this terminal should become active in the side/drawer terminal tab strip. */
  activate?: boolean
  /** Whether adding this terminal should open/show the side/bottom terminal panel. */
  openPanel?: boolean
}

export function isPanelTerminal(terminal: TerminalInstance): boolean {
  return (terminal.kind ?? 'panel') === 'panel'
}

interface TerminalState {
  // Terminal instances per worktree (worktreeId -> terminals). This is the flat
  // registry of every PTY-backed terminal; groups reference these by id.
  terminals: Record<string, TerminalInstance[]>
  // Views (tabs) per worktree. Each view tiles one or more panel terminals.
  groups: Record<string, TerminalGroup[]>
  // Active view (tab) per worktree.
  activeGroupIds: Record<string, string>
  // Focused pane per worktree — always a leaf of the active view's layout. Kept
  // as the canonical "current terminal" id for run-reuse, shortcuts, etc.
  activeTerminalIds: Record<string, string>
  // The terminal currently being dragged (tab or pane), or null. Lets panes
  // accept a drop only when it would actually do something (source ≠ target).
  dragTerminalId: string | null
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
  /** Reorder the views (tabs) of a worktree by group id. */
  reorderGroups: (worktreeId: string, groupIds: string[]) => void
  /** Focus a pane (and make its view active). Accepts any tiled panel terminal. */
  setActiveTerminal: (worktreeId: string, terminalId: string) => void
  /** Switch the active view (tab), focusing its remembered pane. */
  setActiveGroup: (worktreeId: string, groupId: string) => void
  /** Track the terminal being dragged for split (tab or pane); null when idle. */
  setDragTerminal: (terminalId: string | null) => void
  /** Rename a view (tab). Empty/blank name reverts to the derived label. */
  renameGroup: (worktreeId: string, groupId: string, name: string) => void
  /** Rename a terminal (pane). Empty/blank reverts to the command-derived label. */
  renameTerminal: (
    worktreeId: string,
    terminalId: string,
    label: string
  ) => void
  getTerminals: (worktreeId: string) => TerminalInstance[]
  getActiveTerminal: (worktreeId: string) => TerminalInstance | null

  // Split-pane (multiplexer) management
  /** Split the focused pane of the active view, creating a new terminal in that
   * same view. Returns its id, or undefined when there is no focusable pane. */
  splitTerminal: (
    worktreeId: string,
    orientation: SplitOrientation
  ) => string | undefined
  /** Move any pane to split `targetTerminalId` — works across views and within
   * one view (relocate). Prunes the source view (dropping it when emptied).
   * Powers drag-a-tab-onto-a-pane merges and drag-a-pane-onto-a-pane moves. */
  moveTerminalToPane: (
    worktreeId: string,
    sourceTerminalId: string,
    targetTerminalId: string,
    orientation: SplitOrientation
  ) => void
  /** Detach a pane from its split into a brand-new view (tab) right after it.
   * No-op for a single-pane view. The PTY/xterm is preserved. */
  detachPane: (worktreeId: string, terminalId: string) => void
  /** Close one pane (prune the view; remove the view when its last pane goes).
   * Does NOT stop the PTY / dispose xterm — callers handle that side effect. */
  closeSplitPane: (worktreeId: string, terminalId: string) => void
  /** Persist the panel sizes of the active view's split node at `path` (root = []). */
  setPaneSizes: (worktreeId: string, path: number[], sizes: number[]) => void

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

function generateGroupId(): string {
  return generateId()
}

/** Drop one key from a record, returning the same reference when absent so the
 * store's no-op guards hold (no spurious re-render for subscribers). */
function omitKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const { [key]: _removed, ...rest } = record
  return rest
}

/** The view containing this terminal, if any (panel terminals only). */
function findGroupOf(
  groups: TerminalGroup[],
  terminalId: string
): TerminalGroup | undefined {
  return groups.find(group => hasLeaf(group.layout, terminalId))
}

/** The currently-active view for a worktree, from a store snapshot. */
export function getActiveGroup(
  state: TerminalState,
  worktreeId: string
): TerminalGroup | undefined {
  const groups = state.groups[worktreeId] ?? []
  return groups.find(g => g.id === state.activeGroupIds[worktreeId])
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
  groups: {},
  activeGroupIds: {},
  activeTerminalIds: {},
  dragTerminalId: null,
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
    }

    set(state => {
      const existing = state.terminals[worktreeId] ?? []
      const nextState: Partial<TerminalState> = {
        terminals: {
          ...state.terminals,
          [worktreeId]: [...existing, terminal],
        },
      }

      // A new panel terminal is a new view (tab) with a single pane.
      if (kind === 'panel') {
        const group: TerminalGroup = {
          id: generateGroupId(),
          layout: leaf(id),
          focusedTerminalId: id,
        }
        const existingGroups = state.groups[worktreeId] ?? []
        nextState.groups = {
          ...state.groups,
          [worktreeId]: [...existingGroups, group],
        }
        if (activate) {
          nextState.activeGroupIds = {
            ...state.activeGroupIds,
            [worktreeId]: group.id,
          }
          nextState.activeTerminalIds = {
            ...state.activeTerminalIds,
            [worktreeId]: id,
          }
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
      const groups = state.groups[worktreeId] ?? []
      const group = findGroupOf(groups, terminalId)

      if (!hadTerminal && !wasRunning && !wasFailed && !group) {
        return state
      }

      const filtered = existing.filter(t => t.id !== terminalId)

      const newRunning = new Set(state.runningTerminals)
      newRunning.delete(terminalId)
      const newFailed = new Set(state.failedTerminals)
      newFailed.delete(terminalId)

      let nextGroups = groups
      let activeGroupId = state.activeGroupIds[worktreeId] ?? ''
      let activeTerminalId = state.activeTerminalIds[worktreeId] ?? ''

      if (group) {
        const pruned = pruneLeaf(group.layout, terminalId)
        if (pruned === null) {
          // Last pane of the view closed → drop the whole view (tab).
          const index = groups.indexOf(group)
          nextGroups = groups.filter(g => g !== group)
          if (activeGroupId === group.id) {
            const neighbour =
              nextGroups[index] ??
              nextGroups[index - 1] ??
              nextGroups[nextGroups.length - 1]
            activeGroupId = neighbour?.id ?? ''
            activeTerminalId = neighbour?.focusedTerminalId ?? ''
          }
        } else {
          const focused = hasLeaf(pruned, group.focusedTerminalId)
            ? group.focusedTerminalId
            : firstLeafId(pruned)
          const updated: TerminalGroup = {
            ...group,
            layout: pruned,
            focusedTerminalId: focused,
          }
          nextGroups = groups.map(g => (g === group ? updated : g))
          if (activeGroupId === group.id) {
            activeTerminalId = focused
          }
        }
      }

      return {
        terminals: { ...state.terminals, [worktreeId]: filtered },
        groups: { ...state.groups, [worktreeId]: nextGroups },
        activeGroupIds: {
          ...state.activeGroupIds,
          [worktreeId]: activeGroupId,
        },
        activeTerminalIds: {
          ...state.activeTerminalIds,
          [worktreeId]: activeTerminalId,
        },
        runningTerminals: newRunning,
        failedTerminals: newFailed,
      }
    }),

  reorderGroups: (worktreeId, groupIds) =>
    set(state => {
      const groups = state.groups[worktreeId] ?? []
      if (groups.length !== groupIds.length) return state

      const byId = new Map(groups.map(g => [g.id, g]))
      const reordered = groupIds.map(id => byId.get(id))
      if (reordered.some(g => !g)) return state

      const next = reordered as TerminalGroup[]
      if (next.every((g, index) => g === groups[index])) return state

      return { groups: { ...state.groups, [worktreeId]: next } }
    }),

  setActiveTerminal: (worktreeId, terminalId) =>
    set(state => {
      const groups = state.groups[worktreeId] ?? []
      const group = findGroupOf(groups, terminalId)
      if (!group) return state

      const alreadyActive =
        state.activeGroupIds[worktreeId] === group.id &&
        state.activeTerminalIds[worktreeId] === terminalId &&
        group.focusedTerminalId === terminalId
      if (alreadyActive) return state

      const nextGroups =
        group.focusedTerminalId === terminalId
          ? state.groups
          : {
              ...state.groups,
              [worktreeId]: groups.map(g =>
                g === group ? { ...g, focusedTerminalId: terminalId } : g
              ),
            }

      return {
        groups: nextGroups,
        activeGroupIds: { ...state.activeGroupIds, [worktreeId]: group.id },
        activeTerminalIds: {
          ...state.activeTerminalIds,
          [worktreeId]: terminalId,
        },
      }
    }),

  setActiveGroup: (worktreeId, groupId) =>
    set(state => {
      const groups = state.groups[worktreeId] ?? []
      const group = groups.find(g => g.id === groupId)
      if (!group) return state

      const focused = hasLeaf(group.layout, group.focusedTerminalId)
        ? group.focusedTerminalId
        : firstLeafId(group.layout)

      if (
        state.activeGroupIds[worktreeId] === groupId &&
        state.activeTerminalIds[worktreeId] === focused
      ) {
        return state
      }

      return {
        activeGroupIds: { ...state.activeGroupIds, [worktreeId]: groupId },
        activeTerminalIds: {
          ...state.activeTerminalIds,
          [worktreeId]: focused,
        },
      }
    }),

  setDragTerminal: terminalId =>
    set(state =>
      state.dragTerminalId === terminalId
        ? state
        : { dragTerminalId: terminalId }
    ),

  renameGroup: (worktreeId, groupId, name) =>
    set(state => {
      const groups = state.groups[worktreeId] ?? []
      const group = groups.find(g => g.id === groupId)
      if (!group) return state
      const trimmed = name.trim()
      const nextName = trimmed.length > 0 ? trimmed : undefined
      if (group.name === nextName) return state
      return {
        groups: {
          ...state.groups,
          [worktreeId]: groups.map(g =>
            g === group ? { ...g, name: nextName } : g
          ),
        },
      }
    }),

  renameTerminal: (worktreeId, terminalId, label) =>
    set(state => {
      const terminals = state.terminals[worktreeId] ?? []
      const terminal = terminals.find(t => t.id === terminalId)
      if (!terminal) return state
      const trimmed = label.trim()
      const nextLabel =
        trimmed.length > 0 ? trimmed : getDefaultLabel(terminal.command)
      if (terminal.label === nextLabel) return state
      return {
        terminals: {
          ...state.terminals,
          [worktreeId]: terminals.map(t =>
            t === terminal ? { ...t, label: nextLabel } : t
          ),
        },
      }
    }),

  getTerminals: worktreeId => get().terminals[worktreeId] ?? [],

  getActiveTerminal: worktreeId => {
    const terminals = get().terminals[worktreeId] ?? []
    const activeId = get().activeTerminalIds[worktreeId]
    return terminals.find(t => isPanelTerminal(t) && t.id === activeId) ?? null
  },

  splitTerminal: (worktreeId, orientation) => {
    const state = get()
    const groups = state.groups[worktreeId] ?? []
    const group = groups.find(g => g.id === state.activeGroupIds[worktreeId])
    const focusedId = state.activeTerminalIds[worktreeId]
    if (!group || !focusedId || !hasLeaf(group.layout, focusedId)) {
      return undefined
    }

    const newId = generateTerminalId()
    const terminal: TerminalInstance = {
      id: newId,
      worktreeId,
      command: null,
      commandArgs: null,
      label: getDefaultLabel(null),
      kind: 'panel',
    }

    set(s => {
      const sGroups = s.groups[worktreeId] ?? []
      const sGroup = sGroups.find(g => g.id === group.id)
      if (!sGroup) return s
      const updated: TerminalGroup = {
        ...sGroup,
        layout: splitLeaf(sGroup.layout, focusedId, orientation, newId),
        focusedTerminalId: newId,
      }
      return {
        terminals: {
          ...s.terminals,
          [worktreeId]: [...(s.terminals[worktreeId] ?? []), terminal],
        },
        groups: {
          ...s.groups,
          [worktreeId]: sGroups.map(g => (g === sGroup ? updated : g)),
        },
        activeTerminalIds: { ...s.activeTerminalIds, [worktreeId]: newId },
        terminalVisible: true,
        terminalPanelOpen: { ...s.terminalPanelOpen, [worktreeId]: true },
      }
    })

    return newId
  },

  moveTerminalToPane: (
    worktreeId,
    sourceTerminalId,
    targetTerminalId,
    orientation
  ) =>
    set(state => {
      if (sourceTerminalId === targetTerminalId) return state
      const groups = state.groups[worktreeId] ?? []
      const sourceGroup = findGroupOf(groups, sourceTerminalId)
      const targetGroup = findGroupOf(groups, targetTerminalId)
      if (!sourceGroup || !targetGroup) return state

      // Relocate within the same view: prune, then re-split at the target.
      if (sourceGroup === targetGroup) {
        const pruned = pruneLeaf(sourceGroup.layout, sourceTerminalId)
        if (!pruned) return state
        const relocated = splitLeaf(
          pruned,
          targetTerminalId,
          orientation,
          sourceTerminalId
        )
        if (relocated === pruned) return state // target vanished — give up
        const updated: TerminalGroup = {
          ...sourceGroup,
          layout: relocated,
          focusedTerminalId: sourceTerminalId,
        }
        return {
          groups: {
            ...state.groups,
            [worktreeId]: groups.map(g => (g === sourceGroup ? updated : g)),
          },
          activeGroupIds: {
            ...state.activeGroupIds,
            [worktreeId]: sourceGroup.id,
          },
          activeTerminalIds: {
            ...state.activeTerminalIds,
            [worktreeId]: sourceTerminalId,
          },
        }
      }

      // Cross-view move: splice into the target, prune the source view.
      const updatedTarget: TerminalGroup = {
        ...targetGroup,
        layout: splitLeaf(
          targetGroup.layout,
          targetTerminalId,
          orientation,
          sourceTerminalId
        ),
        focusedTerminalId: sourceTerminalId,
      }
      const prunedSource = pruneLeaf(sourceGroup.layout, sourceTerminalId)
      let nextGroups: TerminalGroup[]
      if (prunedSource === null) {
        nextGroups = groups
          .filter(g => g !== sourceGroup)
          .map(g => (g === targetGroup ? updatedTarget : g))
      } else {
        const updatedSource: TerminalGroup = {
          ...sourceGroup,
          layout: prunedSource,
          focusedTerminalId: hasLeaf(
            prunedSource,
            sourceGroup.focusedTerminalId
          )
            ? sourceGroup.focusedTerminalId
            : firstLeafId(prunedSource),
        }
        nextGroups = groups.map(g =>
          g === sourceGroup
            ? updatedSource
            : g === targetGroup
              ? updatedTarget
              : g
        )
      }

      return {
        groups: { ...state.groups, [worktreeId]: nextGroups },
        activeGroupIds: {
          ...state.activeGroupIds,
          [worktreeId]: targetGroup.id,
        },
        activeTerminalIds: {
          ...state.activeTerminalIds,
          [worktreeId]: sourceTerminalId,
        },
      }
    }),

  detachPane: (worktreeId, terminalId) =>
    set(state => {
      const groups = state.groups[worktreeId] ?? []
      const group = findGroupOf(groups, terminalId)
      // Nothing to detach from a single-pane view.
      if (!group || countLeaves(group.layout) < 2) return state

      const pruned = pruneLeaf(group.layout, terminalId)
      if (!pruned) return state
      const updatedSource: TerminalGroup = {
        ...group,
        layout: pruned,
        focusedTerminalId: hasLeaf(pruned, group.focusedTerminalId)
          ? group.focusedTerminalId
          : firstLeafId(pruned),
      }
      const newGroup: TerminalGroup = {
        id: generateGroupId(),
        layout: leaf(terminalId),
        focusedTerminalId: terminalId,
      }
      // Insert the detached view right after the source view.
      const index = groups.indexOf(group)
      const nextGroups = [...groups]
      nextGroups[index] = updatedSource
      nextGroups.splice(index + 1, 0, newGroup)

      return {
        groups: { ...state.groups, [worktreeId]: nextGroups },
        activeGroupIds: { ...state.activeGroupIds, [worktreeId]: newGroup.id },
        activeTerminalIds: {
          ...state.activeTerminalIds,
          [worktreeId]: terminalId,
        },
      }
    }),

  // Closing a pane is exactly removing its terminal: removeTerminal prunes the
  // view, drops it when empty, and re-focuses a surviving sibling.
  closeSplitPane: (worktreeId, terminalId) => {
    get().removeTerminal(worktreeId, terminalId)
  },

  setPaneSizes: (worktreeId, path, sizes) =>
    set(state => {
      const groups = state.groups[worktreeId] ?? []
      const group = groups.find(g => g.id === state.activeGroupIds[worktreeId])
      if (!group) return state
      const next = setSizesAtPath(group.layout, path, sizes)
      if (next === group.layout) return state
      return {
        groups: {
          ...state.groups,
          [worktreeId]: groups.map(g =>
            g === group ? { ...g, layout: next } : g
          ),
        },
      }
    }),

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
      // Focus the existing terminal (and its view) instead of creating one.
      const groups = state.groups[worktreeId] ?? []
      const group = findGroupOf(groups, existingTerminal.id)
      set({
        groups:
          group && group.focusedTerminalId !== existingTerminal.id
            ? {
                ...state.groups,
                [worktreeId]: groups.map(g =>
                  g === group
                    ? { ...g, focusedTerminalId: existingTerminal.id }
                    : g
                ),
              }
            : state.groups,
        activeGroupIds: group
          ? { ...state.activeGroupIds, [worktreeId]: group.id }
          : state.activeGroupIds,
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

    // No existing running terminal — create a new view (addTerminal opens panel).
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
      groups: omitKey(state.groups, worktreeId),
      activeGroupIds: {
        ...state.activeGroupIds,
        [worktreeId]: '',
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
      // Views only ever tile panel terminals, so dropping the worktree entry is
      // safe even though session terminals are preserved.
      groups: omitKey(state.groups, worktreeId),
      activeGroupIds: {
        ...state.activeGroupIds,
        [worktreeId]: '',
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
