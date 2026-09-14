interface SessionIdentity {
  id: string
  order: number
  created_at: number
}

export function isFirstWorktreeSession(
  activeSessionId: string | null | undefined,
  sessions: SessionIdentity[] | undefined
): boolean {
  if (!activeSessionId || !sessions?.length) return false

  const firstSession = sessions.reduce((first, session) => {
    if (session.order !== first.order) {
      return session.order < first.order ? session : first
    }
    return session.created_at < first.created_at ? session : first
  })

  return firstSession.id === activeSessionId
}
