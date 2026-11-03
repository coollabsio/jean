import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { updateTargetLabel } from '@/lib/environment'
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
const FIRST_CHECK_DELAY_MS = 15_000
const CHECK_INTERVAL_MS = 30 * 60_000

/**
 * The backend offers only releases that are 3+ days old, and installs one
 * only after npm verifies its provenance, so background updates are safe.
 */
export function useAgentBrowserUpdateCheck() {
  const updatingRef = useRef(false)
  // A version that failed to auto-install falls back to the confirm toast,
  // so a broken release does not retry and show an error every 30 minutes.
  const failedVersionRef = useRef<string | null>(null)
  const { data: preferences } = usePreferences()
  const enabled = preferences?.agent_browser_enabled ?? false
  const autoUpdate = preferences?.auto_update_ai_backends ?? true

  useEffect(() => {
    if (!enabled) return
    const name = `Agent Browser (${updateTargetLabel()})`

    const update = async (version: string, toastId?: string | number) => {
      updatingRef.current = true
      try {
        const updated = await invoke('install_agent_browser')
        await invoke('install_agent_browser_mcp')
        queryClient.setQueryData(['agentBrowserStatus'], updated)
        invalidateAllMcpServers()
        toast.success(`${name} updated to ${version}`, { id: toastId })
      } catch (error) {
        failedVersionRef.current = version
        toast.error(`${name} update failed: ${error}`, { id: toastId })
      } finally {
        updatingRef.current = false
      }
    }

    const check = async () => {
      if (updatingRef.current) return
      try {
        const status = await invoke<AgentBrowserUpdateStatus>(
          'check_agent_browser_update'
        )
        const version = status.latestVersion
        if (!status.updateAvailable || !version) return

        if (autoUpdate && failedVersionRef.current !== version) {
          await update(version)
          return
        }

        toast.info(`${name} update available`, {
          id: UPDATE_TOAST_ID,
          description: `${status.currentVersion ?? 'Installed version'} → ${version}`,
          duration: Infinity,
          action: {
            label: 'Update',
            onClick: () => {
              // Sonner merges updates with the same id and can keep the old
              // action buttons. Dismiss the confirmation and use a separate
              // progress toast so the click has immediate visible feedback.
              toast.dismiss(UPDATE_TOAST_ID)
              const toastId = toast.loading(`Updating ${name}…`, {
                id: UPDATE_PROGRESS_TOAST_ID,
                duration: Infinity,
              })
              void update(version, toastId)
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
    }

    // "Later" only closes the toast, so it shows again at the next check.
    let interval: number | undefined
    const timer = window.setTimeout(() => {
      void check()
      interval = window.setInterval(() => void check(), CHECK_INTERVAL_MS)
    }, FIRST_CHECK_DELAY_MS)

    return () => {
      window.clearTimeout(timer)
      window.clearInterval(interval)
    }
  }, [enabled, autoUpdate])
}
