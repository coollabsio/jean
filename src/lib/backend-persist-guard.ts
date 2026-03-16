/**
 * Guards against useImmediateSessionStateSave racing with backend completion state writes.
 *
 * When chat:done fires, the backend persists completion state (waitingForInput, isReviewing)
 * authoritatively. The frontend updates Zustand in-memory, which triggers
 * useImmediateSessionStateSave to also write to disk — creating a race.
 *
 * This guard prevents the frontend's immediate-save from writing completion state
 * while the backend write is in flight.
 */
const pendingSessions = new Set<string>()

export function markBackendPersisting(sessionId: string) {
  pendingSessions.add(sessionId)
}

export function clearBackendPersisting(sessionId: string) {
  pendingSessions.delete(sessionId)
}

export function isBackendPersisting(sessionId: string) {
  return pendingSessions.has(sessionId)
}
