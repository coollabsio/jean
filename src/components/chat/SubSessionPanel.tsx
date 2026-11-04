import { memo, useCallback, useMemo, useState } from 'react'
import { ChevronLeft, ChevronRight, GitFork } from '@/components/icons/reicon'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  StatusIndicator,
  WorkingWaveform,
} from '@/components/ui/status-indicator'
import { useVisibilityAwareTicker } from '@/hooks/useVisibilityAwareTicker'
import { formatRelative } from '@/lib/relative-time'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import { useSubSessionStore } from '@/store/sub-session-store'
import type { Session } from '@/types/chat'
import { formatAgentElapsed } from './AgentWidget'
import { COMPOSER_SURFACE_CLASS } from './composer-surface'
import { useCanvasStoreState } from './hooks/useCanvasStoreState'
import {
  createSessionCardDataCache,
  statusConfig,
  type SessionCardData,
} from './session-card-utils'

interface SubSessionsProps {
  leadId: string
  /** Sessions of the lead's worktree; sub-sessions elsewhere are not shown */
  sessions: readonly Session[]
  worktreeId: string
  className?: string
}

function directSubSessions(
  sessions: readonly Session[],
  leadId: string
): Session[] {
  return sessions.filter(
    session =>
      session.id !== leadId &&
      session.delegated_by?.origin_session_id === leadId &&
      !session.archived_at
  )
}

/** Live status for each sub-session, the same derivation the tab bar uses. */
function useSubSessionCards(subSessions: Session[]): SessionCardData[] {
  const storeState = useCanvasStoreState()
  const cache = useMemo(() => createSessionCardDataCache(), [])
  return useMemo(
    () => subSessions.map(session => cache(session, storeState)),
    [cache, storeState, subSessions]
  )
}

/** Sub-sessions share the lead's worktree, so opening one is a tab switch. */
function useOpenSubSession(worktreeId: string) {
  return useCallback(
    (sessionId: string) =>
      useChatStore.getState().setActiveSession(worktreeId, sessionId),
    [worktreeId]
  )
}

function isLive(card: SessionCardData): boolean {
  return statusConfig[card.status].indicatorStatus === 'running'
}

/** Ticks on its own so the per-second update stays inside this leaf. */
function LiveElapsed({ startedAt }: { startedAt: number | undefined }) {
  const [now, setNow] = useState(() => Date.now())
  const tick = useCallback(() => setNow(Date.now()), [])
  useVisibilityAwareTicker(startedAt !== undefined, tick)
  if (startedAt === undefined) return null
  return <>{formatAgentElapsed(now - startedAt * 1000)}</>
}

const SubSessionRow = memo(function SubSessionRow({
  card,
  onOpen,
}: {
  card: SessionCardData
  onOpen: (sessionId: string) => void
}) {
  const { session } = card
  const config = statusConfig[card.status]
  const live = isLive(card)
  const outcome = session.delegated_by?.outcome ?? null
  // A running sub-session's outcome is from its previous run
  const preview = live ? '' : (outcome?.body ?? '')
  return (
    <button
      type="button"
      onClick={() => onOpen(session.id)}
      data-testid="sub-session-card"
      className="w-full min-w-0 rounded-md border border-border/40 bg-muted/20 px-2.5 py-2 text-left text-xs transition-colors hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      <span className="flex min-w-0 items-center gap-2">
        <StatusIndicator
          status={config.indicatorStatus}
          shape={config.indicatorShape}
          label={config.label}
          className="h-2 w-2"
        />
        <span className="truncate font-medium text-foreground">
          {session.name}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
          {live ? (
            <LiveElapsed startedAt={session.last_run_started_at} />
          ) : (
            formatRelative(outcome?.ended_at ?? session.updated_at)
          )}
        </span>
      </span>
      {preview && (
        <span className="mt-1 line-clamp-2 break-words text-muted-foreground">
          {preview}
        </span>
      )}
    </button>
  )
})

/**
 * The lead's sub-sessions as a column of small cards docked beside the
 * messages, foldable to a rail of status dots. Nothing when the session has
 * no sub-sessions.
 */
