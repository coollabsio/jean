import { useCallback } from 'react'
import { toast } from 'sonner'
import { reconnectNativeCliSession, useCreateSession } from '@/services/chat'
import { resolveBackendCliPath } from '@/services/cli-binary'
import { useChatStore } from '@/store/chat-store'
import type { Session } from '@/types/chat'
import { buildNativeClientSessionInput } from '../session-card-utils'

/** "Open in Native Client" session action, shared by session menus. */
export function useOpenInNativeClient(
  worktreeId: string,
  worktreePath: string
) {
  const createSession = useCreateSession()

  const openInNativeClient = useCallback(
    (session: Session) => {
      void (async () => {
        // Prefer Jean-managed / resolved absolute path so bare names like
        // `grok` work when the CLI is not on PATH (default jean install).
        const resolvedCommand = await resolveBackendCliPath(session.backend)
        const input = buildNativeClientSessionInput(
          session,
          worktreeId,
          worktreePath,
          { resolvedCommand }
        )
        if (!input) {
          toast.error('No native resume command is available for this session')
          return
        }

        createSession.mutate(input, {
          onSuccess: nativeSession => {
            useChatStore
              .getState()
              .setSelectedBackend(nativeSession.id, input.backend)
            void reconnectNativeCliSession(nativeSession, worktreeId, {
              openModal: false,
              showToast: false,
            }).then(() => toast.success('Opened in native client'))
          },
        })
      })()
    },
    [createSession, worktreeId, worktreePath]
  )

  return { openInNativeClient, isPending: createSession.isPending }
}
