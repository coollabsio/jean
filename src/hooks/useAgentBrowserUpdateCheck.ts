import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { queryClient } from '@/lib/query-client'
import { invalidateAllMcpServers } from '@/services/mcp'
import { usePreferences } from '@/services/preferences'

interface AgentBrowserUpdateStatus {
  installed: boolean
  currentVersion: string | null
  latestVersion: string | null
  updateAvailable: boolean
}

const UPDATE_TOAST_ID = 'agent-browser-update'
const UPDATE_PROGRESS_TOAST_ID = 'agent-browser-update-progress'

export function useAgentBrowserUpdateCheck() {
  const checkedRef = useRef(false)
  const { data: preferences } = usePreferences()
  const enabled = preferences?.agent_browser_enabled ?? false

  useEffect(() => {
    if (!enabled) return
    const timer = window.setTimeout(async () => {
      if (checkedRef.current) return
      checkedRef.current = true

      try {
        const status = await invoke<AgentBrowserUpdateStatus>(
          'check_agent_browser_update'
        )
        if (!status.updateAvailable || !status.latestVersion) return

        toast.info('Agent Browser update available', {
          id: UPDATE_TOAST_ID,
          description: `${status.currentVersion ?? 'Installed version'} → ${status.latestVersion}`,
          duration: Infinity,
          action: {
            label: 'Update',
            onClick: () => {
              // Sonner merges updates with the same id and can keep the old
              // action buttons. Dismiss the confirmation and use a separate
              // progress toast so the click has immediate visible feedback.
              toast.dismiss(UPDATE_TOAST_ID)
              const toastId = toast.loading('Updating Agent Browser…', {
                id: UPDATE_PROGRESS_TOAST_ID,
                duration: Infinity,
              })
              void (async () => {
                try {
                  const updated = await invoke('install_agent_browser')
                  await invoke('install_agent_browser_mcp')
                  queryClient.setQueryData(['agentBrowserStatus'], updated)
                  invalidateAllMcpServers()
                  toast.success('Agent Browser updated', { id: toastId })
                } catch (error) {
                  toast.error(`Agent Browser update failed: ${error}`, {
                    id: toastId,
                  })
                }
              })()
            },
          },
          cancel: {
            label: 'Later',
            onClick: () => toast.dismiss(UPDATE_TOAST_ID),
          },
        })
      } catch (error) {
        console.warn('Failed to check Agent Browser updates', error)
      }
    }, 15_000)

    return () => window.clearTimeout(timer)
  }, [enabled])
}
