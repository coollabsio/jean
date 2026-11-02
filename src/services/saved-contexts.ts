import { invoke, invokeForOptionalServer } from '@/lib/transport'
import type { SavedContextsResponse } from '@/types/chat'

export const savedContextsQueryKey = (projectId?: string | null) =>
  ['session-context', projectId ?? 'current'] as const

export function listSavedContexts(projectId?: string | null) {
  return invoke<SavedContextsResponse>('list_saved_contexts', {
    ...(projectId ? { projectId } : {}),
  })
}

// Without a project these follow `listSavedContexts` onto the active transport.
export function readSavedContextFile(path: string, projectId?: string | null) {
  return invokeForOptionalServer<string>(undefined, 'read_context_file', {
    path,
    ...(projectId ? { projectId } : {}),
  })
}

export function deleteSavedContextFile(
  path: string,
  projectId?: string | null
) {
  return invokeForOptionalServer(undefined, 'delete_context_file', {
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
