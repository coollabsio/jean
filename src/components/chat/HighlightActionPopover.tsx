import { useCallback, useEffect, useRef, useState } from 'react'
import { Highlighter, X } from 'lucide-react'
import { useChatStore } from '@/store/chat-store'
import { generateId } from '@/lib/uuid'
import type { TextHighlight } from '@/types/chat'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

interface HighlightActionPopoverProps {
  sessionId: string
  /** Ref to the scrollable message container */
  containerRef: React.RefObject<HTMLDivElement | null>
}

/**
 * Floating popover that appears when text is selected in a message.
 * Shows a highlighter icon to create a highlight, or an X to remove an existing one.
 */
export function HighlightActionPopover({
  sessionId,
  containerRef,
}: HighlightActionPopoverProps) {
  const [popover, setPopover] = useState<{
    x: number
    y: number
    type: 'add' | 'remove'
    // For 'add': selection info
    messageId?: string
    text?: string
    startOffset?: number
    // For 'remove': highlight to remove
    highlightId?: string
  } | null>(null)

  const popoverRef = useRef<HTMLDivElement>(null)
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Cancel any pending dismiss when the mouse enters the popover
  const handlePopoverMouseEnter = useCallback(() => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current)
      dismissTimerRef.current = null
    }
  }, [])

  // Start dismiss timer when the mouse leaves the popover
  const handlePopoverMouseLeave = useCallback(() => {
    dismissTimerRef.current = setTimeout(() => {
      setPopover(prev => (prev?.type === 'remove' ? null : prev))
    }, 300)
  }, [])

  // Handle text selection for adding highlights.
  // NOTE: We register the handler unconditionally on `document` and read
  // containerRef.current lazily inside the handler. This avoids a race where
  // the effect runs before ScrollArea mounts (containerRef.current is null)
  // and the handler is never registered.
  useEffect(() => {
    const handleSelectionChange = () => {
      const container = containerRef.current
      if (!container) return

      const selection = window.getSelection()
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        // Don't dismiss if mouse is over the popover
        if (popoverRef.current?.matches(':hover')) return
        setPopover(null)
        return
      }

      const range = selection.getRangeAt(0)
      if (!range || !container.contains(range.commonAncestorContainer)) {
        return
      }

      // Find the message element containing the selection
      const messageEl = findMessageElement(range.commonAncestorContainer)
      if (!messageEl) return

      const messageId = messageEl.getAttribute('data-message-id')
      if (!messageId) return

      const selectedText = selection.toString().trim()
      if (!selectedText || selectedText.length < 2) return

      // Compute the character offset within the message content
      const startOffset = getTextOffset(
        messageEl,
        range.startContainer,
        range.startOffset
      )

      // Position the popover near the end of the selection (viewport-fixed coords)
      const rect = range.getBoundingClientRect()

      setPopover({
        x: rect.right,
        y: rect.top - 32,
        type: 'add',
        messageId,
        text: selectedText,
        startOffset,
      })
    }

    document.addEventListener('selectionchange', handleSelectionChange)
    return () =>
      document.removeEventListener('selectionchange', handleSelectionChange)
  }, [containerRef, sessionId])

  // Handle mouse enter on existing highlights to show remove button
  useEffect(() => {
    let lastCheck = 0
    const handleMouseMove = (e: MouseEvent) => {
      const container = containerRef.current
      if (!container) return
      // Throttle to ~60fps
      const now = Date.now()
      if (now - lastCheck < 16) return
      lastCheck = now

      // Don't show remove popover when there's an active text selection
      const selection = window.getSelection()
      if (selection && !selection.isCollapsed) return

      if (!CSS.highlights) return

      const highlight = CSS.highlights.get('user-highlight')
      if (!highlight) return

      const highlights =
        useChatStore.getState().sessionHighlights[sessionId] ?? []
      if (highlights.length === 0) return

      // Check each highlight range to see if the mouse is over it
      for (const abstractRange of highlight) {
        if (!(abstractRange instanceof Range)) continue
        const rects = abstractRange.getClientRects()
        for (const rect of rects) {
          if (
            e.clientX >= rect.left &&
            e.clientX <= rect.right &&
            e.clientY >= rect.top &&
            e.clientY <= rect.bottom
          ) {
            // Find which highlight this range belongs to
            const rangeText = abstractRange.toString()
            const matchingHighlight = highlights.find(
              h => h.text === rangeText
            )
            if (!matchingHighlight) continue

            // Cancel any pending dismiss -- mouse is back on a highlight
            if (dismissTimerRef.current) {
              clearTimeout(dismissTimerRef.current)
              dismissTimerRef.current = null
            }
            setPopover({
              x: rect.right,
              y: rect.top - 32,
              type: 'remove',
              highlightId: matchingHighlight.id,
            })
            return
          }
        }
      }

      // Mouse not over any highlight -- dismiss with grace period
      if (!dismissTimerRef.current) {
        dismissTimerRef.current = setTimeout(() => {
          dismissTimerRef.current = null
          // Re-check: don't dismiss if mouse is now over the popover
          if (popoverRef.current?.matches(':hover')) return
          setPopover(prev => (prev?.type === 'remove' ? null : prev))
        }, 300)
      }
    }

    document.addEventListener('mousemove', handleMouseMove)
    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      if (dismissTimerRef.current) {
        clearTimeout(dismissTimerRef.current)
        dismissTimerRef.current = null
      }
    }
  }, [containerRef, sessionId])

  // Dismiss when clicking outside
  useEffect(() => {
    if (!popover) return

    const handleMouseDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node)
      ) {
        // Small delay to let selection handlers fire first
        setTimeout(() => {
          const selection = window.getSelection()
          if (!selection || selection.isCollapsed) {
            setPopover(null)
          }
        }, 100)
      }
    }

    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [popover])

  const handleAdd = useCallback(() => {
    if (popover?.type !== 'add' || !popover.messageId || !popover.text) return

    const highlight: TextHighlight = {
      id: generateId(),
      message_id: popover.messageId,
      text: popover.text,
      start_offset: popover.startOffset ?? 0,
    }

    useChatStore.getState().addHighlight(sessionId, highlight)

    // Clear the selection
    window.getSelection()?.removeAllRanges()
    setPopover(null)
  }, [popover, sessionId])

  const handleRemove = useCallback(() => {
    if (popover?.type !== 'remove' || !popover.highlightId) return

    useChatStore.getState().removeHighlight(sessionId, popover.highlightId)
    setPopover(null)
  }, [popover, sessionId])

  if (!popover) return null

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 flex items-center"
      style={{
        left: popover.x,
        top: popover.y,
      }}
      onMouseEnter={handlePopoverMouseEnter}
      onMouseLeave={handlePopoverMouseLeave}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={popover.type === 'add' ? handleAdd : handleRemove}
            className={`p-1 rounded-md shadow-md border border-border cursor-pointer transition-colors ${
              popover.type === 'remove'
                ? 'bg-destructive/10 hover:bg-destructive/20 text-destructive'
                : 'bg-yellow-500/20 hover:bg-yellow-500/30 text-yellow-600 dark:text-yellow-400'
            }`}
          >
            {popover.type === 'remove' ? (
              <X className="size-3.5" />
            ) : (
              <Highlighter className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>
          {popover.type === 'remove' ? 'Remove highlight' : 'Highlight text'}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/** Walk up the DOM to find the nearest element with data-message-id */
function findMessageElement(node: Node): Element | null {
  let current: Node | null = node
  while (current) {
    if (
      current instanceof Element &&
      current.hasAttribute('data-message-id')
    ) {
      return current
    }
    current = current.parentNode
  }
  return null
}

/** Compute the text offset of a position within a message element */
function getTextOffset(
  container: Element,
  targetNode: Node,
  targetOffset: number
): number {
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    null
  )

  let offset = 0
  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    if (node === targetNode) {
      return offset + targetOffset
    }
    offset += node.textContent?.length ?? 0
  }
  return offset
}
