import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { CheckCircle2, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { useAllSessions } from '@/services/chat'
import { useUIStore } from '@/store/ui-store'
import {
  type SessionListItem,
  formatRelativeTime,
  getSessionStatus,
  navigateToSession,
} from '@/lib/session-utils'

export function SessionHistoryModal() {
  const open = useUIStore(state => state.sessionHistoryOpen)
  const setOpen = useUIStore(state => state.setSessionHistoryOpen)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  const { data: allSessions, isLoading } = useAllSessions(open)

  // Flat list of all non-archived sessions, sorted by updated_at desc
  const items = useMemo((): SessionListItem[] => {
    if (!allSessions?.entries) return []
    const result: SessionListItem[] = []
    for (const entry of allSessions.entries) {
      for (const session of entry.sessions) {
        if (session.archived_at) continue
        result.push({
          session,
          projectId: entry.project_id,
          projectName: entry.project_name,
          worktreeId: entry.worktree_id,
          worktreeName: entry.worktree_name,
          worktreePath: entry.worktree_path,
        })
      }
    }
    return result.sort((a, b) => b.session.updated_at - a.session.updated_at)
  }, [allSessions])

  // Reset focus when items change or modal opens
  useEffect(() => {
    if (open) setFocusedIndex(0)
  }, [open])

  const handleSelect = useCallback(
    (item: SessionListItem) => {
      setOpen(false)
      navigateToSession(item)
    },
    [setOpen]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const total = items.length
      if (!total) return

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setFocusedIndex(i => Math.min(i + 1, total - 1))
          break
        case 'ArrowUp':
          e.preventDefault()
          setFocusedIndex(i => Math.max(i - 1, 0))
          break
        case 'Enter':
          e.preventDefault()
          if (focusedIndex >= 0 && items[focusedIndex]) {
            handleSelect(items[focusedIndex])
          }
          break
      }
    },
    [items, focusedIndex, handleSelect]
  )

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return
    document
      .querySelector(`[data-history-index="${focusedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [focusedIndex])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="max-w-2xl max-h-[80vh] flex flex-col gap-0 p-0"
        onKeyDown={handleKeyDown}
      >
        <DialogHeader className="px-4 py-3 border-b">
          <DialogTitle className="text-sm font-medium">
            Session History
          </DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No sessions yet
          </div>
        ) : (
          <div
            ref={listRef}
            className="overflow-y-auto flex-1 p-1"
          >
            {items.map((item, idx) => {
              const status = getSessionStatus(item.session)
              const StatusIcon = status?.icon ?? CheckCircle2

              return (
                <button
                  key={item.session.id}
                  type="button"
                  data-history-index={idx}
                  onClick={() => handleSelect(item)}
                  onMouseEnter={() => setFocusedIndex(idx)}
                  className={cn(
                    'w-full text-left px-3 py-2 rounded-md hover:bg-accent/50 transition-colors cursor-pointer flex items-start gap-2',
                    focusedIndex === idx && 'bg-accent'
                  )}
                >
                  <StatusIcon
                    className={cn(
                      'h-3.5 w-3.5 shrink-0 mt-0.5',
                      status?.className ?? 'text-muted-foreground'
                    )}
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/50 shrink-0">
                        {item.projectName}
                      </span>
                      <span className="text-[11px] text-muted-foreground/30 shrink-0">
                        {item.worktreeName}
                      </span>
                      <span className="text-[11px] text-muted-foreground/40 shrink-0 ml-auto">
                        {formatRelativeTime(item.session.updated_at)}
                      </span>
                    </div>
                    <span className="text-[13px] truncate block">
                      {item.session.name}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
