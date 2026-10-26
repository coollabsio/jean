import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronLeft, Plus, Search } from '@/components/icons/reicon'
import { getBackendLabel } from '@/components/ui/backend-label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { StatusIndicator } from '@/components/ui/status-indicator'
import { useCanvasKeyboardNav } from '@/components/chat/hooks/useCanvasKeyboardNav'
import {
  statusConfig,
  type SessionCardData,
} from '@/components/chat/session-card-utils'
import { getLabelTextColor } from '@/lib/label-colors'
import { cn } from '@/lib/utils'
import { getSessionActivityTimestamp } from '@/components/projects/worktree-sort-utils'
import {
  cycleSessionBrowserFilter,
  filterSessionBrowserCards,
  formatSessionBrowserTime,
  getSessionBrowserFilterTabs,
  getSessionBrowserStatusLabels,
  sessionBrowserStatusClass,
  visibleSessionBrowserCards,
} from './worktree-sessions-browser'

interface WorktreeSessionsBrowserProps {
  worktreeName: string
  cards: SessionCardData[]
  isLoading?: boolean
  keyboardEnabled?: boolean
  onBack: () => void
  onOpenSession: (sessionId: string) => void
  onCreateSession: () => void
}

export function WorktreeSessionsBrowser({
  worktreeName,
  cards,
  isLoading = false,
  keyboardEnabled = true,
  onBack,
  onOpenSession,
  onCreateSession,
}: WorktreeSessionsBrowserProps) {
  const [query, setQuery] = useState('')
  const [filterKey, setFilterKey] = useState('all')
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null
  )

  const visibleCards = useMemo(() => visibleSessionBrowserCards(cards), [cards])
  const filterTabs = useMemo(
    () => getSessionBrowserFilterTabs(visibleCards),
    [visibleCards]
  )
  const activeFilterKey = filterTabs.some(tab => tab.key === filterKey)
    ? filterKey
    : 'all'
  const filteredCards = useMemo(
    () => filterSessionBrowserCards(visibleCards, activeFilterKey, query),
    [visibleCards, activeFilterKey, query]
  )

  const selectedIndex = useMemo(() => {
    if (filteredCards.length === 0) return null
    const index = filteredCards.findIndex(
      card => card.session.id === selectedSessionId
    )
    return index === -1 ? 0 : index
  }, [filteredCards, selectedSessionId])

  const handleSelectedIndexChange = useCallback(
    (index: number | null) => {
      if (index === null) {
        setSelectedSessionId(null)
        return
      }
      setSelectedSessionId(filteredCards[index]?.session.id ?? null)
    },
    [filteredCards]
  )

  const handleSelect = useCallback(
    (index: number) => {
      const sessionId = filteredCards[index]?.session.id
      if (sessionId) onOpenSession(sessionId)
    },
    [filteredCards, onOpenSession]
  )

  const cycleFilter = useCallback(
    (direction: -1 | 1) => {
      setFilterKey(current =>
        cycleSessionBrowserFilter(
          filterTabs,
          filterTabs.some(tab => tab.key === current) ? current : 'all',
          direction
        )
      )
    },
    [filterTabs]
  )

  const { cardRefs } = useCanvasKeyboardNav({
    cards: filteredCards,
    selectedIndex,
    onSelectedIndexChange: handleSelectedIndexChange,
    onSelect: handleSelect,
    onNavigateLeft: () => cycleFilter(-1),
    onNavigateRight: () => cycleFilter(1),
    enabled: keyboardEnabled,
  })

  useEffect(() => {
    if (!keyboardEnabled) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      const target = document.activeElement
      if (
        target instanceof HTMLElement &&
        target.closest('[role="dialog"], [role="menu"], [role="listbox"]')
      ) {
        return
      }
      if (target instanceof HTMLInputElement && query) {
        event.preventDefault()
        setQuery('')
        return
      }
      if (target instanceof HTMLElement) target.blur()
      event.preventDefault()
      onBack()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [keyboardEnabled, onBack, query])

  const sessionCountLabel = `${visibleCards.length} ${
    visibleCards.length === 1 ? 'session' : 'sessions'
  }`

  return (
    <div className="flex flex-col" data-testid="worktree-sessions-browser">
      <div className="sticky top-0 z-10 bg-background/60 backdrop-blur-md">
        <div className="flex flex-wrap items-center gap-2 border-b border-border/30 px-4 py-2 sm:min-h-[61px] sm:py-3">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 text-muted-foreground"
            onClick={onBack}
            aria-label="Back to worktrees"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="min-w-0 truncate text-lg font-semibold">
            {worktreeName}
          </h2>
          <span className="text-xs text-muted-foreground">
            {sessionCountLabel}
          </span>
          <div className="ml-auto">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onCreateSession}
            >
              <Plus className="h-3.5 w-3.5" />
              New session
            </Button>
          </div>
        </div>

        <div className="border-b border-border/30 px-4 py-3">
          <div className="relative mx-auto w-full max-w-md">
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder="Search sessions..."
              aria-label="Search sessions"
              name="session-browser-search"
              autoComplete="off"
              className="border-border/30 bg-transparent pl-9"
            />
          </div>
        </div>

        <div className="border-b border-border/30 bg-background/80 px-4 py-2">
          <div
            role="tablist"
            aria-label="Session filters"
            className="flex gap-1 overflow-x-auto"
          >
            {filterTabs.map(tab => {
              const isActive = tab.key === activeFilterKey
              return (
                <button
                  key={tab.key}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
                    isActive
                      ? 'border-primary/30 bg-primary/10 text-primary'
                      : 'border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground'
                  )}
                  onClick={() => setFilterKey(tab.key)}
                >
                  {tab.color && (
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ backgroundColor: tab.color }}
                    />
                  )}
                  <span>{tab.label}</span>
                  <span
                    className={cn(
                      'rounded-md px-1.5 py-0.5 text-[10px] leading-none',
                      isActive
                        ? 'bg-primary/15 text-primary'
                        : 'bg-muted text-muted-foreground'
                    )}
                  >
                    {tab.count}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1 px-4 pt-5 pb-16">
        {isLoading ? (
          <div className="flex h-40 items-center justify-center text-sm text-muted-foreground">
            Loading sessions…
          </div>
        ) : filteredCards.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-3 text-center">
            <p className="text-sm text-muted-foreground">
              {visibleCards.length === 0
                ? 'No sessions yet. Create one to start chatting.'
                : query.trim()
                  ? 'No sessions match your search'
                  : 'No sessions in this filter'}
            </p>
            {visibleCards.length === 0 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onCreateSession}
              >
                <Plus className="h-3.5 w-3.5" />
                New session
              </Button>
            )}
          </div>
        ) : (
          filteredCards.map((card, index) => (
            <SessionBrowserRow
              key={card.session.id}
              card={card}
              isSelected={index === selectedIndex}
              rowRef={element => {
                cardRefs.current[index] = element
              }}
              onSelect={() => onOpenSession(card.session.id)}
            />
          ))
        )}
      </div>
    </div>
  )
}

