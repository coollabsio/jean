import { useEffect, useState, useCallback, useMemo } from 'react'
import { useUIStore } from '@/store/ui-store'
import { useAllSessions } from '@/services/chat'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import {
  type SessionListItem,
  formatRelativeTime,
  navigateToSession,
} from '@/lib/session-utils'

export function SessionPalette() {
  const sessionPaletteOpen = useUIStore(state => state.sessionPaletteOpen)
  const setSessionPaletteOpen = useUIStore(
    state => state.setSessionPaletteOpen
  )
  const [search, setSearch] = useState('')

  // Lazy-load sessions only when palette is open
  const { data: allSessions } = useAllSessions(sessionPaletteOpen)

  // Flatten, filter archived, sort by updated_at desc
  const flatSessions = useMemo((): SessionListItem[] => {
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

    result.sort((a, b) => b.session.updated_at - a.session.updated_at)
    return result
  }, [allSessions])

  // Group by project for display
  const groupedSessions = useMemo(() => {
    const groups = new Map<string, SessionListItem[]>()
    for (const item of flatSessions) {
      const existing = groups.get(item.projectName)
      if (existing) {
        existing.push(item)
      } else {
        groups.set(item.projectName, [item])
      }
    }
    return groups
  }, [flatSessions])

  const handleSelect = useCallback(
    (item: SessionListItem) => {
      setSessionPaletteOpen(false)
      setSearch('')
      navigateToSession(item)
    },
    [setSessionPaletteOpen]
  )

  const handleOpenChange = useCallback(
    (open: boolean) => {
      setSessionPaletteOpen(open)
      if (!open) setSearch('')
    },
    [setSessionPaletteOpen]
  )

  // Cmd+P keybinding (with !shiftKey guard to avoid conflict with Cmd+Shift+P)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'p' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
        e.preventDefault()
        setSessionPaletteOpen(!sessionPaletteOpen)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [sessionPaletteOpen, setSessionPaletteOpen])

  return (
    <CommandDialog
      open={sessionPaletteOpen}
      onOpenChange={handleOpenChange}
      title="Go to Session"
      description="Search sessions across all projects"
      className="top-4 translate-y-0 sm:top-[50%] sm:translate-y-[-50%] sm:max-w-2xl"
      disablePointerSelection
    >
      <CommandInput
        placeholder="Search sessions..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-[800px]">
        <CommandEmpty>No sessions found.</CommandEmpty>

        {Array.from(groupedSessions.entries()).map(
          ([projectName, sessions]) => (
            <CommandGroup key={projectName} heading={projectName}>
              {sessions.map(item => (
                <CommandItem
                  key={`${item.worktreeId}-${item.session.id}`}
                  value={`${item.session.name} ${item.worktreeName} ${item.projectName}`}
                  onSelect={() => handleSelect(item)}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <span className="truncate">{item.session.name}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {item.worktreeName}
                    </span>
                  </div>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {formatRelativeTime(item.session.updated_at)}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          )
        )}
      </CommandList>
    </CommandDialog>
  )
}
