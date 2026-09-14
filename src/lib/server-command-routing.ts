import { parseServerResourceKey, serverResourceKey } from './server-resource'
import type { ServerId } from '@/types/server-resource'

const ROUTED_ARGUMENT_KEYS = new Set([
  'projectId',
  'project_id',
  'worktreeId',
  'worktree_id',
  'sessionId',
  'session_id',
  'terminalId',
  'terminal_id',
  'sourceProjectId',
  'source_project_id',
  'targetProjectId',
  'target_project_id',
  'itemId',
  'item_id',
  'newParentId',
  'new_parent_id',
  'parentId',
  'parent_id',
  'activeSessionId',
  'active_session_id',
])

const PATH_ARGUMENT_KEYS = new Set([
  'projectPath',
  'project_path',
  'worktreePath',
  'worktree_path',
  'repoPath',
  'repo_path',
])
const pathOwners = new Map<string, Set<ServerId>>()

export function registerServerResourcePath(
  serverId: ServerId,
  path: unknown
): void {
  if (typeof path !== 'string' || !path) return
  const owners = pathOwners.get(path) ?? new Set<ServerId>()
  owners.add(serverId)
  pathOwners.set(path, owners)
}

export function clearServerResourcePaths(): void {
  pathOwners.clear()
}

export interface ResolvedServerCommand {
  serverId: ServerId
  args: Record<string, unknown>
}

export function resolveServerCommand(
  args?: Record<string, unknown>
): ResolvedServerCommand | null {
  if (!args) return null
  let serverId: ServerId | null = null

  const strip = (value: unknown, key?: string): unknown => {
    if (typeof value === 'string' && key && ROUTED_ARGUMENT_KEYS.has(key)) {
      const reference = parseServerResourceKey(value)
      if (!reference) return value
      if (serverId && serverId !== reference.serverId) {
        throw new Error(
          'One command cannot use resources from several Jean servers'
        )
      }
      serverId = reference.serverId
      return reference.resourceId
    }
    if (typeof value === 'string' && key && PATH_ARGUMENT_KEYS.has(key)) {
      const owners = pathOwners.get(value)
      if (!owners || owners.size === 0) return value
      if (serverId) {
        if (!owners.has(serverId)) {
          throw new Error('The resource path belongs to another Jean server')
        }
        return value
      }
      if (owners.size > 1) {
        throw new Error('The resource path is ambiguous across Jean servers')
      }
      serverId = [...owners][0] ?? null
      return value
    }
    if (Array.isArray(value)) return value.map(item => strip(item, key))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [
          childKey,
          strip(child, childKey),
        ])
      )
    }
    return value
  }

  const stripped = strip(args) as Record<string, unknown>
  return serverId ? { serverId, args: stripped } : null
}

function scopedId(serverId: ServerId, resourceId: unknown): unknown {
  return typeof resourceId === 'string' && resourceId
    ? serverResourceKey({ serverId, resourceId })
    : resourceId
}

const EVENT_RESOURCE_KEYS = new Set([
  ...ROUTED_ARGUMENT_KEYS,
  'archived_worktree_id',
  'parent_session_id',
])

/** Add server ownership before a backend event enters shared client state. */
export function decorateServerEvent<T>(serverId: ServerId, value: T): T {
  const decorate = (current: unknown, key?: string): unknown => {
    if (typeof current === 'string' && key && EVENT_RESOURCE_KEYS.has(key)) {
      return scopedId(serverId, current)
    }
    if (Array.isArray(current)) return current.map(item => decorate(item, key))
    if (current && typeof current === 'object') {
      return Object.fromEntries(
        Object.entries(current).map(([childKey, child]) => [
          childKey,
          decorate(child, childKey),
        ])
      )
    }
    return current
  }
  return decorate(value) as T
}

function decorateSession(serverId: ServerId, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const session = value as Record<string, unknown>
  return {
    ...session,
    id: scopedId(serverId, session.id),
    ...(session.worktree_id
      ? { worktree_id: scopedId(serverId, session.worktree_id) }
      : {}),
    ...(session.parent_session_id
      ? { parent_session_id: scopedId(serverId, session.parent_session_id) }
      : {}),
    serverId,
    resourceId: session.id,
  }
}

