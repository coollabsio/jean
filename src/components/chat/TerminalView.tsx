import { useEffect, useRef, useCallback, useMemo, memo, useState } from 'react'
import { Plus, X, Minus, Terminal, ChevronUp } from 'lucide-react'
import { invoke } from '@/lib/transport'
import { middleClickClose } from '@/lib/middle-click'
import { useTerminal } from '@/hooks/useTerminal'
import { useTerminalBackgroundColor } from '@/hooks/useTerminalThemeSync'
import {
  isPanelTerminal,
  useTerminalStore,
  type TerminalInstance,
} from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import {
  disposeTerminal,
  disposePanelWorktreeTerminals,
} from '@/lib/terminal-instances'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Kbd } from '@/components/ui/kbd'
import { formatShortcutDisplay } from '@/types/keybindings'
import { cn } from '@/lib/utils'
import { useTerminalImageDrop } from './hooks/useTerminalImageDrop'
import { MODAL_TERMINAL_SECONDARY_ROW_CLASS } from './modal-terminal-layout'
import '@xterm/xterm/css/xterm.css'

const EMPTY_TERMINALS: TerminalInstance[] = []

interface TerminalViewProps {
  worktreeId: string
  worktreePath: string
  isCollapsed?: boolean
  isWorktreeActive?: boolean
  onExpand?: () => void
  /** Hide minimize and close-all buttons (for use in drawer) */
  hideControls?: boolean
}

