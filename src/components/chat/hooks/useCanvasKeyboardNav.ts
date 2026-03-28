import { useCallback, useEffect, useRef } from 'react'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'

interface UseCanvasKeyboardNavOptions<T> {
  /** Array of cards/items to navigate */
  cards: T[]
  /** Current selected index */
  selectedIndex: number | null
  /** Callback when selection changes */
  onSelectedIndexChange: (index: number | null) => void
  /** Callback when Enter is pressed on selected item */
  onSelect: (index: number) => void
  /** Whether keyboard navigation is enabled (disable when modal open) */
  enabled: boolean
  /** Optional callback when selection changes (for tracking in store) */
  onSelectionChange?: (index: number) => void
}

interface UseCanvasKeyboardNavResult {
  /** Refs array for card elements (needed for vertical neighbor finding) */
  cardRefs: React.MutableRefObject<(HTMLDivElement | null)[]>
  /** Scroll selected card into view */
  scrollSelectedIntoView: () => void
}

/**
 * Shared keyboard navigation hook for canvas views.
 * Handles arrow keys, Enter, and visual-position-based vertical navigation.
 */
const THROTTLE_MS = 50

export function useCanvasKeyboardNav<T>({
  cards,
  selectedIndex,
  onSelectedIndexChange,
  onSelect,
  enabled,
  onSelectionChange,
}: UseCanvasKeyboardNavOptions<T>): UseCanvasKeyboardNavResult {
  const cardRefs = useRef<(HTMLDivElement | null)[]>([])

  // Use refs to avoid stale closures in event handler
  const selectedIndexRef = useRef(selectedIndex)

  selectedIndexRef.current = selectedIndex

  const cardsLengthRef = useRef(cards.length)

  cardsLengthRef.current = cards.length

  // Throttle rapid key presses
  const lastKeyTimeRef = useRef(0)

  // Track when command palette (or any modal) closes to prevent Enter key leaking
  const lastModalCloseRef = useRef(0)
  const prevCommandPaletteOpen = useRef(
    useUIStore.getState().commandPaletteOpen
  )

  useEffect(() => {
    return useUIStore.subscribe(state => {
      if (prevCommandPaletteOpen.current && !state.commandPaletteOpen) {
        lastModalCloseRef.current = Date.now()
      }
      prevCommandPaletteOpen.current = state.commandPaletteOpen
    })
  }, [])

  // Global keyboard navigation
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // Skip if any modal is open (magic, plan dialog, etc.)
      const uiState = useUIStore.getState()
      if (
        uiState.magicModalOpen ||
        uiState.planDialogOpen ||
        uiState.commandPaletteOpen ||
        uiState.preferencesOpen ||
        uiState.releaseNotesModalOpen
      )
        return
      if (useProjectsStore.getState().projectSettingsDialogOpen) return

      // Skip if a dialog just closed (prevents Enter/arrow keys leaking from command palette)
      if (Date.now() - lastModalCloseRef.current < 150) return

      // Skip if focus is inside any dialog (catches modals not tracked in UI store)
      if (document.activeElement?.closest('[role="dialog"]')) return

      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        (document.activeElement as HTMLElement)?.isContentEditable
      ) {
        return
      }

      // Throttle rapid key presses to prevent skipping
      const now = Date.now()
      if (now - lastKeyTimeRef.current < THROTTLE_MS) return
      lastKeyTimeRef.current = now

      // Use refs to get current values (avoids stale closures)
      const currentIndex = selectedIndexRef.current
      const total = cardsLengthRef.current
      if (total === 0) return

      if (currentIndex === null) {
        if (
          ['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(e.key)
        ) {
          onSelectedIndexChange(0)
          onSelectionChange?.(0)
          e.preventDefault()
        }
        return
      }

      const updateSelection = (newIndex: number) => {
        onSelectedIndexChange(newIndex)
        onSelectionChange?.(newIndex)
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          if (currentIndex < total - 1) {
            updateSelection(currentIndex + 1)
          }
          break
        case 'ArrowUp':
          e.preventDefault()
          if (currentIndex > 0) {
            updateSelection(currentIndex - 1)
          }
          break
        case 'Enter':
          if (e.metaKey || e.ctrlKey) return
          e.preventDefault()
          onSelect(currentIndex)
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [enabled, onSelectedIndexChange, onSelect, onSelectionChange])

  // Scroll selected card into view when selection changes
  // Uses manual scroll to ensure group/section headers above the card stay visible
  const scrollSelectedIntoView = useCallback(() => {
    if (selectedIndex === null) return
    const card = cardRefs.current[selectedIndex]
    if (!card) return

    const scrollContainer = card.closest('.overflow-auto')
    if (!scrollContainer) {
      card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      return
    }

    // Find the sticky header inside the scroll container to get the actual visible top edge
    const stickyHeader = scrollContainer.querySelector('.sticky')
    const visibleTop = stickyHeader
      ? stickyHeader.getBoundingClientRect().bottom
      : scrollContainer.getBoundingClientRect().top

    const containerRect = scrollContainer.getBoundingClientRect()
    const cardRect = card.getBoundingClientRect()

    // Extra margin above to keep section/group headers visible (~60px for worktree header + group label)
    const topPadding = 60
    const bottomMargin = 80

    if (cardRect.top < visibleTop + topPadding) {
      // Card is behind sticky header or too close — scroll up
      const scrollDelta = cardRect.top - visibleTop - topPadding
      scrollContainer.scrollBy({ top: scrollDelta, behavior: 'smooth' })
    } else if (cardRect.bottom > containerRect.bottom - bottomMargin) {
      // Card is below visible area — scroll down
      const scrollDelta = cardRect.bottom - containerRect.bottom + bottomMargin
      scrollContainer.scrollBy({ top: scrollDelta, behavior: 'smooth' })
    }
  }, [selectedIndex])

  // Auto-scroll on selection change
  useEffect(() => {
    scrollSelectedIntoView()
  }, [scrollSelectedIntoView])

  return {
    cardRefs,
    scrollSelectedIntoView,
  }
}
