/**
 * Host update check for remote / Web Access clients (user-triggered install).
 *
 * Two channels from `check_server_update`:
 * - **desktop**: host is native Jean (incl. macOS/Windows). Present the same
 *   modal + sticky title-bar badge as the local Tauri updater. Install asks
 *   the host desktop shell via `apply_server_update` → `host:install-desktop-update`.
 * - **server**: headless jean-server. Sticky title-bar control + toast; apply
 *   replaces the binary and restarts the server.
 *
 * Checks after connecting. Dismissing the toast/modal never loses the sticky
 * badge for the session.
 */

import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { invoke } from '@/lib/transport'
import { isLocalBackend } from '@/lib/environment'
import { logger } from '@/lib/logger'
import { useUIStore } from '@/store/ui-store'

export type HostUpdateChannel = 'server' | 'desktop'

export interface ServerUpdateStatus {
  updateAvailable: boolean
  currentVersion: string
  latestVersion?: string | null
  notes?: string | null
  canUpdate: boolean
  reason?: string | null
  channel?: HostUpdateChannel | null
}

interface ServerUpdateApplyResult {
  success: boolean
  version: string
  message: string
  restartScheduled: boolean
}

function normalizeChannel(raw: unknown): HostUpdateChannel {
  const value = String(raw ?? 'server').toLowerCase()
  return value === 'desktop' ? 'desktop' : 'server'
}

function normalizeStatus(raw: Record<string, unknown>): ServerUpdateStatus {
  return {
    updateAvailable: Boolean(raw.updateAvailable ?? raw.update_available),
    currentVersion: String(raw.currentVersion ?? raw.current_version ?? ''),
    latestVersion: (raw.latestVersion ?? raw.latest_version ?? null) as
      | string
      | null,
    notes: (raw.notes ?? null) as string | null,
    canUpdate: Boolean(raw.canUpdate ?? raw.can_update),
    reason: (raw.reason ?? null) as string | null,
    channel: normalizeChannel(raw.channel),
  }
}

/** Apply a pending host update (title bar, modal, or toast action). */
export async function applyServerUpdate(version: string): Promise<void> {
  const toastId = toast.loading(`Installing update ${version}...`)
  try {
    const result = await invoke<ServerUpdateApplyResult>('apply_server_update')
    // Clear sticky indicators once install succeeded / already latest.
    useUIStore.getState().setPendingServerUpdate(null)
    useUIStore.getState().setPendingUpdateVersion(null)
    useUIStore.getState().setUpdateModalVersion(null)
    toast.dismiss('server-update-available')
    toast.success(result.message || `Installed update ${result.version}`, {
      id: toastId,
      description: result.restartScheduled
        ? 'The server is restarting. This page will reconnect automatically.'
        : undefined,
      duration: 12_000,
    })
  } catch (error) {
    logger.error('Failed to apply host update', { error })
    // Keep sticky indicators so the title-bar control stays for retry.
    toast.error(`Update failed: ${String(error)}`, {
      id: toastId,
      duration: 10_000,
    })
  }
}

export function useServerUpdateCheck() {
  const toastShownForVersionRef = useRef<string | null>(null)

  const presentUpdate = useCallback((status: ServerUpdateStatus) => {
    if (!status.updateAvailable || !status.latestVersion) {
      useUIStore.getState().setPendingServerUpdate(null)
      return
    }

    const version = status.latestVersion
    const channel = status.channel ?? 'server'

    // Desktop host: reuse native update modal + "Update available" badge.
    if (channel === 'desktop') {
      useUIStore.getState().setPendingServerUpdate(null)
      // Modal on first offer; sticky badge when user dismisses (handleLater).
      if (
        !useUIStore.getState().pendingUpdateVersion &&
        useUIStore.getState().updateModalVersion !== version
      ) {
        useUIStore.getState().setUpdateModalVersion(version)
      }
      return
    }

    // Headless jean-server: sticky title-bar state + toast.
    useUIStore.getState().setPendingServerUpdate({
      latestVersion: version,
      currentVersion: status.currentVersion,
      canUpdate: status.canUpdate,
      reason: status.reason,
    })

    // One-shot toast per version (optional nudge). Closing it does not clear
    // pendingServerUpdate — the header badge remains.
    if (toastShownForVersionRef.current === version) return
    toastShownForVersionRef.current = version

    if (!status.canUpdate) {
      toast.info(`jean-server ${version} is available`, {
        id: 'server-update-available',
        description:
          status.reason ||
          'This host cannot self-update. Replace the binary or image manually.',
        duration: 12_000,
      })
      return
    }

    toast.info(`jean-server ${version} is available`, {
      id: 'server-update-available',
      description: `You are on ${status.currentVersion}. A permanent control stays in the title bar if you dismiss this.`,
      duration: 12_000,
      action: {
        label: 'Update & restart',
        onClick: () => {
          void applyServerUpdate(version)
        },
      },
    })
  }, [])

  useEffect(() => {
    if (isLocalBackend()) {
      useUIStore.getState().setPendingServerUpdate(null)
      return
    }

    let cancelled = false

    const check = async () => {
      // Wait for WebSocket/backend to be ready.
      await new Promise(resolve => setTimeout(resolve, 8_000))
      if (cancelled) return
      try {
        const raw = await invoke<Record<string, unknown>>('check_server_update')
        if (cancelled) return
        presentUpdate(normalizeStatus(raw ?? {}))
      } catch (error) {
        // Silent: offline / unsupported hosts / older servers without the command
        logger.debug('Server update check skipped', { error: String(error) })
      }
    }

    void check()

    return () => {
      cancelled = true
    }
  }, [presentUpdate])
}
