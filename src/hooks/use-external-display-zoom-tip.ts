import { useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import { isNativeApp } from '@/lib/environment'
import { useClientZoom } from '@/lib/client-zoom'

export const EXTERNAL_DISPLAY_ZOOM_TIP_TOAST_ID = 'external-display-zoom-tip'

/** 1× (and near-1× fractional) displays where page zoom softens text most. */
export function isLowDensityDisplay(devicePixelRatio = window.devicePixelRatio): boolean {
  return devicePixelRatio > 0 && devicePixelRatio <= 1.01
}

export function shouldShowExternalDisplayZoomTip(options: {
  isNative: boolean
  zoomLevel: number
  hasSeenTip: boolean
  devicePixelRatio?: number
}): boolean {
  if (!options.isNative) return false
  if (options.hasSeenTip) return false
  if (Math.abs(options.zoomLevel - 100) < 0.5) return false
  if (!isLowDensityDisplay(options.devicePixelRatio)) return false
  return true
}

/**
 * One-time toast when Jean is on a 1× display (typical external LCD) with
 * webview zoom ≠ 100%. Non-100% page zoom is the most common app-side cause
 * of soft text on macOS multi-monitor setups.
 */
export function useExternalDisplayZoomTip() {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const shownRef = useRef(false)

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
      preferences == null,
    ]
  )
  const { zoom_level: zoomLevel, sync_zoom_levels: syncZoomLevels, updateZoom } =
    useClientZoom(zoomSeed)
  const hasSeenTip = preferences?.has_seen_external_display_zoom_tip ?? false

  useEffect(() => {
    if (!isNativeApp() || preferences == null) return

    const markSeen = () => {
      if (hasSeenTip) return
      patchPreferences.mutate({ has_seen_external_display_zoom_tip: true })
    }

    const setZoomTo100 = () => {
      // Zoom is client-local; only the tip dismissal is shared preferences.
      updateZoom({
        zoom_level: 100,
        ...(syncZoomLevels ? { mobile_zoom_level: 100 } : {}),
      })
      patchPreferences.mutate({ has_seen_external_display_zoom_tip: true })
    }

    const evaluate = () => {
      const shouldShow = shouldShowExternalDisplayZoomTip({
        isNative: true,
        zoomLevel,
        hasSeenTip,
        devicePixelRatio: window.devicePixelRatio,
      })

      if (!shouldShow) {
        toast.dismiss(EXTERNAL_DISPLAY_ZOOM_TIP_TOAST_ID)
        return
      }

      if (shownRef.current) return
      shownRef.current = true

      toast.warning('Text may look soft on this display', {
        id: EXTERNAL_DISPLAY_ZOOM_TIP_TOAST_ID,
        description:
          'Use 100% zoom for the sharpest text on external monitors. Font scaling in Appearance can still enlarge the UI.',
        duration: Infinity,
        dismissible: true,
        action: {
          label: 'Use 100%',
          onClick: () => {
            setZoomTo100()
            toast.dismiss(EXTERNAL_DISPLAY_ZOOM_TIP_TOAST_ID)
          },
        },
        onDismiss: () => {
          markSeen()
        },
        onAutoClose: () => {
          markSeen()
        },
      })
    }

    // Slight delay so the tip appears after first paint / prefs hydrate,
    // not under splash or competing startup toasts.
    const timer = window.setTimeout(evaluate, 1200)

    let unlisten: (() => void) | undefined
    let cancelled = false
    let lastDpr = window.devicePixelRatio

    void (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        if (cancelled) return
        unlisten = await getCurrentWindow().onScaleChanged(() => {
          lastDpr = window.devicePixelRatio
          // Allow re-show only if the tip was never dismissed and conditions
          // become true after moving to a 1× display.
          if (!hasSeenTip) {
            shownRef.current = false
          }
          evaluate()
        })
      } catch {
        // Non-fatal: scale listener is best-effort.
      }
    })()

    const onResize = () => {
      const next = window.devicePixelRatio
      if (Math.abs(next - lastDpr) < 0.001) return
      lastDpr = next
      if (!hasSeenTip) {
        shownRef.current = false
      }
      evaluate()
    }
    window.addEventListener('resize', onResize)

    return () => {
      cancelled = true
      window.clearTimeout(timer)
      unlisten?.()
      window.removeEventListener('resize', onResize)
    }
  }, [
    hasSeenTip,
    patchPreferences,
    preferences,
    syncZoomLevels,
    updateZoom,
    zoomLevel,
  ])
}