function decorateWorktree(serverId: ServerId, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const worktree = value as Record<string, unknown>
  registerServerResourcePath(serverId, worktree.path)
  return {
    ...worktree,
    id: scopedId(serverId, worktree.id),
    project_id: scopedId(serverId, worktree.project_id),
    serverId,
    resourceId: worktree.id,
  }
}

function decorateProject(serverId: ServerId, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const project = value as Record<string, unknown>
  registerServerResourcePath(serverId, project.path)
  return {
    ...project,
    id: scopedId(serverId, project.id),
    ...(project.parent_id
      ? { parent_id: scopedId(serverId, project.parent_id) }
      : {}),
    ...(Array.isArray(project.linked_project_ids)
      ? {
          linked_project_ids: project.linked_project_ids.map(id =>
            scopedId(serverId, id)
          ),
        }
      : {}),
    serverId,
    resourceId: project.id,
  }
}

function decorateWorktreeSessions(serverId: ServerId, value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const group = value as Record<string, unknown>
  return {
    ...group,
    ...(group.worktree_id
      ? { worktree_id: scopedId(serverId, group.worktree_id) }
      : {}),
    ...(group.active_session_id
      ? { active_session_id: scopedId(serverId, group.active_session_id) }
      : {}),
    sessions: Array.isArray(group.sessions)
      ? group.sessions.map(session => decorateSession(serverId, session))
      : group.sessions,
  }
}

export function decorateServerResult<T>(
  serverId: ServerId,
  command: string,
  value: T
): T {
  if (command === 'list_projects' && Array.isArray(value)) {
    return value.map(item => decorateProject(serverId, item)) as T
  }
  if (command === 'list_worktrees' && Array.isArray(value)) {
    return value.map(item => decorateWorktree(serverId, item)) as T
  }
  if (
    [
      'get_worktree',
      'create_worktree',
      'rename_worktree',
      'unarchive_worktree',
      'create_base_session',
    ].includes(command)
  ) {
    return decorateWorktree(serverId, value) as T
  }
  if (command === 'list_archived_worktrees' && Array.isArray(value)) {
    return value.map(item => decorateWorktree(serverId, item)) as T
  }
  if (
    ['get_session', 'create_session', 'unarchive_session'].includes(command)
  ) {
    return decorateSession(serverId, value) as T
  }
  if (command === 'list_archived_sessions' && Array.isArray(value)) {
    return value.map(item => decorateSession(serverId, item)) as T
  }
  if (command === 'list_all_sessions' && value && typeof value === 'object') {
    const response = value as Record<string, unknown>
    return {
      ...response,
      entries: Array.isArray(response.entries)
        ? response.entries.map(entry => {
            if (!entry || typeof entry !== 'object') return entry
            const record = entry as Record<string, unknown>
            return {
              ...record,
              project_id: scopedId(serverId, record.project_id),
              worktree_id: scopedId(serverId, record.worktree_id),
              sessions: Array.isArray(record.sessions)
                ? record.sessions.map(session =>
                    decorateSession(serverId, session)
                  )
                : record.sessions,
            }
          })
        : response.entries,
    } as T
  }
  if (
    [
      'add_project',
      'clone_project',
      'init_project',
      'update_project_settings',
    ].includes(command)
  ) {
    return decorateProject(serverId, value) as T
  }
  if (command === 'get_sessions') {
    return decorateWorktreeSessions(serverId, value) as T
  }
  if (command === 'bootstrap_project' && value && typeof value === 'object') {
    const bootstrap = value as Record<string, unknown>
    const sessions = bootstrap.sessionsByWorktree as
      | Record<string, unknown>
      | undefined
    const sessionsByWorktree = sessions
      ? Object.fromEntries(
          Object.entries(sessions).map(([worktreeId, group]) => [
            scopedId(serverId, worktreeId),
            decorateWorktreeSessions(serverId, group),
          ])
        )
      : sessions
    return {
      ...bootstrap,
      worktrees: Array.isArray(bootstrap.worktrees)
        ? bootstrap.worktrees.map(worktree =>
            decorateWorktree(serverId, worktree)
          )
        : bootstrap.worktrees,
      sessionsByWorktree,
    } as T
  }
  return value
}
