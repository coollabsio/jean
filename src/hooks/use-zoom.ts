import { useEffect, useMemo } from 'react'
import { usePreferences } from '@/services/preferences'
import { isNativeApp } from '@/lib/environment'
import { ZOOM_LEVEL_DEFAULT, zoomLevelTicks } from '@/types/preferences'
import { isClientMacOS } from '@/lib/platform'
import { useIsMobile } from '@/hooks/use-mobile'
import { useClientZoom } from '@/lib/client-zoom'

const tickValues = zoomLevelTicks.map(t => t.value)

/** Gap from the window edge to the title bar actions at 100% zoom (CSS px). */
const MAC_TITLEBAR_ACTION_LEFT_INSET = 68
/**
 * Center of the title bar icons from the window top (CSS px): the h-8 bar
 * centers the actions, and their 4px top padding moves the icons down 2px.
 */
const MAC_TITLEBAR_ICON_CENTER = 18

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

/** Apply UI zoom when the saved preference changes. */
async function applyZoom(scaleFactor: number) {
  const root = document.documentElement
  root.style.setProperty('--app-zoom', String(scaleFactor))
  // Fallback when the traffic lights cannot move (they stay at 68pt).
  root.style.setProperty(
    '--mac-titlebar-action-left-inset',
    `${MAC_TITLEBAR_ACTION_LEFT_INSET / scaleFactor}px`
  )
  root.style.setProperty(
    '--mac-titlebar-action-top-inset',
    `${4 + Math.max(0, scaleFactor - 1) * 4}px`
  )

  if (!isNativeApp()) {
    const style = root.style as CSSStyleDeclaration & {
      zoom: string
    }
    style.zoom = ''
    root.style.fontSize = `${16 * scaleFactor}px`
    return
  }

  try {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview')
    await getCurrentWebview().setZoom(scaleFactor)
  } catch (error) {
    console.error('Failed to set zoom:', error)
  }

  if (isClientMacOS) await moveTrafficLights(scaleFactor)
}

/**
 * Move the native macOS traffic lights with the zoom and center them on the
 * title bar icons. AppKit buttons keep their size, so only their position
 * scales; the action inset follows them.
 */
async function moveTrafficLights(scaleFactor: number) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    const span = await invoke<number | null>('set_traffic_light_zoom', {
      zoom: scaleFactor,
      centerY: MAC_TITLEBAR_ICON_CENTER * scaleFactor,
    })
    const root = document.documentElement
    // A newer zoom change already ran; do not write a stale inset.
    if (
      span == null ||
      root.style.getPropertyValue('--app-zoom') !== String(scaleFactor)
    ) {
      return
    }
    const leftInset =
      MAC_TITLEBAR_ACTION_LEFT_INSET + span * (1 / scaleFactor - 1)
    root.style.setProperty('--mac-titlebar-action-left-inset', `${leftInset}px`)
    root.style.setProperty('--mac-titlebar-action-top-inset', '4px')
  } catch (error) {
    console.error('Failed to move traffic lights:', error)
  }
}

/** UI zoom at 100% — re-applying is a no-op and can still disturb the surface. */
function isDefaultZoom(scaleFactor: number): boolean {
  return Math.abs(scaleFactor - 1) < 0.001
}

function sameDisplayScale(a: number | undefined, b: number): boolean {
  return a !== undefined && Math.abs(a - b) < 0.001
}

/**
 * How long to keep absorbing scale events after a zoom bounce.
 * setZoom() can emit delayed scale/DPR side-effects after the awaits resolve.
 */
export const DISPLAY_SCALE_ZOOM_SETTLE_MS = 50

export function useZoom() {
  const { data: preferences } = usePreferences()
  const isMobile = useIsMobile()

  // Zoom is client-local (localStorage) so remote Jean clients and the host
  // shell do not overwrite each other via shared AppPreferences (issue #622).
  const hasPreferences = preferences != null
  const zoomSeed = useMemo(
    () =>
      preferences
        ? {
            zoom_level: preferences.zoom_level,
            mobile_zoom_level: preferences.mobile_zoom_level,
            sync_zoom_levels: preferences.sync_zoom_levels,
          }
        : null,
    [
      preferences?.zoom_level,
      preferences?.mobile_zoom_level,
      preferences?.sync_zoom_levels,
      // preferences identity when still loading → null seed
      hasPreferences,
    ]
  )

  const {
    zoom_level: desktopZoom,
    mobile_zoom_level: mobileZoom,
    sync_zoom_levels: syncZoomLevels,
    updateZoom,
  } = useClientZoom(zoomSeed)

  const zoomLevel = isMobile && !syncZoomLevels ? mobileZoom : desktopZoom

  // Apply zoom when client-local zoom changes
  useEffect(() => {
    void applyZoom(zoomLevel / 100)
  }, [zoomLevel])

  // A native display-scale event is the reliable signal that the window moved
  // between monitors. Do not use resize/devicePixelRatio here: setZoom() can
  // change both and feed the zoom operation back into itself.
  useEffect(() => {
    if (!isNativeApp()) return

    const scaleFactor = zoomLevel / 100
    let unlisten: (() => void) | undefined
    let cancelled = false
    let refreshing = false
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    let lastDisplayScale: number | undefined

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        if (cancelled) return

        unlisten = await getCurrentWindow().onScaleChanged(event => {
          const displayScale = event.payload.scaleFactor

          // 100% zoom does not need a bounce refresh; calling setZoom(1) on
          // every scale change is what made the UI jump continuously.
          if (cancelled || isDefaultZoom(scaleFactor)) {
            return
          }

          // Absorb side-effect scale events from an in-flight (or settling)
          // setZoom bounce so they cannot start another refresh loop.
          if (refreshing) {
            lastDisplayScale = displayScale
            return
          }

          if (sameDisplayScale(lastDisplayScale, displayScale)) {
            return
          }

          lastDisplayScale = displayScale
          refreshing = true
          if (settleTimer !== undefined) {
            clearTimeout(settleTimer)
            settleTimer = undefined
          }

          void (async () => {
            try {
              const { getCurrentWebview } =
                await import('@tauri-apps/api/webview')
              if (cancelled) return
              const webview = getCurrentWebview()
              // Bounce through 1 so WKWebView rebuilds its layer at the new DPR.
              await webview.setZoom(1)
              if (cancelled) return
              await webview.setZoom(scaleFactor)
            } catch (error) {
              console.error(
                'Failed to re-apply zoom after display scale change:',
                error
              )
            } finally {
              // Keep absorbing late scale events for a short settle window.
              settleTimer = setTimeout(() => {
                settleTimer = undefined
                if (!cancelled) {
                  refreshing = false
                }
              }, DISPLAY_SCALE_ZOOM_SETTLE_MS)
            }
          })()
        })
      } catch (error) {
        console.error('Failed to listen for display scale changes:', error)
      }
    })()

    return () => {
      cancelled = true
      if (settleTimer !== undefined) {
        clearTimeout(settleTimer)
      }
      unlisten?.()
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

      if (newZoom === currentZoom) return

      // Always persist on this client only — never patch shared AppPreferences.
      if (syncZoomLevels) {
        updateZoom({
          zoom_level: newZoom,
          mobile_zoom_level: newZoom,
        })
      } else if (isMobile) {
        updateZoom({ mobile_zoom_level: newZoom })
      } else {
        updateZoom({ zoom_level: newZoom })
      }
    }

    document.addEventListener('keydown', handleKeyDown, { capture: true })
    return () =>
      document.removeEventListener('keydown', handleKeyDown, { capture: true })
  }, [isMobile, syncZoomLevels, updateZoom, zoomLevel])
}
