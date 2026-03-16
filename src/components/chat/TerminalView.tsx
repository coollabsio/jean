import { useEffect, useRef, useCallback, memo } from 'react'
import { Plus, X, Minus, Terminal, ChevronUp } from 'lucide-react'
import { invoke } from '@/lib/transport'
import { useTerminal } from '@/hooks/useTerminal'
import { useTerminalStore, type TerminalInstance } from '@/store/terminal-store'
import {
  disposeTerminal,
  disposeAllWorktreeTerminals,
} from '@/lib/terminal-instances'
import { Kbd } from '@/components/ui/kbd'
import { formatShortcutDisplay } from '@/types/keybindings'
import { cn } from '@/lib/utils'
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
  const { initTerminal, fit, focus } = useTerminal({
    terminalId: terminal.id,
    worktreeId,
    worktreePath,
    command: terminal.command,
  })
  const initialized = useRef(false)

  useEffect(() => {
    if (containerRef.current && !initialized.current && isActive) {
      initialized.current = true
      initTerminal(containerRef.current)
    }
  }, [initTerminal, isActive])

  // Handle resize with debouncing
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null

    const observer = new ResizeObserver(() => {
      // Debounce fit calls to ensure container has settled
      if (timeoutId) clearTimeout(timeoutId)
      timeoutId = setTimeout(() => {
        if (isActive) fit()
      }, 50)
    })

    if (containerRef.current) {
      observer.observe(containerRef.current)
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId)
      observer.disconnect()
    }
  }, [fit, isActive])

  // Fit and focus when becoming active, expanding from collapsed, or worktree becomes visible
  useEffect(() => {
    if (isActive && initialized.current && !isCollapsed && isWorktreeActive) {
      // Use requestAnimationFrame to ensure container has proper dimensions after expanding
      requestAnimationFrame(() => {
        fit()
        focus()
      })
    }
  }, [isActive, isCollapsed, isWorktreeActive, fit, focus])

  return (
    <div className={cn('h-full w-full p-2', !isActive && 'hidden')}>
      <div ref={containerRef} className="h-full w-full overflow-hidden" />
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
  const terminals = useTerminalStore(
    state => state.terminals[worktreeId] ?? EMPTY_TERMINALS
  )
  const activeTerminalId = useTerminalStore(
    state => state.activeTerminalIds[worktreeId]
  )
  const runningTerminals = useTerminalStore(state => state.runningTerminals)

  const {
    addTerminal,
    removeTerminal,
    setActiveTerminal,
    setTerminalVisible,
    setTerminalPanelOpen,
  } = useTerminalStore.getState()

  // Auto-create a terminal only on initial mount (not when tabs are closed)
  const mountedRef = useRef(false)
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true
      const existing = useTerminalStore.getState().terminals[worktreeId] ?? []
      if (existing.length === 0) {
        addTerminal(worktreeId)
      }
    }
  }, [worktreeId, addTerminal])

  const handleAddTerminal = useCallback(() => {
    addTerminal(worktreeId)
  }, [worktreeId, addTerminal])

  const handleCloseTerminal = useCallback(
    async (e: React.MouseEvent, terminalId: string) => {
      e.stopPropagation()
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
      const remaining = useTerminalStore.getState().terminals[worktreeId] ?? []
      if (remaining.length === 0) {
        setTerminalPanelOpen(worktreeId, false)
        setTerminalVisible(false)
        useTerminalStore.getState().setModalTerminalOpen(worktreeId, false)
      }
    },
    [worktreeId, removeTerminal, setTerminalPanelOpen, setTerminalVisible]
  )

  const handleSelectTerminal = useCallback(
    (terminalId: string) => {
      setActiveTerminal(worktreeId, terminalId)
    },
    [worktreeId, setActiveTerminal]
  )

  const handleMinimize = useCallback(() => {
    setTerminalVisible(false)
  }, [setTerminalVisible])

  const handleCloseAll = useCallback(() => {
    // Dispose all xterm instances and stop PTY processes
    disposeAllWorktreeTerminals(worktreeId)
  }, [worktreeId])

  // When collapsed, show collapsed bar but keep terminals mounted (hidden) to preserve state
  if (isCollapsed) {
    return (
      <div className="flex h-full flex-col bg-[#1a1a1a]">
        {/* Collapsed bar */}
        <button
          type="button"
          onClick={onExpand}
          className="flex h-full w-full items-center gap-2 px-3 text-xs text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-neutral-300"
        >
          <Terminal className="h-3.5 w-3.5" />
          <span>Terminal</span>
          {runningTerminals.size > 0 && (
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
    )
  }

  return (
    <div className="flex h-full flex-col bg-[#1a1a1a]">
      {/* Tab bar - fixed height for consistency */}
      <div className="flex h-8 items-stretch border-b border-neutral-700">
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
                onClick={() => handleSelectTerminal(terminal.id)}
                className={cn(
                  'group flex shrink-0 items-center gap-1.5 border-r border-neutral-700 px-3 py-1.5 text-xs transition-colors',
                  isActive
                    ? 'bg-neutral-800 text-neutral-200'
                    : 'text-neutral-400 hover:bg-neutral-800/50 hover:text-neutral-300'
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
                        ? 'bg-neutral-700 text-neutral-200'
                        : 'bg-neutral-800/80 text-neutral-400'
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
                    'rounded p-0.5 opacity-0 transition-opacity hover:bg-neutral-600 group-hover:opacity-100',
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
          className="flex shrink-0 items-center px-2 text-neutral-400 transition-colors hover:bg-neutral-800/50 hover:text-neutral-300"
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
              className="flex h-full shrink-0 items-center px-2 text-neutral-400 transition-colors hover:bg-neutral-800/50 hover:text-neutral-300"
              aria-label="Minimize terminal"
            >
              <Minus className="h-3.5 w-3.5" />
            </button>

            {/* Close all button */}
            <button
              type="button"
              onClick={handleCloseAll}
              className="flex h-full shrink-0 items-center px-2 text-neutral-400 transition-colors hover:bg-neutral-800/50 hover:text-red-400"
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
  )
}
