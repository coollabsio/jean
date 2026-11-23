import { useMemo } from 'react'
import {
  parseServerResourceKey,
  serverResourceKey,
} from '@/lib/server-resource'
import {
  useAgentDetails,
  useProjectCoordinator,
  type AgentDelegation,
} from '@/services/agents'

/** Colors offered for new agents (`jean` is reserved for the boss). */
export const AGENT_COLOR_CHOICES = [
  'blue',
  'green',
  'pink',
  'purple',
  'orange',
  'yellow',
] as const

/** Colors Jean can pick: its crowned default first, then the others. */
export const JEAN_COLOR_CHOICES = ['jean', ...AGENT_COLOR_CHOICES] as const

/** Maps a raw ID through `map`, keeping a remote server's `serverId:` scope. */
function mapScopedId(
  key: string,
  map: (raw: string) => string | null
): string | null {
  const ref = parseServerResourceKey(key)
  const mapped = map(ref?.resourceId ?? key)
  if (!mapped || !ref) return mapped
  return serverResourceKey({ serverId: ref.serverId, resourceId: mapped })
}

/** Coordinator agent of a coordinator chat worktree (`__coord_<pid>__`). */
export function coordinatorAgentIdForWorktree(
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) return null
  return mapScopedId(worktreeId, raw => {
    const match = /^__coord_(.+)__$/.exec(raw)
    return match ? `coord_${match[1]}` : null
  })
}

/** Project of a coordinator agent ID (`coord_<pid>`). */
export function coordinatorProjectId(agentId: string): string | null {
  return mapScopedId(agentId, raw =>
    raw.startsWith('coord_') ? raw.slice('coord_'.length) : null
  )
}

/** Project of a coordinator chat worktree; it has no worktree record. */
export function coordinatorProjectIdForWorktree(
  worktreeId: string | null | undefined
): string | null {
  const agentId = coordinatorAgentIdForWorktree(worktreeId)
  return agentId ? coordinatorProjectId(agentId) : null
}

const OPEN_DELEGATION_STATUSES = new Set(['active', 'waiting'])

export interface CoordinatorDelegations {
  worktreeIds: ReadonlySet<string>
  sessionIds: ReadonlySet<string>
}

const NO_DELEGATIONS: CoordinatorDelegations = {
  worktreeIds: new Set(),
  sessionIds: new Set(),
}

/** Worktrees and sessions the coordinator still waits for. */
export function openDelegations(
  delegations: AgentDelegation[] | undefined
): CoordinatorDelegations {
  const open = (delegations ?? []).filter(d =>
    OPEN_DELEGATION_STATUSES.has(d.status)
  )
  if (open.length === 0) return NO_DELEGATIONS
  return {
    worktreeIds: new Set(open.map(d => d.worktreeId)),
    sessionIds: new Set(open.map(d => d.sessionId)),
  }
}

/** Open delegations of a project's coordinator; empty while `enabled` is off. */
export function useCoordinatorDelegations(
  projectId: string | null,
  enabled: boolean
): CoordinatorDelegations {
  const { data: coordinator } = useProjectCoordinator(projectId, enabled)
  const { data: details } = useAgentDetails(
    enabled ? (coordinator?.agentId ?? null) : null
  )
  const delegations = enabled ? details?.delegations : undefined
  return useMemo(() => openDelegations(delegations), [delegations])
}
