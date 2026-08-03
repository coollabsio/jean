import { useEffect, useRef, useCallback } from 'react'
import {
  getOrCreateTerminal,
  attachToContainer,
  detachFromContainer,
  fitTerminal,
  focusTerminal,
} from '@/lib/terminal-instances'

interface UseTerminalOptions {
  terminalId: string
  worktreeId: string
  worktreePath: string
  command?: string | null
  commandArgs?: string[] | null
  sessionId?: string | null
}

/**
 * Hook for managing terminal UI attachment.
 *
 * Terminal instances are stored in a module-level Map (terminal-instances.ts)
 * and persist across React mount/unmount cycles. This hook just handles
 * attaching/detaching the terminal to/from a DOM container.
 */
export function useTerminal({
  terminalId,
  worktreeId,
  worktreePath,
  command,
  commandArgs,
  sessionId,
}: UseTerminalOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const attachedRef = useRef(false)
  const attachedTerminalIdRef = useRef<string | null>(null)

  const initTerminal = useCallback(
    async (container: HTMLDivElement) => {
      const attachedTerminalId = attachedTerminalIdRef.current
      if (attachedRef.current && attachedTerminalId === terminalId) {
        // Already attached to this terminal/container.
        return
      }

      if (attachedRef.current) {
        // The host component can be reused for a different terminal ID. Make
        // sure the previous terminal's DOM is detached first so a newly opened
        // terminal never displays stale scrollback from the old session.
        if (attachedTerminalId) {
          detachFromContainer(attachedTerminalId)
        }
        attachedRef.current = false
        attachedTerminalIdRef.current = null
      }

      containerRef.current = container

      // Get or create persistent terminal instance
      // (creates xterm + listeners if new, returns existing otherwise)
      getOrCreateTerminal(terminalId, {
        worktreeId,
        worktreePath,
        command,
        commandArgs,
        sessionId,
      })

      // Attach terminal to this container
      // (opens if first time, moves DOM element if re-attaching)
      await attachToContainer(terminalId, container)

      attachedRef.current = true
      attachedTerminalIdRef.current = terminalId
    },
    [terminalId, worktreeId, worktreePath, command, commandArgs, sessionId]
  )

  const fit = useCallback(() => {
    fitTerminal(terminalId)
  }, [terminalId])

  const focus = useCallback(() => {
    focusTerminal(terminalId)
  }, [terminalId])

  // Cleanup: detach terminal from DOM on unmount
  // Terminal instance stays in memory with preserved buffer
  useEffect(() => {
    return () => {
      if (attachedRef.current) {
        const attachedTerminalId = attachedTerminalIdRef.current
        if (attachedTerminalId) {
          detachFromContainer(attachedTerminalId)
        }
        attachedRef.current = false
        attachedTerminalIdRef.current = null
      }
    }
  }, [terminalId])

  return {
    initTerminal,
    fit,
    focus,
  }
}
