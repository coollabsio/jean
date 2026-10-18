import type { UIState } from '@/types/ui-state'
import type { ServerId } from '@/types/server-resource'
import { parseServerResourceKey, serverResourceKey } from './server-resource'

type ResourceTransform = (id: string) => string

function mapRecordKeys<T>(
  record: Record<string, T> | undefined,
  transform: ResourceTransform
): Record<string, T> | undefined {
  if (!record) return record
  return Object.fromEntries(
    Object.entries(record).map(([id, value]) => [transform(id), value])
  )
}

function mapRecord<T>(
  record: Record<string, T> | undefined,
  keyTransform: ResourceTransform,
  valueTransform: (value: T) => T
): Record<string, T> | undefined {
  if (!record) return record
  return Object.fromEntries(
    Object.entries(record).map(([id, value]) => [
      keyTransform(id),
      valueTransform(value),
    ])
  )
}

function transformUIStateResources(
  state: UIState,
  transform: ResourceTransform
): UIState {
  return {
    ...state,
    active_worktree_id: state.active_worktree_id
      ? transform(state.active_worktree_id)
      : null,
    last_active_worktree_id: state.last_active_worktree_id
      ? transform(state.last_active_worktree_id)
      : null,
    active_project_id: state.active_project_id
      ? transform(state.active_project_id)
      : null,
    active_session_ids:
      mapRecord(state.active_session_ids, transform, transform) ?? {},
    input_drafts: mapRecordKeys(state.input_drafts, transform),
    pending_images: mapRecordKeys(state.pending_images, transform),
    pending_text_files: mapRecordKeys(state.pending_text_files, transform),
    pending_files: mapRecordKeys(state.pending_files, transform),
    pending_skills: mapRecordKeys(state.pending_skills, transform),
    dismissed_setup_scripts: state.dismissed_setup_scripts?.map(transform),
    pinned_recent_session_ids: state.pinned_recent_session_ids?.map(transform),
    last_opened_per_project: mapRecord(
      state.last_opened_per_project,
      transform,
      entry => ({
        worktree_id: transform(entry.worktree_id),
        session_id: transform(entry.session_id),
      })
    ),
  }
}

/** Add the active remote server identity to backend-owned UI-state resources. */
export function scopeUIStateResources(
  state: UIState,
  serverId: ServerId
): UIState {
  return transformUIStateResources(state, id => {
    const parsed = parseServerResourceKey(id)
    return parsed ? id : serverResourceKey({ serverId, resourceId: id })
  })
}

/** Remove this remote server's identity before writing its UI-state file. */
export function unscopeUIStateResources(
  state: UIState,
  serverId: ServerId
): UIState {
  return transformUIStateResources(state, id => {
    const parsed = parseServerResourceKey(id)
    return parsed?.serverId === serverId ? parsed.resourceId : id
  })
}
