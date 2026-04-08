import { useCallback, useEffect, useRef, useState } from 'react'
import { useUIStore } from '@/store/ui-store'
import { ChevronUp, ChevronDown, X } from 'lucide-react'

interface ChatSearchBarProps {
  scrollContainerRef: React.RefObject<HTMLElement | null>
}

interface MatchInfo {
  node: Text
  index: number
  length: number
}

function rangeFromMatch(m: MatchInfo): Range | null {
  try {
    const range = new Range()
    range.setStart(m.node, m.index)
    range.setEnd(m.node, m.index + m.length)
    return range
  } catch {
    // DOM may have changed since match was found (React re-render)
    return null
  }
}

function scrollRangeIntoView(range: Range) {
  const el =
    range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer
      : range.commonAncestorContainer.parentElement
  el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

export function ChatSearchBar({ scrollContainerRef }: ChatSearchBarProps) {
  const chatSearchOpen = useUIStore(s => s.chatSearchOpen)
  const setChatSearchOpen = useUIStore(s => s.setChatSearchOpen)

  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<MatchInfo[]>([])
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearHighlights = useCallback(() => {
    CSS.highlights.delete('chat-search')
    CSS.highlights.delete('chat-search-active')
  }, [])

  const highlightActiveMatch = useCallback(
    (index: number, allMatches: MatchInfo[]) => {
      const match = allMatches[index]
      if (!match) return
      const range = rangeFromMatch(match)
      if (!range) return
      CSS.highlights.set('chat-search-active', new Highlight(range))
      scrollRangeIntoView(range)
    },
    []
  )

  const performSearch = useCallback(
    (searchQuery: string) => {
      clearHighlights()

      if (!searchQuery || !scrollContainerRef.current) {
        setMatches([])
        setActiveIndex(0)
        return
      }

      const container = scrollContainerRef.current
      const lowerQuery = searchQuery.toLowerCase()
      const found: MatchInfo[] = []

      const walker = document.createTreeWalker(
        container,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (node.parentElement?.closest('[data-chat-search-bar]')) {
              return NodeFilter.FILTER_REJECT
            }
            return NodeFilter.FILTER_ACCEPT
          },
        }
      )

      let textNode: Text | null
      while ((textNode = walker.nextNode() as Text | null)) {
        const text = textNode.textContent?.toLowerCase() ?? ''
        let startPos = 0
        let idx: number
        while ((idx = text.indexOf(lowerQuery, startPos)) !== -1) {
          found.push({ node: textNode, index: idx, length: searchQuery.length })
          startPos = idx + 1
        }
      }

      setMatches(found)
      setActiveIndex(0)

      if (found.length === 0) return

      const allRanges = found.map(rangeFromMatch).filter((r): r is Range => r !== null)
      if (allRanges.length > 0) {
        CSS.highlights.set('chat-search', new Highlight(...allRanges))
      }
      highlightActiveMatch(0, found)
    },
    [scrollContainerRef, clearHighlights, highlightActiveMatch]
  )

  const navigateToMatch = useCallback(
    (index: number) => {
      if (matches.length === 0) return
      const wrappedIndex =
        ((index % matches.length) + matches.length) % matches.length
      setActiveIndex(wrappedIndex)
      highlightActiveMatch(wrappedIndex, matches)
    },
    [matches, highlightActiveMatch]
  )

  const close = useCallback(() => {
    clearHighlights()
    setQuery('')
    setMatches([])
    setActiveIndex(0)
    setChatSearchOpen(false)
  }, [clearHighlights, setChatSearchOpen])

  // Debounced search
  useEffect(() => {
    if (!chatSearchOpen) return

    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      performSearch(query)
    }, 150)

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [query, chatSearchOpen, performSearch])

  // Focus input when opened
  useEffect(() => {
    if (chatSearchOpen) {
      requestAnimationFrame(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      })
    }
  }, [chatSearchOpen])

  // Listen for toggle event (re-focus or close)
  useEffect(() => {
    const handler = () => {
      if (!chatSearchOpen) return
      if (document.activeElement === inputRef.current) {
        close()
      } else {
        inputRef.current?.focus()
        inputRef.current?.select()
      }
    }
    window.addEventListener('chat-search-toggle', handler)
    return () => window.removeEventListener('chat-search-toggle', handler)
  }, [chatSearchOpen, close])

  // Cleanup on unmount (session switch)
  useEffect(() => {
    return () => {
      clearHighlights()
    }
  }, [clearHighlights])

  if (!chatSearchOpen) return null

  // Escape closes search only when the input is focused (Chrome behavior).
  // Note: Safari closes its find bar on Escape even when unfocused — no consensus.
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation() // Prevent session from also closing
      close()
    } else if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      navigateToMatch(activeIndex - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      navigateToMatch(activeIndex + 1)
    }
  }

  return (
    <div
      data-chat-search-bar
      className="absolute top-2 right-4 z-30 flex items-center gap-1 rounded-md border border-border bg-popover px-2 py-1 shadow-md"
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in chat..."
        className="w-40 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
      />
      {query && (
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {matches.length > 0 ? `${activeIndex + 1}/${matches.length}` : '0/0'}
        </span>
      )}
      <button
        type="button"
        onClick={() => navigateToMatch(activeIndex - 1)}
        disabled={matches.length === 0}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        aria-label="Previous match"
      >
        <ChevronUp className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => navigateToMatch(activeIndex + 1)}
        disabled={matches.length === 0}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
        aria-label="Next match"
      >
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={close}
        className="rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Close search"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
