import { invoke } from '@/lib/transport'
import type { SavedContextsResponse } from '@/types/chat'

export const savedContextsQueryKey = (projectId?: string | null) =>
  ['session-context', projectId ?? 'current'] as const

export function listSavedContexts(projectId?: string | null) {
  return invoke<SavedContextsResponse>('list_saved_contexts', {
    ...(projectId ? { projectId } : {}),
  })
}

export function readSavedContextFile(path: string, projectId?: string | null) {
  return invoke<string>('read_context_file', {
    path,
    ...(projectId ? { projectId } : {}),
  })
}

export function deleteSavedContextFile(
  path: string,
  projectId?: string | null
) {
  return invoke('delete_context_file', {
    path,
    ...(projectId ? { projectId } : {}),
  })
}

export function renameSavedContext(
  filename: string,
  newName: string,
  projectId?: string | null
) {
  return invoke('rename_saved_context', {
    filename,
    newName,
    ...(projectId ? { projectId } : {}),
  })
}
