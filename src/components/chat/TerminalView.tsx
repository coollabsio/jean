import { useEffect, useRef, useCallback, useMemo, memo, useState } from 'react'
import {
  Plus,
  X,
  Minus,
  Terminal,
  ChevronUp,
  SquareSplitHorizontal,
  SquareSplitVertical,
} from 'lucide-react'
import { invoke } from '@/lib/transport'
import { useTerminal } from '@/hooks/useTerminal'
import { useTerminalBackgroundColor } from '@/hooks/useTerminalThemeSync'
import { useIsMobile } from '@/hooks/use-mobile'
import { isNativeApp } from '@/lib/environment'
import {
  isPanelTerminal,
  useTerminalStore,
  type TerminalGroup,
  type TerminalInstance,
} from '@/store/terminal-store'
import {
  collectLeafIds,
  countLeaves,
  firstLeafId,
  type SplitOrientation,
} from '@/lib/terminal-split'
import {
  disposeTerminal,
  disposePanelWorktreeTerminals,
} from '@/lib/terminal-instances'
import { Kbd } from '@/components/ui/kbd'
import { formatShortcutDisplay } from '@/types/keybindings'
import { cn } from '@/lib/utils'
import { MODAL_TERMINAL_SECONDARY_ROW_CLASS } from './modal-terminal-layout'
import { TerminalSplitLayout } from './TerminalSplitLayout'
import '@xterm/xterm/css/xterm.css'

const EMPTY_TERMINALS: TerminalInstance[] = []
const EMPTY_GROUPS: TerminalGroup[] = []
const EMPTY_ID_SET: ReadonlySet<string> = new Set()

/** Tiny inline text editor for renaming a view (tab) or a pane. Commits on
 * Enter/blur, cancels on Escape. Selects all on focus for quick overwrite. */
export function InlineRename({
  value,
  onCommit,
  onCancel,
  className,
  ariaLabel,
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
  className?: string
  /** Accessible name for the rename field (e.g. "Rename view"/"Rename pane"). */
  ariaLabel?: string
}) {
  const [draft, setDraft] = useState(value)
  return (
    <input
      autoFocus
      aria-label={ariaLabel}
      value={draft}
      onChange={e => setDraft(e.target.value)}
      onFocus={e => e.currentTarget.select()}
      // Don't let the click/drag reach the tab/pane underneath.
      onClick={e => e.stopPropagation()}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') onCommit(draft)
        else if (e.key === 'Escape') onCancel()
      }}
      onBlur={() => onCommit(draft)}
      className={cn(
        'min-w-0 rounded border border-border bg-background px-1 text-xs text-foreground outline-none',
        className
      )}
    />
  )
}

interface TerminalViewProps {
  worktreeId: string
  worktreePath: string
  isCollapsed?: boolean
  isWorktreeActive?: boolean
  onExpand?: () => void
  /** Hide minimize and close-all buttons (for use in drawer) */
  hideControls?: boolean
}

/**
 * Individual terminal content surface.
 *
 * `isVisible` gates PTY attach + fit (a terminal is visible when it is the
 * active tab in single mode, or a leaf in the current split layout). Hidden
 * terminals stay mounted to preserve their scrollback buffers — they are never
 * detached here; teardown happens explicitly on close. `isFocused` drives
 * keyboard focus — exactly one visible pane is focused at a time so multiple
 * split panes don't fight over `focus()`.
 */
export const TerminalTabContent = memo(function TerminalTabContent({
  terminal,
  worktreeId,
  worktreePath,
  isVisible,
  isFocused = false,
  isCollapsed = false,
  isWorktreeActive = true,
}: {
  terminal: TerminalInstance
  worktreeId: string
  worktreePath: string
  isVisible: boolean
  isFocused?: boolean
  isCollapsed?: boolean
  isWorktreeActive?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalBg = useTerminalBackgroundColor()
  const { initTerminal, fit, focus } = useTerminal({
    terminalId: terminal.id,
    worktreeId,
    worktreePath,
    command: terminal.command,
    commandArgs: terminal.commandArgs,
  })
  const initialized = useRef(false)
  const canAttach = isVisible && !isCollapsed && isWorktreeActive

  useEffect(() => {
    if (containerRef.current && !initialized.current && canAttach) {
      initialized.current = true
      initTerminal(containerRef.current)
    }
  }, [initTerminal, canAttach])

  // Handle resize with debouncing
  useEffect(() => {
    if (!canAttach) return

    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const observer = new ResizeObserver(() => {
      // Debounce fit calls to ensure container has settled
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        if (canAttach) fit()
      }, 50)
    })

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
      observer.disconnect()
    }
  }, [fit, canAttach])

  // Fit when becoming visible (active tab, expand from collapsed, worktree shown
  // or split pane resize). Runs for every visible pane.
  useEffect(() => {
    if (canAttach && initialized.current) {
      requestAnimationFrame(() => fit())
    }
  }, [canAttach, fit])

  // Grab the keyboard only for the focused pane.
  useEffect(() => {
    if (canAttach && isFocused && initialized.current) {
      requestAnimationFrame(() => focus())
    }
  }, [canAttach, isFocused, focus])

  return (
    <div
      className={cn('h-full w-full p-2', !isVisible && 'hidden')}
      style={{ backgroundColor: terminalBg }}
    >
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
    </div>
  )
})

