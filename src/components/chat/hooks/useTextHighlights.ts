import { useCallback, useEffect, useRef } from 'react'
import { useChatStore } from '@/store/chat-store'
import type { TextHighlight } from '@/types/chat'

const HIGHLIGHT_NAME = 'user-highlight'

/**
 * Manages rendering of user-created text highlights using the CSS Custom Highlight API.
 * Re-applies highlights whenever the message list re-renders (scrolling, new messages, etc.).
 *
 * @param sessionId - Current session ID
 * @param containerRef - Ref to the scrollable message container
 */
export function useTextHighlights(
  sessionId: string | undefined,
  containerRef: React.RefObject<HTMLDivElement | null>
) {
  const prevHighlightsRef = useRef<TextHighlight[]>([])

  // Apply highlights by walking the DOM and matching text
  const applyHighlights = useCallback(() => {
    if (!CSS.highlights || !containerRef.current || !sessionId) return

    const highlights =
      useChatStore.getState().sessionHighlights[sessionId] ?? []

    if (highlights.length === 0) {
      CSS.highlights.delete(HIGHLIGHT_NAME)
      return
    }

    const container = containerRef.current
    const ranges: Range[] = []

    // Group highlights by message_id for efficient DOM traversal
    const byMessage = new Map<string, TextHighlight[]>()
    for (const h of highlights) {
      const list = byMessage.get(h.message_id) ?? []
      list.push(h)
      byMessage.set(h.message_id, list)
    }

    for (const [messageId, messageHighlights] of byMessage) {
      // Find the message container element
      const messageEl = container.querySelector(
        `[data-message-id="${messageId}"]`
      )
      if (!messageEl) continue

      for (const highlight of messageHighlights) {
        const range = findTextRange(messageEl, highlight.text)
        if (range) {
          ranges.push(range)
        }
      }
    }

    if (ranges.length > 0) {
      CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...ranges))
    } else {
      CSS.highlights.delete(HIGHLIGHT_NAME)
    }
  }, [sessionId, containerRef])

  // Re-apply when highlights change in store
  useEffect(() => {
    if (!sessionId) return

    const unsubscribe = useChatStore.subscribe(state => {
      const current = state.sessionHighlights[sessionId] ?? []
      if (current !== prevHighlightsRef.current) {
        prevHighlightsRef.current = current
        // Small delay to let DOM settle after React render
        requestAnimationFrame(() => applyHighlights())
      }
    })

    return unsubscribe
  }, [sessionId, applyHighlights])

  // Re-apply on mount and when session changes
  useEffect(() => {
    // Delay to ensure messages are rendered
    const timer = setTimeout(() => applyHighlights(), 100)
    return () => {
      clearTimeout(timer)
      CSS.highlights?.delete(HIGHLIGHT_NAME)
    }
  }, [sessionId, applyHighlights])

  // Expose manual re-apply for use after scroll/load-more
  return { applyHighlights }
}

/**
 * Find a text range in the DOM that matches the given text string.
 * Uses TreeWalker to walk text nodes and find the first occurrence.
 */
function findTextRange(container: Element, searchText: string): Range | null {
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_TEXT,
    null
  )

  // Collect all text nodes and build a concatenated string
  const textNodes: Text[] = []
  const offsets: number[] = [] // cumulative offset of each text node
  let totalText = ''

  let node: Text | null
  while ((node = walker.nextNode() as Text | null)) {
    const content = node.textContent ?? ''
    offsets.push(totalText.length)
    totalText += content
    textNodes.push(node)
  }

  // Find the search text in the concatenated string
  const matchIndex = totalText.indexOf(searchText)
  if (matchIndex === -1) return null

  // Map the match back to DOM ranges
  const matchEnd = matchIndex + searchText.length
  let startNode: Text | null = null
  let startOffset = 0
  let endNode: Text | null = null
  let endOffset = 0

  for (let i = 0; i < textNodes.length; i++) {
    const nodeStart = offsets[i]!
    const nodeEnd = nodeStart + (textNodes[i]!.textContent?.length ?? 0)

    if (!startNode && matchIndex < nodeEnd) {
      startNode = textNodes[i]!
      startOffset = matchIndex - nodeStart
    }
    if (matchEnd <= nodeEnd) {
      endNode = textNodes[i]!
      endOffset = matchEnd - nodeStart
      break
    }
  }

  if (!startNode || !endNode) return null

  try {
    const range = new Range()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    return range
  } catch {
    return null
  }
}
