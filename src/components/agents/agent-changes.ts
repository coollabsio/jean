import type { AgentChange } from '@/services/agents'

/** Newest change that targeted this agent, or null when it has none. */
export function latestChangeIdForTarget(
  changes: AgentChange[],
  targetId: string
): number | null {
  let latest: number | null = null
  for (const change of changes) {
    if (change.targetAgentId !== targetId) continue
    if (latest === null || change.id > latest) latest = change.id
  }
  return latest
}

/** Activity label for who made a change. The UI actor is "user". */
export function agentChangeActorLabel(actorId: string): string {
  return actorId === 'user' ? 'You' : actorId
}

/** A short before/after line when the stored snapshots have one. */
export function agentChangeDetail(change: AgentChange): string | null {
  const beforeName = change.before?.name
  const afterName = change.after?.name
  if (
    typeof beforeName === 'string' &&
    typeof afterName === 'string' &&
    beforeName !== afterName
  ) {
    return `${beforeName} -> ${afterName}`
  }
  const beforeRole = change.before?.rolePrompt
  const afterRole = change.after?.rolePrompt
  if (
    typeof beforeRole === 'string' &&
    typeof afterRole === 'string' &&
    beforeRole !== afterRole
  ) {
    return 'Instructions changed'
  }
  return null
}