function SessionBrowserRow({
  card,
  isSelected,
  rowRef,
  onSelect,
}: {
  card: SessionCardData
  isSelected: boolean
  rowRef: (element: HTMLDivElement | null) => void
  onSelect: () => void
}) {
  const config = statusConfig[card.status]
  const { statusLabel, agentStatusLabel } = getSessionBrowserStatusLabels(card)
  const backend = card.session.backend
    ? getBackendLabel(card.session.backend)
    : null
  const lastActivity = formatSessionBrowserTime(
    getSessionActivityTimestamp(card.session)
  )
  const accessibleDetails = [
    statusLabel,
    agentStatusLabel ? `agent ${agentStatusLabel}` : null,
    card.label?.name ?? null,
    backend,
  ]
    .filter(Boolean)
    .join(', ')

  return (
    <div
      ref={rowRef}
      role="button"
      tabIndex={0}
      data-session-id={card.session.id}
      aria-label={`Open ${card.session.name}, ${accessibleDetails}`}
      aria-current={isSelected ? 'true' : undefined}
      onClick={onSelect}
      onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          onSelect()
        }
      }}
      className={cn(
        'group relative mb-1 cursor-pointer rounded-md border border-transparent px-3 py-2 transition-colors',
        'hover:bg-muted/40 focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:outline-none',
        isSelected && 'border-border/40 bg-muted/35'
      )}
    >
      {isSelected && (
        <span className="absolute top-2 bottom-2 left-0 w-0.5 rounded-full bg-primary" />
      )}
      <div className="flex flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <StatusIndicator
            status={config.indicatorStatus}
            shape={config.indicatorShape}
            label={statusLabel}
            className="h-2 w-2 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate font-medium">
            {card.session.name}
          </span>
          {backend && (
            <span className="inline-flex items-center rounded border border-border/50 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
              {backend}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span
            className={cn(
              'rounded px-2 py-0.5',
              sessionBrowserStatusClass(card.status)
            )}
          >
            {statusLabel}
          </span>
          {agentStatusLabel && (
            <span className="rounded bg-muted px-2 py-0.5" title="Agent status">
              Agent · {agentStatusLabel}
            </span>
          )}
          {card.label && (
            <span
              className="rounded px-2 py-0.5 text-[10px] font-medium"
              style={{
                backgroundColor: card.label.color,
                color: getLabelTextColor(card.label.color),
              }}
            >
              {card.label.name}
            </span>
          )}
          {lastActivity && (
            <span className="rounded px-2 py-0.5">{lastActivity}</span>
          )}
          {isSelected && (
            <span className="ml-auto hidden text-[11px] opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 sm:inline-flex">
              Press Enter to open
            </span>
          )}
        </div>
      </div>
    </div>
  )
}
