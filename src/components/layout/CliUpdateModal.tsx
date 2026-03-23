/**
 * CLI Update Modal
 *
 * Global wrapper for CLI reinstall modals that's controlled by ui-store.
 * Triggered when toast notification "Update" button is clicked.
 *
 * Renders both specific modals - each has lazy mounting, so only the
 * open one will have hooks running (prevents duplicate event listeners).
 */

import { useCallback } from 'react'
import { useUIStore } from '@/store/ui-store'
import {
  ClaudeCliReinstallModal,
  GhCliReinstallModal,
  CodexCliReinstallModal,
  OpenCodeCliReinstallModal,
} from '@/components/preferences/CliReinstallModal'

export function CliUpdateModal() {
  const cliUpdateModalOpen = useUIStore(state => state.cliUpdateModalOpen)
  const cliUpdateModalType = useUIStore(state => state.cliUpdateModalType)
  const closeCliUpdateModal = useUIStore(state => state.closeCliUpdateModal)

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      closeCliUpdateModal()
    }
  }

  const handleMinimize = useCallback(() => {
    const { minimizeCliUpdate, closeCliUpdateModal: close } =
      useUIStore.getState()
    const type = useUIStore.getState().cliUpdateModalType
    if (type) {
      minimizeCliUpdate({ type, mode: 'reinstall' })
    }
    close()
  }, [])

  // Render both modals - each has lazy mounting (returns null when closed)
  // Only the one matching cliUpdateModalType will actually render hooks
  return (
    <>
      <ClaudeCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'claude'}
        onOpenChange={handleOpenChange}
        onMinimize={handleMinimize}
      />
      <GhCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'gh'}
        onOpenChange={handleOpenChange}
        onMinimize={handleMinimize}
      />
      <CodexCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'codex'}
        onOpenChange={handleOpenChange}
        onMinimize={handleMinimize}
      />
      <OpenCodeCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'opencode'}
        onOpenChange={handleOpenChange}
        onMinimize={handleMinimize}
      />
    </>
  )
}
