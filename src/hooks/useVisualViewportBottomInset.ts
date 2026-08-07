import { useEffect, useState, type RefObject } from 'react'

/**
 * How many CSS pixels of `elementRef`'s bottom edge sit below the visual
 * viewport (typically covered by a mobile soft keyboard).
 *
 * Returns 0 when the element is fully visible, the Visual Viewport API is
 * unavailable, or the keyboard is closed.
 *
 * On iOS Safari the layout viewport often does not shrink with the keyboard
 * even with `interactive-widget=resizes-content`; consumers should apply this
 * value as `padding-bottom` so bottom chrome (e.g. terminal extra-keys bar)
 * rides above the keyboard.
 */
export function useVisualViewportBottomInset(
  elementRef: RefObject<HTMLElement | null>,
  enabled = true
): number {
  const [inset, setInset] = useState(0)

  useEffect(() => {
    if (!enabled) {
      setInset(0)
      return
    }

    const vv = window.visualViewport
    let raf = 0
    let timer: ReturnType<typeof setTimeout> | null = null

    const measure = () => {
      const el = elementRef.current
      if (!el) {
        setInset(0)
        return
      }

      const rect = el.getBoundingClientRect()
      // Visual viewport bottom in layout coordinates.
      const vvBottom = vv ? vv.offsetTop + vv.height : window.innerHeight
      // How much of this element extends past the visible viewport bottom.
      const next = Math.max(0, Math.round(rect.bottom - vvBottom))
      setInset(prev => (prev === next ? prev : next))
    }

    const scheduleMeasure = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        measure()
        // iOS keyboard animation continues after the first resize event.
        if (timer) clearTimeout(timer)
        timer = setTimeout(measure, 100)
      })
    }

    measure()

    vv?.addEventListener('resize', scheduleMeasure)
    vv?.addEventListener('scroll', scheduleMeasure)
    window.addEventListener('resize', scheduleMeasure)
    // xterm focuses a hidden textarea — remeasure after focus settles.
    window.addEventListener('focusin', scheduleMeasure)
    window.addEventListener('focusout', scheduleMeasure)

    return () => {
      cancelAnimationFrame(raf)
      if (timer) clearTimeout(timer)
      vv?.removeEventListener('resize', scheduleMeasure)
      vv?.removeEventListener('scroll', scheduleMeasure)
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('focusin', scheduleMeasure)
      window.removeEventListener('focusout', scheduleMeasure)
    }
  }, [elementRef, enabled])

  return enabled ? inset : 0
}

/**
 * Window-level keyboard inset: layout bottom minus visual viewport bottom.
 * Useful when the target fills the screen.
 */
export function getWindowKeyboardInset(): number {
  if (typeof window === 'undefined') return 0
  const vv = window.visualViewport
  if (!vv) return 0
  return Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
}
