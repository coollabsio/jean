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
}: UseTerminalOptions) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const attachedRef = useRef(false)

  const initTerminal = useCallback(
    async (container: HTMLDivElement) => {
      if (attachedRef.current) {
        // Already attached to this container
        return
      }

      containerRef.current = container

      // Get or create persistent terminal instance
      // (creates xterm + listeners if new, returns existing otherwise)
      getOrCreateTerminal(terminalId, {
        worktreeId,
        worktreePath,
        command,
        commandArgs,
      })

      // Attach terminal to this container
      // (opens if first time, moves DOM element if re-attaching)
      await attachToContainer(terminalId, container)

      attachedRef.current = true
    },
    [terminalId, worktreeId, worktreePath, command, commandArgs]
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
        detachFromContainer(terminalId)
        attachedRef.current = false
      }
    }
  }, [terminalId])

  return {
    initTerminal,
    fit,
    focus,
  }
}
