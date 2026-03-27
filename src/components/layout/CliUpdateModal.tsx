/**
 * CLI Update Modal
 *
 * Global wrapper for CLI reinstall modals that's controlled by ui-store.
 * Triggered when toast notification "Update" button is clicked.
 *
 * Renders both specific modals - each has lazy mounting, so only the
 * open one will have hooks running (prevents duplicate event listeners).
 */

import { useQueryClient } from '@tanstack/react-query'
import { useUIStore } from '@/store/ui-store'
import { claudeCliQueryKeys } from '@/services/claude-cli'
import { ghCliQueryKeys } from '@/services/gh-cli'
import { codexCliQueryKeys } from '@/services/codex-cli'
import { opencodeCliQueryKeys } from '@/services/opencode-cli'
import { githubQueryKeys } from '@/services/github'
import {
  ClaudeCliReinstallModal,
  GhCliReinstallModal,
  CodexCliReinstallModal,
  OpenCodeCliReinstallModal,
} from '@/components/preferences/CliReinstallModal'

export function CliUpdateModal() {
  const queryClient = useQueryClient()
  const cliUpdateModalOpen = useUIStore(state => state.cliUpdateModalOpen)
  const cliUpdateModalType = useUIStore(state => state.cliUpdateModalType)
  const closeCliUpdateModal = useUIStore(state => state.closeCliUpdateModal)

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      // Invalidate caches so settings page refreshes after install/update
      if (cliUpdateModalType === 'claude') {
        queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.all })
      } else if (cliUpdateModalType === 'gh') {
        queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.all })
        queryClient.invalidateQueries({ queryKey: githubQueryKeys.all })
      } else if (cliUpdateModalType === 'codex') {
        queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.all })
      } else if (cliUpdateModalType === 'opencode') {
        queryClient.invalidateQueries({ queryKey: opencodeCliQueryKeys.all })
      }

      closeCliUpdateModal()
    }
  }

  // Render both modals - each has lazy mounting (returns null when closed)
  // Only the one matching cliUpdateModalType will actually render hooks
  return (
    <>
      <ClaudeCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'claude'}
        onOpenChange={handleOpenChange}
      />
      <GhCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'gh'}
        onOpenChange={handleOpenChange}
      />
      <CodexCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'codex'}
        onOpenChange={handleOpenChange}
      />
      <OpenCodeCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'opencode'}
        onOpenChange={handleOpenChange}
      />
    </>
  )
}
