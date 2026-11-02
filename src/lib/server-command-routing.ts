import { parseServerResourceKey, serverResourceKey } from './server-resource'
import { LOCAL_SERVER_ID, type ServerId } from '@/types/server-resource'

export const ROUTED_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
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
  'folderId',
  'folder_id',
  'itemIds',
  'item_ids',
  'newParentId',
  'new_parent_id',
  'parentId',
  'parent_id',
  'activeSessionId',
  'active_session_id',
  'sourceSessionId',
  'source_session_id',
  'targetSessionId',
  'target_session_id',
  'sourceWorktreeId',
  'source_worktree_id',
  // Agents: each Jean server has its own agents
  'agentId',
  'agent_id',
])

export const PATH_ARGUMENT_KEYS: ReadonlySet<string> = new Set([
  'projectPath',
  'project_path',
  'worktreePath',
  'worktree_path',
  'repoPath',
  'repo_path',
])
// These values are persisted client data. Resource-shaped fields inside them
// can refer to several servers and are not command routing targets.
const OPAQUE_ARGUMENT_KEYS = new Set(['uiState'])
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

export interface ResolveServerCommandOptions {
  /**
   * Server that already owns unscoped resource ids. `invokeForServer` strips
   * scopes before the backend sees them, so a raw id in that call belongs to
   * the supplied server. Ordinary `invoke` leaves this unset; a raw id then
   * means the local server when the command also carries a repository path.
   */
  explicitServerId?: ServerId
}

/**
 * Scoped ids name their server directly. Raw ids are not resolved here: they
 * belong to an explicit server, or to the local server when the command also
 * carries a repository path. An id with no path stays unscoped so a selected
 * remote connection can still own that command.
 */
function scopedServerId(value: string): ServerId | null {
  if (!value) return null
  return parseServerResourceKey(value)?.serverId ?? null
}

/**
 * Paths are applied only after every id has been collected, so property order
 * cannot let a shared path reject a known owner. A unique path can still name
 * the server when the command has no id.
 */
function resolvePathOwner(
  serverId: ServerId | null,
  paths: readonly string[]
): ServerId | null {
  const ownerSets: Set<ServerId>[] = []
  for (const path of paths) {
    const owners = pathOwners.get(path)
    if (owners && owners.size > 0) ownerSets.push(owners)
  }

  if (serverId) {
    for (const owners of ownerSets) {
      if (!owners.has(serverId)) {
        throw new Error('The resource path belongs to another Jean server')
      }
    }
    return serverId
  }

  let uniqueOwner: ServerId | null = null
  let sawAmbiguous = false
  for (const owners of ownerSets) {
    if (owners.size !== 1) {
      sawAmbiguous = true
      continue
    }
    const owner = [...owners][0]
    if (!owner) continue
    if (uniqueOwner && uniqueOwner !== owner) {
      throw new Error('The resource path belongs to another Jean server')
    }
    uniqueOwner = owner
  }

  if (uniqueOwner) {
    for (const owners of ownerSets) {
      if (!owners.has(uniqueOwner)) {
        throw new Error('The resource path belongs to another Jean server')
      }
    }
    return uniqueOwner
  }

  if (sawAmbiguous) {
    throw new Error('The resource path is ambiguous across Jean servers')
  }
  return null
}

