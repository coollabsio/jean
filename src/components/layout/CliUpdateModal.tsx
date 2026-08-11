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
import { toast } from 'sonner'
import { useUIStore } from '@/store/ui-store'
import { claudeCliQueryKeys } from '@/services/claude-cli'
import { ghCliQueryKeys } from '@/services/gh-cli'
import { codexCliQueryKeys } from '@/services/codex-cli'
import { opencodeCliQueryKeys } from '@/services/opencode-cli'
import { piCliQueryKeys } from '@/services/pi-cli'
import { coderabbitCliQueryKeys } from '@/services/coderabbit-cli'
import { commandcodeCliQueryKeys } from '@/services/commandcode-cli'
import { grokCliQueryKeys } from '@/services/grok-cli'
import { kimiCliQueryKeys } from '@/services/kimi-cli'
import { hermesCliQueryKeys } from '@/services/hermes-cli'
import { githubQueryKeys } from '@/services/github'
import {
  ClaudeCliReinstallModal,
  GhCliReinstallModal,
  CodexCliReinstallModal,
  OpenCodeCliReinstallModal,
  PiCliReinstallModal,
  CodeRabbitCliReinstallModal,
  CommandCodeCliReinstallModal,
  GrokCliReinstallModal,
  KimiCliReinstallModal,
  HermesCliReinstallModal,
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
      } else if (cliUpdateModalType === 'pi') {
        queryClient.invalidateQueries({ queryKey: piCliQueryKeys.all })
      } else if (cliUpdateModalType === 'coderabbit') {
        queryClient.invalidateQueries({ queryKey: coderabbitCliQueryKeys.all })
      } else if (cliUpdateModalType === 'commandcode') {
        queryClient.invalidateQueries({ queryKey: commandcodeCliQueryKeys.all })
      } else if (cliUpdateModalType === 'grok') {
        queryClient.invalidateQueries({ queryKey: grokCliQueryKeys.all })
      } else if (cliUpdateModalType === 'kimi') {
        queryClient.invalidateQueries({ queryKey: kimiCliQueryKeys.all })
      } else if (cliUpdateModalType === 'hermes') {
        queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
      }

      // Dismiss any lingering update toast for this CLI type
      toast.dismiss(`cli-update-${cliUpdateModalType}`)

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
      <PiCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'pi'}
        onOpenChange={handleOpenChange}
      />
      <CodeRabbitCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'coderabbit'}
        onOpenChange={handleOpenChange}
      />
      <CommandCodeCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'commandcode'}
        onOpenChange={handleOpenChange}
      />
      <GrokCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'grok'}
        onOpenChange={handleOpenChange}
      />
      <KimiCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'kimi'}
        onOpenChange={handleOpenChange}
      />
      <HermesCliReinstallModal
        open={cliUpdateModalOpen && cliUpdateModalType === 'hermes'}
        onOpenChange={handleOpenChange}
      />
    </>
  )
}
