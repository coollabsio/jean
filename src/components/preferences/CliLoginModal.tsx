/**
 * CLI Login Modal
 *
 * Modal with embedded xterm terminal for CLI login flows.
 * Used for `claude` and `gh auth login` commands that require
 * interactive terminal access.
 */

import { useCallback, useEffect, useRef, useMemo } from 'react'
import { invoke } from '@tauri-apps/api/core'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useUIStore } from '@/store/ui-store'
import { useTerminal } from '@/hooks/useTerminal'
import { disposeTerminal } from '@/lib/terminal-instances'

export function CliLoginModal() {
  const isOpen = useUIStore(state => state.cliLoginModalOpen)
  const cliType = useUIStore(state => state.cliLoginModalType)
  const command = useUIStore(state => state.cliLoginModalCommand)
  const closeModal = useUIStore(state => state.closeCliLoginModal)

  // Only render when open to avoid unnecessary terminal setup
  if (!isOpen || !command) return null

  return (
    <CliLoginModalContent
      cliType={cliType}
      command={command}
      onClose={closeModal}
    />
  )
}

interface CliLoginModalContentProps {
  cliType: 'claude' | 'gh' | 'glab' | null
  command: string
  onClose: () => void
}

function CliLoginModalContent({ cliType, command, onClose }: CliLoginModalContentProps) {
  const initialized = useRef(false)
  const observerRef = useRef<ResizeObserver | null>(null)
  const cliName = cliType === 'claude' ? 'Claude CLI' : cliType === 'glab' ? 'GitLab CLI' : 'GitHub CLI'

  // Generate unique terminal ID for this login session
  const terminalId = useMemo(() => {
    const id = `cli-login-${Date.now()}`
    console.log('[CliLoginModal] Generated terminalId:', id)
    return id
  }, [])

  console.log('[CliLoginModal] Render - terminalId:', terminalId, 'command:', command)

  // Use a synthetic worktreeId for CLI login (not associated with any real worktree)
  const { initTerminal, fit } = useTerminal({
    terminalId,
    worktreeId: 'cli-login', // Synthetic worktreeId for CLI login terminals
    worktreePath: '/tmp', // CLI commands don't depend on cwd
    command,
  })

  // Use callback ref to detect when container is mounted (Dialog uses portal)
  const containerCallbackRef = useCallback(
    (container: HTMLDivElement | null) => {
      console.log('[CliLoginModal] containerCallbackRef called, container:', !!container, 'initialized:', initialized.current)

      // Cleanup previous observer if any
      if (observerRef.current) {
        observerRef.current.disconnect()
        observerRef.current = null
      }

      if (!container) return

      const observer = new ResizeObserver(entries => {
        const entry = entries[0]
        console.log('[CliLoginModal] ResizeObserver fired, width:', entry?.contentRect.width, 'initialized:', initialized.current)

        if (!entry || entry.contentRect.width === 0) {
          console.log('[CliLoginModal] No entry or width=0, skipping')
          return
        }

        // Initialize on first valid size
        if (!initialized.current) {
          console.log('[CliLoginModal] Initializing terminal...')
          initialized.current = true
          initTerminal(container)
          console.log('[CliLoginModal] initTerminal called')
          return
        }

        // Debounced resize - fit is stable so this is fine
        fit()
      })

      observer.observe(container)
      observerRef.current = observer
      console.log('[CliLoginModal] ResizeObserver attached via callback ref')
    },
    [initTerminal, fit]
  )

  // Cleanup observer on unmount
  useEffect(() => {
    return () => {
      console.log('[CliLoginModal] Cleanup - disconnecting observer')
      if (observerRef.current) {
        observerRef.current.disconnect()
      }
    }
  }, [])

  // Cleanup terminal when modal closes
  const handleOpenChange = useCallback(
    async (open: boolean) => {
      if (!open) {
        // Stop PTY process
        try {
          await invoke('stop_terminal', { terminalId })
        } catch {
          // Terminal may already be stopped
        }
        // Dispose xterm instance
        disposeTerminal(terminalId)
        onClose()
      }
    },
    [terminalId, onClose]
  )

  return (
    <Dialog open={true} onOpenChange={handleOpenChange}>
      <DialogContent className="!w-[calc(100vw-64px)] !max-w-[calc(100vw-64px)] h-[calc(100vh-64px)] flex flex-col">
        <DialogHeader>
          <DialogTitle>{cliName} Login</DialogTitle>
          <DialogDescription>
            Complete the login process in the terminal below.
          </DialogDescription>
        </DialogHeader>

        <div
          ref={containerCallbackRef}
          className="flex-1 min-h-0 w-full rounded-md bg-[#1a1a1a] overflow-hidden"
        />
      </DialogContent>
    </Dialog>
  )
}
