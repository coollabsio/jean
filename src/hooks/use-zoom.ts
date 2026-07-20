import { useEffect } from 'react'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { isNativeApp } from '@/lib/environment'
import { ZOOM_LEVEL_DEFAULT, zoomLevelTicks } from '@/types/preferences'
import { isClientMacOS } from '@/lib/platform'
import { useIsMobile } from '@/hooks/use-mobile'

const tickValues = zoomLevelTicks.map(t => t.value)

function findNearestTickIndex(zoom: number): number {
  let closest = 0
  let minDiff = Infinity
  for (let i = 0; i < tickValues.length; i++) {
    const val = tickValues[i]
    if (val == null) continue
    const diff = Math.abs(val - zoom)
    if (diff < minDiff) {
      minDiff = diff
      closest = i
    }
  }
  return closest
}

async function applyZoom(scaleFactor: number) {
  if (!isNativeApp()) {
    const root = document.documentElement
    const style = root.style as CSSStyleDeclaration & {
      zoom: string
    }
    style.zoom = ''
    root.style.setProperty('--app-zoom', String(scaleFactor))
    root.style.fontSize = `${16 * scaleFactor}px`
    return
  }

  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().setZoom(scaleFactor)
  } catch (error) {
    console.error('Failed to set zoom:', error)
  }
}

export function useZoom() {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const isMobile = useIsMobile()
  const syncZoomLevels = preferences?.sync_zoom_levels ?? true
  const desktopZoom = preferences?.zoom_level ?? ZOOM_LEVEL_DEFAULT
  const zoomLevel =
    isMobile && !syncZoomLevels
      ? (preferences?.mobile_zoom_level ?? ZOOM_LEVEL_DEFAULT)
      : desktopZoom

  // Apply zoom when preferences change
  useEffect(() => {
    applyZoom(zoomLevel / 100)
  }, [zoomLevel])

  // Keyboard shortcuts: Cmd/Ctrl + =/- for zoom, Cmd/Ctrl + 0 for reset
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const mod = isClientMacOS && isNativeApp() ? e.metaKey : e.ctrlKey
      if (!mod || e.shiftKey || e.altKey) return

      const key = e.key
      if (key !== '=' && key !== '+' && key !== '-' && key !== '0') return

      e.preventDefault()
      e.stopPropagation()

      const currentZoom = zoomLevel
      const currentIndex = findNearestTickIndex(currentZoom)

      let newZoom = currentZoom
      if (key === '0') {
        newZoom = ZOOM_LEVEL_DEFAULT
      } else if (key === '=' || key === '+') {
        const nextIndex = Math.min(currentIndex + 1, tickValues.length - 1)
        newZoom = tickValues[nextIndex] ?? currentZoom
      } else if (key === '-') {
        const prevIndex = Math.max(currentIndex - 1, 0)
        newZoom = tickValues[prevIndex] ?? currentZoom
      }

      if (newZoom !== currentZoom && preferences) {
        if (syncZoomLevels) {
          patchPreferences.mutate({
            zoom_level: newZoom,
            mobile_zoom_level: newZoom,
          })
        } else if (isMobile) {
          patchPreferences.mutate({ mobile_zoom_level: newZoom })
        } else {
          patchPreferences.mutate({ zoom_level: newZoom })
        }
      }
    }

    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () =>
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isMobile, patchPreferences, preferences, syncZoomLevels, zoomLevel])
}