export const SingleTerminalView = memo(function SingleTerminalView({
  terminalId,
  worktreeId,
  worktreePath,
  isActive = true,
  isWorktreeActive = true,
}: {
  terminalId: string
  worktreeId: string
  worktreePath: string
  isActive?: boolean
  isWorktreeActive?: boolean
}) {
  const terminal = useTerminalStore(state =>
    (state.terminals[worktreeId] ?? EMPTY_TERMINALS).find(
      item => item.id === terminalId
    )
  )

  if (!terminal) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Terminal session not found
      </div>
    )
  }

  return (
    <div className="h-full min-h-0 w-full overflow-hidden bg-background">
      <TerminalTabContent
        key={terminal.id}
        terminal={terminal}
        worktreeId={worktreeId}
        worktreePath={worktreePath}
        isVisible={isActive}
        isFocused={isActive}
        isWorktreeActive={isWorktreeActive}
      />
    </div>
  )
})

export function TerminalView({
  worktreeId,
  worktreePath,
  isCollapsed = false,
  isWorktreeActive = true,
  onExpand,
  hideControls = false,
}: TerminalViewProps) {
  const allTerminals = useTerminalStore(
    state => state.terminals[worktreeId] ?? EMPTY_TERMINALS
  )
  const groups = useTerminalStore(
    state => state.groups[worktreeId] ?? EMPTY_GROUPS
  )
  const activeGroupId = useTerminalStore(
    state => state.activeGroupIds[worktreeId]
  )
  const activeTerminalId = useTerminalStore(
    state => state.activeTerminalIds[worktreeId]
  )
  const runningTerminals = useTerminalStore(state => state.runningTerminals)

  // Split panes are a native-desktop affordance; web/mobile stay single-pane
  // (no split buttons, no drag-to-merge — views created there are always 1 pane).
  const isMobile = useIsMobile()
  const splitEnabled = isNativeApp() && !isMobile

  const panelTerminals = useMemo(
    () => allTerminals.filter(isPanelTerminal),
    [allTerminals]
  )
  const terminalsById = useMemo(() => {
    const map = new Map<string, TerminalInstance>()
    for (const terminal of allTerminals) map.set(terminal.id, terminal)
    return map
  }, [allTerminals])
  const hasRunningPanelTerminal = panelTerminals.some(terminal =>
    runningTerminals.has(terminal.id)
  )

  const activeGroup = useMemo(
    () => groups.find(group => group.id === activeGroupId) ?? groups[0],
    [groups, activeGroupId]
  )
  const activeLeafIds = useMemo<ReadonlySet<string>>(
    () =>
      activeGroup ? new Set(collectLeafIds(activeGroup.layout)) : EMPTY_ID_SET,
    [activeGroup]
  )
  const hiddenTerminals = useMemo(
    () => panelTerminals.filter(terminal => !activeLeafIds.has(terminal.id)),
    [panelTerminals, activeLeafIds]
  )
  const activePaneCount = activeGroup ? countLeaves(activeGroup.layout) : 0

  const {
    addTerminal,
    reorderGroups,
    setTerminalVisible,
    setTerminalPanelOpen,
  } = useTerminalStore.getState()
  const [draggedGroupId, setDraggedGroupId] = useState<string | null>(null)
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null)

  const handleRenameGroup = useCallback(
    (groupId: string, name: string) => {
      useTerminalStore.getState().renameGroup(worktreeId, groupId, name)
      setEditingGroupId(null)
    },
    [worktreeId]
  )

  // Auto-create a view only on initial mount (not when tabs are closed)
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      const existingGroups =
        useTerminalStore.getState().groups[worktreeId] ?? []
      if (existingGroups.length === 0) {
        addTerminal(worktreeId)
      }
    }
  }, [worktreeId, addTerminal])

  const handleAddTerminal = useCallback(() => {
    addTerminal(worktreeId)
  }, [worktreeId, addTerminal])

  const closePanelIfEmpty = useCallback(() => {
    const remaining = (
      useTerminalStore.getState().terminals[worktreeId] ?? []
    ).filter(isPanelTerminal)
    if (remaining.length === 0) {
      setTerminalPanelOpen(worktreeId, false)
      setTerminalVisible(false)
      useTerminalStore.getState().setModalTerminalOpen(worktreeId, false)
    }
  }, [worktreeId, setTerminalPanelOpen, setTerminalVisible])

  const stopAndDispose = useCallback(async (terminalId: string) => {
    try {
      await invoke('stop_terminal', { terminalId })
    } catch {
      // Terminal may already be stopped
    }
    // disposeTerminal is async; swallow rejection so the chain never rejects.
    await disposeTerminal(terminalId).catch(() => {
      /* already disposed */
    })
  }, [])

  // Close a whole view (tab): every pane it contains.
  const handleCloseGroup = useCallback(
    async (e: React.MouseEvent, groupId: string) => {
      e.stopPropagation()
      const group = (useTerminalStore.getState().groups[worktreeId] ?? []).find(
        g => g.id === groupId
      )
      if (!group) return
      const leafIds = collectLeafIds(group.layout)
      // Stop/dispose every pane concurrently rather than serially — for a
      // multi-pane view this avoids stacking one PTY round-trip per pane.
      await Promise.all(leafIds.map(stopAndDispose))
      for (const terminalId of leafIds) {
        useTerminalStore.getState().removeTerminal(worktreeId, terminalId)
      }
      closePanelIfEmpty()
    },
    [worktreeId, stopAndDispose, closePanelIfEmpty]
  )

  // Close a single pane within the active view.
  const handleCloseSplitPane = useCallback(
    async (terminalId: string) => {
      await stopAndDispose(terminalId)
      useTerminalStore.getState().closeSplitPane(worktreeId, terminalId)
      closePanelIfEmpty()
    },
    [worktreeId, stopAndDispose, closePanelIfEmpty]
  )

  const handleSelectGroup = useCallback(
    (groupId: string) => {
      useTerminalStore.getState().setActiveGroup(worktreeId, groupId)
    },
    [worktreeId]
  )

  const handleSplit = useCallback(
    (orientation: SplitOrientation) => {
      useTerminalStore.getState().splitTerminal(worktreeId, orientation)
    },
    [worktreeId]
  )

  const handleDetachPane = useCallback(
    (terminalId: string) => {
      useTerminalStore.getState().detachPane(worktreeId, terminalId)
    },
    [worktreeId]
  )

  const handleRenameTerminal = useCallback(
    (terminalId: string, label: string) => {
      useTerminalStore.getState().renameTerminal(worktreeId, terminalId, label)
    },
    [worktreeId]
  )

  // A tab or pane was dropped on a pane. `payload` is `pane:<id>` (move that
  // pane) or `group:<id>` (merge that single-pane view's terminal).
  const handlePaneDrop = useCallback(
    (
      targetTerminalId: string,
      orientation: SplitOrientation,
      payload: string
    ) => {
      const store = useTerminalStore.getState()
      if (payload.startsWith('pane:')) {
        store.moveTerminalToPane(
          worktreeId,
          payload.slice('pane:'.length),
          targetTerminalId,
          orientation
        )
        return
      }
      if (payload.startsWith('group:')) {
        const sourceGroup = (store.groups[worktreeId] ?? []).find(
          g => g.id === payload.slice('group:'.length)
        )
        // Only single-pane tabs merge into a pane (a whole split can't).
        if (!sourceGroup || countLeaves(sourceGroup.layout) !== 1) return
        store.moveTerminalToPane(
          worktreeId,
          firstLeafId(sourceGroup.layout),
          targetTerminalId,
          orientation
        )
      }
    },
    [worktreeId]
  )

  const handleGroupDragStart = useCallback(
    (e: React.DragEvent<HTMLButtonElement>, groupId: string) => {
      setDraggedGroupId(groupId)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', `group:${groupId}`)
      // Only single-pane views can drop onto a pane; expose that terminal so
      // panes can validate the drop (multi-pane tabs only reorder).
      const grp = (useTerminalStore.getState().groups[worktreeId] ?? []).find(
        g => g.id === groupId
      )
      useTerminalStore
        .getState()
        .setDragTerminal(
          grp && countLeaves(grp.layout) === 1 ? firstLeafId(grp.layout) : null
        )
    },
    [worktreeId]
  )

  const handleGroupDragEnd = useCallback(() => {
    setDraggedGroupId(null)
    useTerminalStore.getState().setDragTerminal(null)
  }, [])

  const handleGroupDragOver = useCallback(
    (e: React.DragEvent<HTMLButtonElement>) => {
      if (!draggedGroupId) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    [draggedGroupId]
  )

  const handleGroupDrop = useCallback(
    (e: React.DragEvent<HTMLButtonElement>, targetGroupId: string) => {
      e.preventDefault()
      const raw = e.dataTransfer.getData('text/plain')
      // Only tab (group) drags reorder; a pane dropped on a tab is ignored.
      const sourceId =
        draggedGroupId ?? (raw.startsWith('group:') ? raw.slice(6) : null)
      setDraggedGroupId(null)
      // Clear the cross-pane drag id here too — don't rely solely on dragEnd,
      // which may not fire when the drop is handled outside the drag source.
      useTerminalStore.getState().setDragTerminal(null)
      if (!sourceId || sourceId === targetGroupId) return

      const ids = groups.map(group => group.id)
      const fromIndex = ids.indexOf(sourceId)
      const toIndex = ids.indexOf(targetGroupId)
      if (fromIndex === -1 || toIndex === -1) return

      ids.splice(fromIndex, 1)
      ids.splice(toIndex, 0, sourceId)
      reorderGroups(worktreeId, ids)
    },
    [draggedGroupId, reorderGroups, groups, worktreeId]
  )

  const handleMinimize = useCallback(() => {
    setTerminalVisible(false)
  }, [setTerminalVisible])

  const handleCloseAll = useCallback(() => {
    // Dispose side/drawer terminal tabs only; session terminals are independent.
    disposePanelWorktreeTerminals(worktreeId)
  }, [worktreeId])

  // When collapsed, show collapsed bar but keep terminals mounted (hidden) to preserve state
  if (isCollapsed) {
    return (
      <div className="flex h-full flex-col bg-background">
        {/* Collapsed bar */}
        <button
          type="button"
          onClick={onExpand}
          className="flex h-full w-full items-center gap-2 px-3 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
        >
          <Terminal className="h-3.5 w-3.5" />
          <span>Terminal</span>
          {hasRunningPanelTerminal && (
            <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
          )}
          <div className="flex-1" />
          <ChevronUp className="h-3.5 w-3.5" />
        </button>
        {/* Keep terminals mounted but hidden to preserve state */}
        <div className="hidden">
          {panelTerminals.map(terminal => (
            <TerminalTabContent
              key={terminal.id}
              terminal={terminal}
              worktreeId={worktreeId}
              worktreePath={worktreePath}
              isVisible={activeLeafIds.has(terminal.id)}
              isCollapsed
              isWorktreeActive={isWorktreeActive}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Tab bar - fixed height for consistency */}
      <div
        className={cn(
          'flex items-stretch border-b border-border',
          MODAL_TERMINAL_SECONDARY_ROW_CLASS
        )}
      >
        <div className="flex min-w-0 items-center overflow-x-auto">
          {groups.map((group, index) => {
            const isActive = group.id === activeGroupId
            const leafIds = collectLeafIds(group.layout)
            const paneCount = leafIds.length
            const isRunning = leafIds.some(id => runningTerminals.has(id))
            const derivedLabel =
              terminalsById.get(group.focusedTerminalId)?.label ??
              terminalsById.get(leafIds[0] ?? '')?.label ??
              'Shell'
            const label = group.name ?? derivedLabel
            const isEditing = editingGroupId === group.id
            const shortcutLabel =
              index < 9 ? formatShortcutDisplay(`mod+${index + 1}`) : null

            return (
              <button
                key={group.id}
                type="button"
                draggable
                onDragStart={e => handleGroupDragStart(e, group.id)}
                onDragOver={handleGroupDragOver}
                onDrop={e => handleGroupDrop(e, group.id)}
                onDragEnd={handleGroupDragEnd}
                onClick={() => handleSelectGroup(group.id)}
                className={cn(
                  'group flex shrink-0 items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  draggedGroupId === group.id && 'opacity-60'
                )}
              >
                {/* Running indicator: any pane in this view is running */}
                {isRunning && (
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                )}
                {/* Split indicator: this view tiles several panes */}
                {paneCount > 1 && (
                  <span
                    className="flex items-center gap-0.5 text-primary/80"
                    title={`${paneCount} panes`}
                  >
                    <SquareSplitHorizontal className="h-3 w-3" />
                    <span className="text-[9px]">{paneCount}</span>
                  </span>
                )}
                {isEditing ? (
                  <InlineRename
                    value={label}
                    onCommit={name => handleRenameGroup(group.id, name)}
                    onCancel={() => setEditingGroupId(null)}
                    className="max-w-[100px]"
                    ariaLabel="Rename view"
                  />
                ) : (
                  <span
                    className="max-w-[100px] truncate"
                    title="Double-click to rename"
                    onDoubleClick={e => {
                      e.stopPropagation()
                      setEditingGroupId(group.id)
                    }}
                  >
                    {label}
                  </span>
                )}
                {shortcutLabel && (
                  <Kbd
                    className={cn(
                      'h-3.5 px-1 text-[9px]',
                      isActive
                        ? 'bg-background/80 text-foreground'
                        : 'bg-background/60 text-muted-foreground'
                    )}
                  >
                    {shortcutLabel}
                  </Kbd>
                )}
                {/* Close button - closes the whole view */}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={e => handleCloseGroup(e, group.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleCloseGroup(
                        e as unknown as React.MouseEvent,
                        group.id
                      )
                    }
                  }}
                  className={cn(
                    'rounded p-0.5 opacity-0 transition-opacity hover:bg-muted group-hover:opacity-100',
                    isActive && 'opacity-50'
                  )}
                >
                  <X className="h-3 w-3" />
                </span>
              </button>
            )
          })}
        </div>

        {/* Add terminal button - outside scroll container for full height */}
        <button
          type="button"
          onClick={handleAddTerminal}
          className="flex shrink-0 items-center px-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
          aria-label="New terminal"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>

        {/* Split buttons - native desktop only (gated by splitEnabled) */}
        {splitEnabled && groups.length > 0 && (
          <>
            <button
              type="button"
              onClick={() => handleSplit('horizontal')}
              className="flex shrink-0 items-center px-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              aria-label="Split terminal right"
              title="Split right"
            >
              <SquareSplitHorizontal className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => handleSplit('vertical')}
              className="flex shrink-0 items-center px-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              aria-label="Split terminal down"
              title="Split down"
            >
              <SquareSplitVertical className="h-3.5 w-3.5" />
            </button>
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {!hideControls && (
          <>
            {/* Minimize button */}
            <button
              type="button"
              onClick={handleMinimize}
              className="flex h-full shrink-0 items-center px-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
              aria-label="Minimize terminal"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>

            {/* Close all button */}
            <button
              type="button"
              onClick={handleCloseAll}
              className="flex h-full shrink-0 items-center px-2 text-muted-foreground transition-colors hover:bg-muted/50 hover:text-red-400"
              aria-label="Close all terminals"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      {/* Terminal content area: the active view's layout (1+ panes). */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {activeGroup && (
          <TerminalSplitLayout
            key={activeGroup.id}
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            layout={activeGroup.layout}
            focusedTerminalId={activeTerminalId}
            isWorktreeActive={isWorktreeActive}
            showPaneChrome={activePaneCount > 1}
            onClosePane={handleCloseSplitPane}
            onDetachPane={handleDetachPane}
            onRenameTerminal={handleRenameTerminal}
            onPaneDrop={splitEnabled ? handlePaneDrop : undefined}
            terminalsById={terminalsById}
          />
        )}
        {/* Keep other views' terminals mounted (hidden) to preserve their buffers */}
        <div className="hidden">
          {hiddenTerminals.map(terminal => (
            <TerminalTabContent
              key={terminal.id}
              terminal={terminal}
              worktreeId={worktreeId}
              worktreePath={worktreePath}
              isVisible={false}
              isWorktreeActive={isWorktreeActive}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
