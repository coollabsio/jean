import type { AllSessionsEntry } from '@/types/chat'

interface FilterLoadContextSessionsOptions {
  searchQuery: string
  activeSessionId: string | null
  attachedSlugs: ReadonlySet<string>
  contentMatchIds?: ReadonlySet<string>
}

export function filterLoadContextSessions(
  entries: AllSessionsEntry[],
  {
    searchQuery,
    activeSessionId,
    attachedSlugs,
    contentMatchIds = new Set(),
  }: FilterLoadContextSessionsOptions
): AllSessionsEntry[] {
  const query = searchQuery.trim().toLowerCase()

  return entries.flatMap(entry => {
    const sessions = entry.sessions.filter(session => {
      if (!session.message_count) return false
      if (session.id === activeSessionId) return false
      if (attachedSlugs.has(`session-ref-${session.id}`)) return false
      if (!query) return true

      return (
        session.name.toLowerCase().includes(query) ||
        entry.project_name.toLowerCase().includes(query) ||
        entry.worktree_name.toLowerCase().includes(query) ||
        contentMatchIds.has(session.id)
      )
    })

    return sessions.length > 0 ? [{ ...entry, sessions }] : []
  })
}
