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

/**
 * Apply UI zoom.
 *
 * Native desktop uses WKWebView/WebView2 page zoom. Fractional zoom +
 * multi-monitor scale factors is a common source of soft/blurry text on
 * macOS external displays, so callers re-apply this when the window's
 * scale factor changes.
 */
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

/**
 * WKWebView can keep a stale backing-store scale after the window moves
 * between a Retina laptop panel and an external display. Forcing zoom to
 * 1 first, then back to the target, rebuilds the layer at the new DPR.
 */
async function reapplyNativeZoom(scaleFactor: number) {
  if (!isNativeApp()) {
    await applyZoom(scaleFactor)
    return
  }

  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    const webview = getCurrentWebview()
    // Only bounce through 1 when the target isn't already 1 — avoids a
    // flash for users already at 100% while still refreshing the surface.
    if (Math.abs(scaleFactor - 1) > 0.001) {
      await webview.setZoom(1)
    }
    await webview.setZoom(scaleFactor)
  } catch (error) {
    console.error('Failed to re-apply zoom after scale change:', error)
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
    void applyZoom(zoomLevel / 100)
  }, [zoomLevel])

  // Re-apply zoom when the window moves between displays with different
  // scale factors (classic macOS multi-monitor blur source for webviews).
  useEffect(() => {
    if (!isNativeApp()) return

    const scaleFactor = zoomLevel / 100
    let unlisten: (() => void) | undefined
    let cancelled = false
    let lastDpr = window.devicePixelRatio

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        if (cancelled) return
        unlisten = await getCurrentWindow().onScaleChanged(() => {
          lastDpr = window.devicePixelRatio
          void reapplyNativeZoom(scaleFactor)
        })
      } catch (error) {
        console.error('Failed to listen for display scale changes:', error)
      }
    })()

    // Fallback: some WebKit builds update devicePixelRatio without a clean
    // Tauri scale event (e.g. after sleep/wake with external monitors).
    // Only re-apply when DPR actually changes — not on every window resize.
    const onWindowResize = () => {
      const nextDpr = window.devicePixelRatio
      if (Math.abs(nextDpr - lastDpr) < 0.001) return
      lastDpr = nextDpr
      void reapplyNativeZoom(scaleFactor)
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
      cancelled = true
      unlisten?.()
      window.removeEventListener('resize', onWindowResize)
    }
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
