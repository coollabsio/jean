/**
 * Tracks the visible chat composer so mobile toasts can sit in the
 * message area, just above the textarea instead of covering it.
 */

const listeners = new Set<() => void>()
const composers = new Set<HTMLElement>()

export const CHAT_COMPOSER_GUTTER = 12

let cachedBottomOffset = 0
let resizeObserver: ResizeObserver | null = null
let windowListenersBound = false

function emit(): void {
  for (const listener of listeners) listener()
}

function observeComposer(el: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return
  if (!resizeObserver) {
    resizeObserver = new ResizeObserver(() => {
      recomputeChatComposerBottomOffset()
    })
  }
  resizeObserver.observe(el)
}

function unobserveComposer(el: HTMLElement): void {
  resizeObserver?.unobserve(el)
}

function bindWindowListeners(): void {
  if (windowListenersBound || typeof window === 'undefined') return
  windowListenersBound = true
  window.addEventListener('resize', recomputeChatComposerBottomOffset)
  window.visualViewport?.addEventListener(
    'resize',
    recomputeChatComposerBottomOffset
  )
  window.visualViewport?.addEventListener(
    'scroll',
    recomputeChatComposerBottomOffset
  )
}

function unbindWindowListeners(): void {
  if (!windowListenersBound || typeof window === 'undefined') return
  windowListenersBound = false
  window.removeEventListener('resize', recomputeChatComposerBottomOffset)
  window.visualViewport?.removeEventListener(
    'resize',
    recomputeChatComposerBottomOffset
  )
  window.visualViewport?.removeEventListener(
    'scroll',
    recomputeChatComposerBottomOffset
  )
}

export function computeChatComposerBottomOffset(
  elements: Iterable<HTMLElement> = composers,
  viewportHeight = typeof window === 'undefined' ? 0 : window.innerHeight,
  gutter = CHAT_COMPOSER_GUTTER
): number {
  let best = 0
  for (const el of elements) {
    const rect = el.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue
    best = Math.max(best, Math.round(viewportHeight - rect.top))
  }
  return best > 0 ? best + gutter : 0
}

export function recomputeChatComposerBottomOffset(): number {
  const next = computeChatComposerBottomOffset()
  if (next !== cachedBottomOffset) {
    cachedBottomOffset = next
    emit()
  }
  return cachedBottomOffset
}

export function registerChatComposer(el: HTMLElement): () => void {
  composers.add(el)
  observeComposer(el)
  bindWindowListeners()
  recomputeChatComposerBottomOffset()

  return () => {
    composers.delete(el)
    unobserveComposer(el)
    if (composers.size === 0) {
      resizeObserver?.disconnect()
      resizeObserver = null
      unbindWindowListeners()
    }
    recomputeChatComposerBottomOffset()
  }
}

export function getChatComposerBottomOffset(): number {
  return cachedBottomOffset
}

export function subscribeChatComposerMetrics(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test-only: drop registered composers and cached measurements. */
export function resetChatComposerMetrics(): void {
  for (const el of composers) {
    unobserveComposer(el)
  }
  composers.clear()
  resizeObserver?.disconnect()
  resizeObserver = null
  unbindWindowListeners()
  cachedBottomOffset = 0
}
