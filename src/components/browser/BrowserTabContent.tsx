import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { browserBackend } from '@/hooks/useBrowserPane'
import { useBrowserStore } from '@/store/browser-store'
import { isNativeApp } from '@/lib/environment'

interface BrowserTabContentProps {
  tabId: string
  /** Active tab is shown; inactive tabs are hidden via webview.hide() */
  isActive: boolean
  /** Bumps when surface layout changes (dock side, drawer mode) so the
   * stable-frame detector reruns and webview re-anchors to new placeholder
   * position. ResizeObserver doesn't fire on transform/portal moves. */
  relayoutNonce?: string | number
}

/** Distance from the document top required for the webview to clear the
 * macOS overlay title bar / TitleBar component. */
const TOP_SAFETY = 0

/** Off-screen parking spot for inactive tab webviews. WKWebView's hide() on
 * a child webview doesn't reliably stop pixels from compositing — a sibling
 * at the same bounds can bleed through. Parking inactive webviews far
 * off-screen guarantees only the active one paints over the visible pane. */
const OFFSCREEN_BOUNDS = { x: -100000, y: -100000, width: 1, height: 1 }

async function parkAndHideIfActive(tabId: string): Promise<void> {
  try {
    const exists = await browserBackend.hasActive(tabId)
    if (!exists) return
    await browserBackend.setBounds(tabId, OFFSCREEN_BOUNDS)
    await browserBackend.setVisible(tabId, false)
  } catch (err) {
    // Cleanup races are expected when a tab is intentionally closed: the store
    // removes React content while `browser_close` unregisters the native
    // webview. Log instead of letting a rejected cleanup promise hit the global
    // unhandled-rejection toast.
    console.warn(`[browser] cleanup failed for tab ${tabId}:`, err)
  }
}

/**
 * Renders an empty placeholder div whose bounding rect drives the position of
 * the underlying native child Webview. The webview itself lives in Rust.
 *
 * Lifecycle:
 *   1. On mount: read the persisted URL for this tab, call `browser_create`.
 *      If the backend already has a webview for this tab_id (recreation after
 *      navigation between worktrees), `browser_set_bounds` instead.
 *   2. ResizeObserver + window resize → debounced rAF → `browser_set_bounds`.
 *   3. Active flag flips → `browser_set_visible`.
 *   4. On unmount: hide (do NOT close — keeps history when re-mounted).
 */
