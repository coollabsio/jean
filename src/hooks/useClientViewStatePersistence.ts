import { useEffect } from 'react'
import { useBrowserStore } from '@/store/browser-store'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import {
  loadStoredClientViewState,
  saveClientViewState,
} from '@/lib/client-view-state'
import {
  applyClientViewState,
  captureClientViewState,
  scopeClientViewStateResources,
} from '@/lib/client-view-state-store'
import { loadProjectCanvasSortModes } from '@/lib/project-canvas-settings'
import { isNativeApp } from '@/lib/environment'
import {
  getActiveConnectionId,
  LOCAL_CONNECTION_ID,
} from '@/lib/remote-connections'

export function useClientViewStatePersistence(isInitialized: boolean): void {
  useEffect(() => {
    if (!isInitialized) return

    const stored = loadStoredClientViewState()
    if (stored) {
      applyClientViewState(stored)
    } else {
      const legacySortModes = loadProjectCanvasSortModes()
      if (Object.keys(legacySortModes).length > 0) {
        useProjectsStore.setState(state => ({
          projectCanvasSettings: Object.entries(legacySortModes).reduce(
            (settings, [projectId, worktreeSortMode]) => ({
              ...settings,
              [projectId]: {
                ...settings[projectId],
                worktreeSortMode,
              },
            }),
            state.projectCanvasSettings
          ),
        }))
      }
      let migrated = captureClientViewState()
      if (isNativeApp()) {
        const serverId = getActiveConnectionId()
        if (serverId !== LOCAL_CONNECTION_ID) {
          migrated = scopeClientViewStateResources(migrated, serverId)
          applyClientViewState(migrated)
        }
      }
      saveClientViewState(migrated)
    }

    let previous = JSON.stringify(captureClientViewState())
    const save = () => {
      const next = captureClientViewState()
      const serialized = JSON.stringify(next)
      if (serialized === previous) return
      previous = serialized
      saveClientViewState(next)
    }
    const unsubProjects = useProjectsStore.subscribe(save)
    const unsubUI = useUIStore.subscribe(save)
    const unsubTerminal = useTerminalStore.subscribe(save)
    const unsubBrowser = useBrowserStore.subscribe(save)

    return () => {
      unsubProjects()
      unsubUI()
      unsubTerminal()
      unsubBrowser()
    }
  }, [isInitialized])
}