export function SubSessionPanel(props: SubSessionsProps) {
  const subSessions = useMemo(
    () => directSubSessions(props.sessions, props.leadId),
    [props.sessions, props.leadId]
  )
  if (subSessions.length === 0) return null
  return <SubSessionPanelBody {...props} subSessions={subSessions} />
}

function SubSessionPanelBody({
  leadId,
  subSessions,
  worktreeId,
  className,
}: SubSessionsProps & { subSessions: Session[] }) {
  const cards = useSubSessionCards(subSessions)
  const rail = useSubSessionStore(state =>
    state.railPanelSessionIds.has(leadId)
  )
  const toggleRail = useCallback(
    () => useSubSessionStore.getState().togglePanelRail(leadId),
    [leadId]
  )
  const open = useOpenSubSession(worktreeId)

  if (rail) {
    return (
      <aside
        aria-label="Sub-sessions"
        className={cn(
          'w-8 shrink-0 flex-col items-center gap-2 border-l border-border/30 py-2',
          className
        )}
      >
        <button
          type="button"
          aria-label="Expand sub-session panel"
          onClick={toggleRail}
          className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-3.5" />
        </button>
        {cards.map(card => {
          const config = statusConfig[card.status]
          return (
            <button
              key={card.session.id}
              type="button"
              aria-label={`${card.session.name}: ${config.label}`}
              title={card.session.name}
              onClick={() => open(card.session.id)}
              className="flex size-5 items-center justify-center rounded transition-colors hover:bg-muted"
            >
              <StatusIndicator
                status={config.indicatorStatus}
                shape={config.indicatorShape}
                className="h-2 w-2"
              />
            </button>
          )
        })}
      </aside>
    )
  }

  return (
    <aside
      aria-label="Sub-sessions"
      className={cn(
        'w-60 shrink-0 flex-col gap-1.5 overflow-y-auto border-l border-border/30 px-2 py-2',
        className
      )}
    >
      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        <span className="font-medium">Sub-sessions</span>
        <button
          type="button"
          aria-label="Collapse sub-session panel"
          onClick={toggleRail}
          className="rounded p-0.5 transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronRight className="size-3.5" />
        </button>
      </div>
      <ul className="flex flex-col gap-1.5">
        {cards.map(card => (
          <li key={card.session.id}>
            <SubSessionRow card={card} onOpen={open} />
          </li>
        ))}
      </ul>
    </aside>
  )
}

/**
 * The same sub-sessions as a one-line strip above the composer, for chat
 * areas too narrow for the docked panel. Expands to the same cards.
 */
export function SubSessionStrip(props: SubSessionsProps) {
  const subSessions = useMemo(
    () => directSubSessions(props.sessions, props.leadId),
    [props.sessions, props.leadId]
  )
  if (subSessions.length === 0) return null
  return <SubSessionStripBody {...props} subSessions={subSessions} />
}

function SubSessionStripBody({
  leadId,
  subSessions,
  worktreeId,
  className,
}: SubSessionsProps & { subSessions: Session[] }) {
  const cards = useSubSessionCards(subSessions)
  const isOpen = useSubSessionStore(state =>
    state.openStripSessionIds.has(leadId)
  )
  const toggleOpen = useCallback(
    () => useSubSessionStore.getState().toggleStripOpen(leadId),
    [leadId]
  )
  const open = useOpenSubSession(worktreeId)
  const runningCount = cards.filter(isLive).length

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={toggleOpen}
      className={className}
      data-testid="sub-session-strip"
    >
      <div
        className={cn('overflow-hidden sm:rounded-lg', COMPOSER_SURFACE_CLASS)}
      >
        <CollapsibleTrigger className="flex w-full min-w-0 cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground select-none hover:bg-muted/50">
          <GitFork className="size-4 shrink-0" />
          <span className="font-medium">Sub-sessions</span>
          {!isOpen && runningCount > 0 && <WorkingWaveform />}
          <span className="tabular-nums">
            {runningCount > 0 ? `${runningCount} running` : cards.length}
          </span>
          <ChevronRight
            className={cn(
              'ml-auto size-3.5 shrink-0 transition-transform',
              isOpen && 'rotate-90'
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="flex max-h-[40vh] flex-col gap-1.5 overflow-y-auto px-2 pb-2">
            {cards.map(card => (
              <li key={card.session.id}>
                <SubSessionRow card={card} onOpen={open} />
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