export const BrowserTabContent = memo(function BrowserTabContent({
  tabId,
  isActive,
  relayoutNonce,
}: BrowserTabContentProps) {
  const placeholderRef = useRef<HTMLDivElement>(null)
  const lastBoundsRef = useRef<{
    x: number
    y: number
    width: number
    height: number
  } | null>(null)
  const initializedRef = useRef(false)
  const rafRef = useRef<number | null>(null)
  // Mirror isActive for closures (flushBounds, ResizeObserver) — when inactive,
  // they must not push real bounds and undo our off-screen parking.
  const isActiveRef = useRef(isActive)
  useLayoutEffect(() => {
    isActiveRef.current = isActive
  })

  // Read URL once at mount (subsequent updates handled by Rust → React events)
  const initialUrl = useBrowserStore(
    state =>
      state.tabs[
        Object.keys(state.tabs).find(wid =>
          state.tabs[wid]?.some(t => t.id === tabId)
        ) ?? ''
      ]?.find(t => t.id === tabId)?.url ?? ''
  )

  // Returns PHYSICAL pixels. Rust side uses PhysicalPosition/PhysicalSize
  // because Tauri's scale_factor() can disagree with WKWebView's
  // window.devicePixelRatio under fractional macOS display scaling
  // ("More Space" modes on Retina). Sending physical bypasses the conversion.
  const measure = (): {
    x: number
    y: number
    width: number
    height: number
  } | null => {
    const el = placeholderRef.current
    if (!el) return null
    const rect = el.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    return {
      x: Math.round(rect.left * dpr),
      y: Math.round(Math.max(rect.top, TOP_SAFETY) * dpr),
      width: Math.round(Math.max(rect.width, 1) * dpr),
      height: Math.round(Math.max(rect.height, 1) * dpr),
    }
  }

  const flushBounds = (): void => {
    if (!initializedRef.current) return
    if (!isActiveRef.current) return
    const next = measure()
    if (!next) return
    const prev = lastBoundsRef.current
    if (
      prev &&
      prev.x === next.x &&
      prev.y === next.y &&
      prev.width === next.width &&
      prev.height === next.height
    ) {
      return
    }
    lastBoundsRef.current = next
    void browserBackend.setBounds(tabId, next)
  }

  const scheduleFlush = (): void => {
    if (rafRef.current != null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      flushBounds()
    })
  }

  // Mount + relayout: poll bounds via rAF until stable for 2 consecutive
  // frames (handles Sheet slide-in / dock-side switches / other
  // ResizeObserver-blind ancestor transforms). Webview hides during the
  // detect phase, then commits final position in one shot.
  useLayoutEffect(() => {
    let cancelled = false
    let rafId: number | null = null
    let stableFrames = 0
    let candidate: ReturnType<typeof measure> = null
    const STABLE_FRAMES_REQUIRED = 2
    const MAX_FRAMES = 60 // ~1s safety cap

    // For a relayout (post-init), hide the webview while the new position
    // settles to avoid showing it briefly at the old coords.
    if (initializedRef.current) {
      void browserBackend.setVisible(tabId, false)
    }

    let frameCount = 0
    const tick = async () => {
      if (cancelled) return
      frameCount++
      const next = measure()
      if (!next) {
        rafId = requestAnimationFrame(() => void tick())
        return
      }
      if (
        candidate &&
        candidate.x === next.x &&
        candidate.y === next.y &&
        candidate.width === next.width &&
        candidate.height === next.height
      ) {
        stableFrames++
      } else {
        candidate = next
        stableFrames = 1
      }
      if (stableFrames >= STABLE_FRAMES_REQUIRED || frameCount >= MAX_FRAMES) {
        await commit(next)
        return
      }
      rafId = requestAnimationFrame(() => void tick())
    }

    const commit = async (bounds: NonNullable<ReturnType<typeof measure>>) => {
      if (cancelled) return
      const exists = await browserBackend.hasActive(tabId)
      if (cancelled) return
      lastBoundsRef.current = bounds
      try {
        if (exists) {
          await browserBackend.setBounds(tabId, bounds)
        } else if (initialUrl) {
          await browserBackend.create(tabId, initialUrl, bounds)
        }
        initializedRef.current = true
        if (isActive) {
          await browserBackend.setVisible(tabId, true)
        }
      } catch (err) {
        console.error(`[browser] init failed for tab ${tabId}:`, err)
      }
    }

    rafId = requestAnimationFrame(() => void tick())

    return () => {
      cancelled = true
      if (rafId != null) cancelAnimationFrame(rafId)
    }
    // initialUrl is read once at mount; subsequent URL changes flow through
    // Rust → React events which update the store but should not re-create
    // the webview. Intentionally omit it from deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, relayoutNonce])

  // Track placeholder size + window resize → push new bounds
  useEffect(() => {
    const el = placeholderRef.current
    if (!el) return
    const observer = new ResizeObserver(() => scheduleFlush())
    observer.observe(el)
    window.addEventListener('resize', scheduleFlush)
    window.addEventListener('scroll', scheduleFlush, true)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', scheduleFlush)
      window.removeEventListener('scroll', scheduleFlush, true)
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = null
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Toggle visibility on active flip. Inactive tabs are parked off-screen
  // (in addition to webview.hide()) so a hide() that fails to stop pixel
  // composition can't leak the previous tab's content over the active one.
  useEffect(() => {
    if (!initializedRef.current) return
    if (isActive) {
      const next = measure()
      if (next) {
        lastBoundsRef.current = next
        void browserBackend.setBounds(tabId, next)
      }
      void browserBackend.setVisible(tabId, true)
      // Re-measure after pane reveal in case layout changed while hidden
      scheduleFlush()
    } else {
      void browserBackend.setBounds(tabId, OFFSCREEN_BOUNDS)
      lastBoundsRef.current = OFFSCREEN_BOUNDS
      void browserBackend.setVisible(tabId, false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, tabId])

  // On unmount: park off-screen + hide (keeps webview alive in Rust for re-mount)
  useEffect(() => {
    return () => {
      void parkAndHideIfActive(tabId)
    }
  }, [tabId])

  // Listen for display scale changes (window dragged to different-DPI screen).
  // JS resize events don't always fire on pure DPR changes, but Tauri's
  // onScaleChanged does. Re-flush so bounds re-measure under new dpr.
  useEffect(() => {
    if (!isNativeApp()) return
    const win = getCurrentWindow()
    let unlisten: (() => void) | null = null
    void win
      .onScaleChanged(() => scheduleFlush())
      .then(fn => {
        unlisten = fn
      })
    return () => {
      if (unlisten) unlisten()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={placeholderRef}
      className="relative h-full w-full"
      data-browser-tab-id={tabId}
    />
  )
})