/** Individual terminal tab content */
const TerminalTabContent = memo(function TerminalTabContent({
  terminal,
  worktreeId,
  worktreePath,
  isActive,
  isCollapsed = false,
  isWorktreeActive = true,
}: {
  terminal: TerminalInstance
  worktreeId: string
  worktreePath: string
  isActive: boolean
  isCollapsed?: boolean
  isWorktreeActive?: boolean
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalBg = useTerminalBackgroundColor()
  const { isDraggingImage, dropHandlers } = useTerminalImageDrop(terminal.id)
  const { initTerminal, fit, focus } = useTerminal({
    terminalId: terminal.id,
    worktreeId,
    worktreePath,
    command: terminal.command,
    commandArgs: terminal.commandArgs,
  })
  const initialized = useRef(false)
  const canAttach = isActive && !isCollapsed && isWorktreeActive

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

  // Fit and focus when becoming active, expanding from collapsed, or worktree becomes visible
  useEffect(() => {
    if (canAttach && initialized.current) {
      // Use requestAnimationFrame to ensure container has proper dimensions after expanding
      requestAnimationFrame(() => {
        fit()
        focus()
      })
    }
  }, [canAttach, fit, focus])

  return (
    <div
      data-terminal-id={terminal.id}
      className={cn('relative h-full w-full p-2', !isActive && 'hidden')}
      style={{ backgroundColor: terminalBg }}
      onDragOver={dropHandlers.onDragOver}
      onDragLeave={dropHandlers.onDragLeave}
      onDrop={dropHandlers.onDrop}
    >
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
      {isDraggingImage && (
        <div className="pointer-events-none absolute inset-2 z-10 flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed border-primary bg-background/80 text-sm font-medium text-foreground">
          <Terminal className="h-5 w-5" aria-hidden />
          <span>Drop image to insert its path</span>
        </div>
      )}
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
        isActive={isActive}
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
  const terminals = useMemo(
    () => allTerminals.filter(isPanelTerminal),
    [allTerminals]
  )
  const activeTerminalId = useTerminalStore(
    state => state.activeTerminalIds[worktreeId]
  )
  const runningTerminals = useTerminalStore(state => state.runningTerminals)
  const hasRunningPanelTerminal = terminals.some(terminal =>
    runningTerminals.has(terminal.id)
  )

  const {
    addTerminal,
    removeTerminal,
    reorderPanelTerminals,
    setActiveTerminal,
    setTerminalVisible,
    setTerminalPanelOpen,
  } = useTerminalStore.getState()
  const uiStateInitialized = useUIStore(state => state.uiStateInitialized)
  const [draggedTerminalId, setDraggedTerminalId] = useState<string | null>(
    null
  )
  // Pending close when the tab still has a live PTY (issue #56: no silent kill).
  const [pendingClose, setPendingClose] = useState<
    { type: 'one'; terminalId: string } | { type: 'all' } | null
  >(null)

  // Auto-create a default shell when this worktree has no panel terminals AND
  // UI state hydration has finished. Waiting on `uiStateInitialized` is
  // critical: on a web refresh the persisted `terminal_instances` arrive
  // asynchronously via `get_active_terminals`. If we auto-create before that
  // resolves, the phantom terminal spawns a real PTY on the backend and then
  // gets overwritten when restore completes — leaving an orphan PTY in
  // TERMINAL_SESSIONS and a visible flash that looks like "my terminal
  // disappeared". The effect does not re-fire for tab-close → store-empty
  // transitions because the dependency set is stable.
  useEffect(() => {
    if (!uiStateInitialized) return
    const existing = (
      useTerminalStore.getState().terminals[worktreeId] ?? []
    ).filter(isPanelTerminal)
    if (existing.length === 0) {
      addTerminal(worktreeId)
    }
  }, [worktreeId, addTerminal, uiStateInitialized])

  const handleAddTerminal = useCallback(() => {
    addTerminal(worktreeId)
  }, [worktreeId, addTerminal])

  const closeTerminalById = useCallback(
    async (terminalId: string) => {
      // Stop the PTY process
      try {
        await invoke('stop_terminal', { terminalId })
      } catch {
        // Terminal may already be stopped
      }
      // Dispose xterm instance (cleanup listeners, clear buffer)
      disposeTerminal(terminalId)
      // Remove from store
      removeTerminal(worktreeId, terminalId)
      const remaining = (
        useTerminalStore.getState().terminals[worktreeId] ?? []
      ).filter(isPanelTerminal)
      if (remaining.length === 0) {
        setTerminalPanelOpen(worktreeId, false)
        setTerminalVisible(false)
        useTerminalStore.getState().setModalTerminalOpen(worktreeId, false)
      }
    },
    [worktreeId, removeTerminal, setTerminalPanelOpen, setTerminalVisible]
  )

  const handleCloseTerminal = useCallback(
    (e: React.MouseEvent, terminalId: string) => {
      e.stopPropagation()
      // Running PTYs need an explicit confirm so a held/mis-clicked close
      // cannot silently kill work in progress (issue #56).
      if (useTerminalStore.getState().runningTerminals.has(terminalId)) {
        setPendingClose({ type: 'one', terminalId })
        return
      }
      void closeTerminalById(terminalId)
    },
    [closeTerminalById]
  )

  const handleSelectTerminal = useCallback(
    (terminalId: string) => {
      setActiveTerminal(worktreeId, terminalId)
    },
    [worktreeId, setActiveTerminal]
  )

  const handleTerminalDragStart = useCallback(
    (e: React.DragEvent<HTMLButtonElement>, terminalId: string) => {
      setDraggedTerminalId(terminalId)
      e.dataTransfer.effectAllowed = 'move'
      e.dataTransfer.setData('text/plain', terminalId)
    },
    []
  )

  const handleTerminalDragOver = useCallback(
    (e: React.DragEvent<HTMLButtonElement>) => {
      if (!draggedTerminalId) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
    },
    [draggedTerminalId]
  )

  const handleTerminalDrop = useCallback(
    (e: React.DragEvent<HTMLButtonElement>, targetTerminalId: string) => {
      e.preventDefault()
      const sourceId =
        draggedTerminalId || e.dataTransfer.getData('text/plain') || null
      setDraggedTerminalId(null)
      if (!sourceId || sourceId === targetTerminalId) return

      const panelIds = terminals.map(terminal => terminal.id)
      const fromIndex = panelIds.indexOf(sourceId)
      const toIndex = panelIds.indexOf(targetTerminalId)
      if (fromIndex === -1 || toIndex === -1) return

      panelIds.splice(fromIndex, 1)
      panelIds.splice(toIndex, 0, sourceId)
      reorderPanelTerminals(worktreeId, panelIds)
    },
    [draggedTerminalId, reorderPanelTerminals, terminals, worktreeId]
  )

  const handleMinimize = useCallback(() => {
    setTerminalVisible(false)
  }, [setTerminalVisible])

  const handleCloseAll = useCallback(() => {
    const panelTerminals = (
      useTerminalStore.getState().terminals[worktreeId] ?? []
    ).filter(isPanelTerminal)
    const hasRunning = panelTerminals.some(t =>
      useTerminalStore.getState().runningTerminals.has(t.id)
    )
    if (hasRunning) {
      setPendingClose({ type: 'all' })
      return
    }
    // Dispose side/drawer terminal tabs only; session terminals are independent.
    disposePanelWorktreeTerminals(worktreeId)
  }, [worktreeId])

  const confirmPendingClose = useCallback(() => {
    if (!pendingClose) return
    if (pendingClose.type === 'all') {
      disposePanelWorktreeTerminals(worktreeId)
    } else {
      void closeTerminalById(pendingClose.terminalId)
    }
    setPendingClose(null)
  }, [pendingClose, worktreeId, closeTerminalById])

  // Keyboard close path (Ctrl/Cmd+W) dispatches this when the active tab is
  // still running so we can show the same confirm dialog as the tab X button.
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ worktreeId: string; terminalId: string }>)
        .detail
      if (!detail || detail.worktreeId !== worktreeId) return
      setPendingClose({ type: 'one', terminalId: detail.terminalId })
    }
    window.addEventListener('confirm-close-terminal', handler)
    return () => window.removeEventListener('confirm-close-terminal', handler)
  }, [worktreeId])

  const closeConfirmDialog = (
    <AlertDialog
      open={pendingClose !== null}
      onOpenChange={open => {
        if (!open) setPendingClose(null)
      }}
    >
      <AlertDialogContent
        onEscapeKeyDown={e => e.stopPropagation()}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault()
            e.stopPropagation()
            confirmPendingClose()
          }
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>
            {pendingClose?.type === 'all'
              ? 'Close all terminals?'
              : 'Close running terminal?'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {pendingClose?.type === 'all'
              ? 'One or more terminals still have a running process. Closing them will terminate those processes.'
              : 'This terminal still has a running process. Closing it will terminate that process.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={confirmPendingClose}>
            Close
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  // When collapsed, show collapsed bar but keep terminals mounted (hidden) to preserve state
  if (isCollapsed) {
    return (
      <>
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
            {terminals.map(terminal => (
              <TerminalTabContent
                key={terminal.id}
                terminal={terminal}
                worktreeId={worktreeId}
                worktreePath={worktreePath}
                isActive={terminal.id === activeTerminalId}
                isCollapsed
                isWorktreeActive={isWorktreeActive}
              />
            ))}
          </div>
        </div>
        {closeConfirmDialog}
      </>
    )
  }

  return (
    <>
    <div className="flex h-full flex-col bg-background">
      {/* Tab bar - fixed height for consistency */}
      <div
        className={cn(
          'flex items-stretch border-b border-border',
          MODAL_TERMINAL_SECONDARY_ROW_CLASS
        )}
      >
        <div className="flex min-w-0 items-center overflow-x-auto">
          {terminals.map((terminal, index) => {
            const isActive = terminal.id === activeTerminalId
            const isRunning = runningTerminals.has(terminal.id)
            const shortcutLabel =
              index < 9 ? formatShortcutDisplay(`mod+${index + 1}`) : null

            return (
              <button
                key={terminal.id}
                type="button"
                draggable
                onDragStart={e => handleTerminalDragStart(e, terminal.id)}
                onDragOver={handleTerminalDragOver}
                onDrop={e => handleTerminalDrop(e, terminal.id)}
                onDragEnd={() => setDraggedTerminalId(null)}
                onClick={() => handleSelectTerminal(terminal.id)}
                {...middleClickClose(e => void handleCloseTerminal(e, terminal.id))}
                className={cn(
                  'group flex shrink-0 items-center gap-1.5 border-r border-border px-3 py-1.5 text-xs transition-colors',
                  isActive
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  draggedTerminalId === terminal.id && 'opacity-60'
                )}
              >
                {/* Running indicator */}
                {isRunning && (
                  <span className="h-1.5 w-1.5 rounded-full bg-green-500" />
                )}
                <span className="max-w-[100px] truncate">{terminal.label}</span>
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
                {/* Close button - always visible */}
                <span
                  role="button"
                  tabIndex={0}
                  onClick={e => handleCloseTerminal(e, terminal.id)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      handleCloseTerminal(
                        e as unknown as React.MouseEvent,
                        terminal.id
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

      {/* Terminal content area */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {terminals.map(terminal => (
          <TerminalTabContent
            key={terminal.id}
            terminal={terminal}
            worktreeId={worktreeId}
            worktreePath={worktreePath}
            isActive={terminal.id === activeTerminalId}
            isWorktreeActive={isWorktreeActive}
          />
        ))}
      </div>
    </div>
    {closeConfirmDialog}
    </>
  )
}