export function resolveServerCommand(
  args?: Record<string, unknown>,
  options?: ResolveServerCommandOptions
): ResolvedServerCommand | null {
  if (!args) return null
  const explicitServerId = options?.explicitServerId
  let serverId: ServerId | null = null
  let sawRawId = false
  const paths: string[] = []

  const claim = (owner: ServerId) => {
    if (serverId && serverId !== owner) {
      throw new Error(
        'One command cannot use resources from several Jean servers'
      )
    }
    serverId = owner
  }

  const strip = (value: unknown, key?: string): unknown => {
    if (key && OPAQUE_ARGUMENT_KEYS.has(key)) return value
    if (typeof value === 'string' && key && ROUTED_ARGUMENT_KEYS.has(key)) {
      const owner = scopedServerId(value)
      if (owner) claim(owner)
      else if (value) sawRawId = true
      return parseServerResourceKey(value)?.resourceId ?? value
    }
    if (typeof value === 'string' && key && PATH_ARGUMENT_KEYS.has(key)) {
      if (value) paths.push(value)
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
  if (sawRawId) {
    const rawOwner =
      explicitServerId ?? (paths.length > 0 ? LOCAL_SERVER_ID : null)
    if (rawOwner) claim(rawOwner)
  }
  const resolved = resolvePathOwner(serverId, paths)
  return resolved ? { serverId: resolved, args: stripped } : null
}

/**
 * Commands whose arguments do not name their owner by themselves. The generic
 * key scan in `resolveServerCommand` routes every other command.
 *
 * - `owner`: the command addresses a path or job id that only its owning
 *   server knows. Callers must also send one of these id keys (the backend
 *   ignores it), or use `invokeForServer` / `invokeForOptionalServer`.
 * - `fanOut`: the array argument can hold resources of several servers. Each
 *   owning server receives its own items.
 *
 * `server-command-routing.test.ts` fails when a dispatch command reads an
 * owner-looking key that neither the key scan nor this table covers.
 */
export const COMMAND_OWNERS: Record<
  string,
  { owner: readonly string[] } | { fanOut: string }
> = {
  read_file_content: { owner: ['sessionId', 'worktreeId', 'projectId'] },
  read_file_base64: { owner: ['sessionId', 'worktreeId', 'projectId'] },
  write_file_content: { owner: ['sessionId', 'worktreeId', 'projectId'] },
  read_plan_file: { owner: ['sessionId', 'worktreeId'] },
  read_pasted_text: { owner: ['sessionId'] },
  update_pasted_text: { owner: ['sessionId'] },
  delete_pasted_text: { owner: ['sessionId'] },
  save_pasted_text: { owner: ['sessionId', 'terminalId'] },
  save_pasted_image: { owner: ['sessionId', 'terminalId'] },
  delete_pasted_image: { owner: ['sessionId'] },
  save_dropped_image: { owner: ['sessionId'] },
  read_context_file: { owner: ['sessionId', 'worktreeId', 'projectId'] },
  delete_context_file: { owner: ['sessionId', 'worktreeId', 'projectId'] },
  browse_directory: { owner: [] },
  get_recent_worktrees: { owner: [] },
  get_commit_job: { owner: ['worktreeId', 'worktreePath'] },
  get_review_job: { owner: ['worktreeId', 'worktreePath'] },
  cancel_review_job: { owner: ['worktreeId', 'worktreePath'] },
  cancel_review_with_ai: { owner: ['worktreeId', 'worktreePath'] },
  decide_agent_approval: { owner: ['agentId'] },
  install_agent_template: { owner: ['agentId'] },
  revert_agent_change: { owner: ['agentId'] },
  reorder_projects: { fanOut: 'projectIds' },
  set_sessions_last_opened_bulk: { fanOut: 'sessionIds' },
  set_all_worktrees_for_polling: { fanOut: 'worktrees' },
  set_pr_worktrees_for_polling: { fanOut: 'worktrees' },
}

/** One backend call. `serverId: null` means the active transport. */
export interface ServerCommandRoute {
  serverId: ServerId | null
  args: Record<string, unknown> | undefined
}

/** Owner of one fan-out item and the item as that owner stores it. */
function fanOutItem(item: unknown): [ServerId | null, unknown] {
  if (typeof item === 'string') {
    const ref = parseServerResourceKey(item)
    return ref ? [ref.serverId, ref.resourceId] : [null, item]
  }
  if (item && typeof item === 'object') {
    const routed = resolveServerCommand(item as Record<string, unknown>)
    return routed ? [routed.serverId, routed.args] : [null, item]
  }
  return [null, item]
}

/**
 * Route a command by its `COMMAND_OWNERS` entry and its arguments. Returns one
 * route, or one per owning server for a mixed fan-out batch.
 * `ownerDeclared` means the caller already chose the server explicitly.
 */
export function routeServerCommand(
  command: string,
  args: Record<string, unknown> | undefined,
  ownerDeclared = false
): ServerCommandRoute[] {
  const spec = COMMAND_OWNERS[command]
  if (spec && 'owner' in spec && !ownerDeclared) {
    const hasOwner = spec.owner.some(key => {
      const value = args?.[key]
      return typeof value === 'string' && value.length > 0
    })
    if (!hasOwner) {
      const fix = spec.owner.length
        ? `Send ${spec.owner.join(' or ')} with it, or call invokeForServer`
        : 'Call invokeForServer or invokeForOptionalServer'
      throw new Error(
        `${command} cannot tell which Jean server owns its arguments. ${fix}.`
      )
    }
  }

  if (spec && 'fanOut' in spec && Array.isArray(args?.[spec.fanOut])) {
    const groups = new Map<ServerId | null, unknown[]>()
    for (const item of args[spec.fanOut] as unknown[]) {
      const [owner, raw] = fanOutItem(item)
      groups.set(owner, [...(groups.get(owner) ?? []), raw])
    }
    if (groups.size > 1 || (groups.size === 1 && !groups.has(null))) {
      return [...groups].map(([serverId, items]) => ({
        serverId,
        args: { ...args, [spec.fanOut]: items },
      }))
    }
  }

  const routed = args ? resolveServerCommand(args) : null
  return [routed ?? { serverId: null, args }]
}

/** Reduce scoped ids to the raw ids their owning server stores and matches. */
export function stripServerScope(
  serverId: ServerId,
  args?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!args) return args
  try {
    const routed = resolveServerCommand(args, { explicitServerId: serverId })
    return routed?.serverId === serverId ? routed.args : args
  } catch {
    // Mixed or ambiguous ownership: send the arguments exactly as they arrived.
    return args
  }
}

function scopedId(serverId: ServerId, resourceId: unknown): unknown {
  return typeof resourceId === 'string' && resourceId
    ? serverResourceKey({ serverId, resourceId })
    : resourceId
}

const EVENT_RESOURCE_KEYS = new Set([
  ...ROUTED_ARGUMENT_KEYS,
  'parent_session_id',
])

/** Add server ownership before a backend event enters shared client state. */
export function decorateServerEvent<T>(
  serverId: ServerId,
  value: T,
  event?: string
): T {
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
  if (
    event?.startsWith('worktree:') &&
    value &&
    typeof value === 'object' &&
    'worktree' in value
  ) {
    const { worktree, ...payload } = value as Record<string, unknown>
    return {
      ...(decorate(payload) as Record<string, unknown>),
      worktree: decorateWorktree(serverId, worktree),
    } as T
  }

  const decorated = decorate(value)
  if (
    !event?.startsWith('worktree:') ||
    !decorated ||
    typeof decorated !== 'object'
  ) {
    return decorated as T
  }

  const payload = decorated as Record<string, unknown>
  registerServerResourcePath(serverId, payload.path)
  return {
    ...payload,
    id: scopedId(serverId, payload.id),
  } as T
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
      'create_worktree_from_existing_branch',
      'checkout_pr',
      'import_worktree',
      'rename_worktree',
      'create_base_session',
    ].includes(command)
  ) {
    return decorateWorktree(serverId, value) as T
  }
  if (
    command === 'fork_session_to_worktree' &&
    value &&
    typeof value === 'object'
  ) {
    const result = value as Record<string, unknown>
    return {
      ...result,
      worktree: decorateWorktree(serverId, result.worktree),
      session: decorateSession(serverId, result.session),
    } as T
  }
  if (['get_session', 'create_session'].includes(command)) {
    return decorateSession(serverId, value) as T
  }
  // Returns the next active session id (or null) as a bare string.
  if (command === 'close_session') {
    return scopedId(serverId, value) as T
  }
  if (
    command === 'start_background_investigation' &&
    value &&
    typeof value === 'object'
  ) {
    const result = value as Record<string, unknown>
    return {
      ...result,
      sessionId: scopedId(serverId, result.sessionId),
      worktreeId: scopedId(serverId, result.worktreeId),
    } as T
  }
  if (
    (command === 'list_all_sessions' || command === 'list_unread_sessions') &&
    value &&
    typeof value === 'object'
  ) {
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
      'create_folder',
      'save_server_project',
      'setup_server_user',
      'rename_folder',
      'move_item',
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
      runningSessions: Array.isArray(bootstrap.runningSessions)
        ? bootstrap.runningSessions.map(sessionId =>
            scopedId(serverId, sessionId)
          )
        : bootstrap.runningSessions,
      worktrees: Array.isArray(bootstrap.worktrees)
        ? bootstrap.worktrees.map(worktree =>
            decorateWorktree(serverId, worktree)
          )
        : bootstrap.worktrees,
      sessionsByWorktree,
    } as T
  }
  if (
    command === 'get_recent_worktrees' &&
    value &&
    typeof value === 'object'
  ) {
    const response = value as Record<string, unknown>
    return {
      ...response,
      items: Array.isArray(response.items)
        ? response.items.map(item => {
            const row = item as Record<string, unknown>
            return {
              ...row,
              projectId: scopedId(serverId, row.projectId),
              worktree: decorateWorktree(serverId, row.worktree),
              session: decorateSession(serverId, row.session),
            }
          })
        : response.items,
      failedWorktreeIds: Array.isArray(response.failedWorktreeIds)
        ? response.failedWorktreeIds.map(id => scopedId(serverId, id))
        : response.failedWorktreeIds,
    } as T
  }
  return value
}
