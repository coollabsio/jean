import { useEffect } from 'react'
import { listen, invoke, type UnlistenFn } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useNightshiftStore } from '@/store/nightshift-store'
import { nightshiftQueryKeys } from '@/services/nightshift'
import type {
  RunStartedPayload,
  CheckStartedPayload,
  CheckDonePayload,
  RunCompletedPayload,
  RunFailedPayload,
  ExecuteCheckPayload,
} from '@/types/nightshift'
import type { ChatMessage } from '@/types/chat'

/**
 * Listens to nightshift:* events from the Rust backend
 * and orchestrates session execution for each check.
 *
 * Flow:
 * 1. Backend emits `nightshift:execute-check` with session + prompt info
 * 2. Frontend calls `send_chat_message` to start the session (build mode)
 * 3. When the session completes, frontend reports back via `nightshift_report_check_done`
 * 4. Backend moves to the next check or finalizes the run
 */
export function useNightshiftEvents() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const listeners: Promise<UnlistenFn>[] = []

    listeners.push(
      listen<RunStartedPayload>('nightshift:run-started', (event) => {
        const { runId, projectId } = event.payload
        useNightshiftStore.getState().setActiveRun(projectId, runId)
        toast.loading('Nightshift run started...', { id: `nightshift-${runId}` })
      })
    )

    listeners.push(
      listen<CheckStartedPayload>('nightshift:check-started', (event) => {
        const { runId, checkId, checkName } = event.payload
        useNightshiftStore.getState().setRunningCheck(runId, checkId)
        toast.loading(`Running: ${checkName}...`, {
          id: `nightshift-${runId}`,
        })
      })
    )

    // Core orchestration: execute a check by sending a message in the session
    listeners.push(
      listen<ExecuteCheckPayload>('nightshift:execute-check', async (event) => {
        const {
          runId,
          checkId,
          sessionId,
          worktreeId,
          worktreePath,
          prompt,
          model,
          provider,
          backend,
        } = event.payload

        try {
          await invoke<ChatMessage>('send_chat_message', {
            sessionId,
            worktreeId,
            worktreePath,
            message: prompt,
            model: model ?? null,
            executionMode: 'yolo',
            thinkingLevel: null,
            effortLevel: null,
            parallelExecutionPrompt: null,
            aiLanguage: null,
            allowedTools: null,
            mcpConfig: null,
            chromeEnabled: null,
            customProfileName: provider ?? null,
            backend: backend ?? null,
          })

          // Session completed successfully — report back to engine
          await invoke('nightshift_report_check_done', {
            runId,
            checkId,
            sessionId,
            success: true,
            error: null,
          })
        } catch (error) {
          // Session failed — report error to engine
          await invoke('nightshift_report_check_done', {
            runId,
            checkId,
            sessionId,
            success: false,
            error: String(error),
          })
        }
      })
    )

    listeners.push(
      listen<CheckDonePayload>('nightshift:check-done', (event) => {
        const { runId } = event.payload
        useNightshiftStore.getState().clearRunningCheck(runId)
      })
    )

    listeners.push(
      listen<RunCompletedPayload>('nightshift:run-completed', (event) => {
        const { runId, projectId, status, totalChecks } = event.payload
        useNightshiftStore.getState().clearActiveRun(projectId)
        useNightshiftStore.getState().clearRunningCheck(runId)

        // Refresh run history + sessions (new sessions were created)
        queryClient.invalidateQueries({
          queryKey: nightshiftQueryKeys.runs(projectId),
        })

        if (status === 'completed') {
          toast.success(
            `Nightshift completed ${totalChecks} check${totalChecks === 1 ? '' : 's'}`,
            {
              id: `nightshift-${runId}`,
              action: {
                label: 'View',
                onClick: () => {
                  useNightshiftStore.getState().openRunsModal(projectId)
                },
              },
            }
          )
        } else if (status === 'partially_completed') {
          toast.warning('Nightshift: some checks failed', {
            id: `nightshift-${runId}`,
            action: {
              label: 'View',
              onClick: () => {
                useNightshiftStore.getState().openRunsModal(projectId)
              },
            },
          })
        } else if (status === 'failed') {
          toast.error('Nightshift run failed', {
            id: `nightshift-${runId}`,
          })
        }
      })
    )

    listeners.push(
      listen<RunFailedPayload>('nightshift:run-failed', (event) => {
        const { runId, projectId, error } = event.payload
        useNightshiftStore.getState().clearActiveRun(projectId)
        useNightshiftStore.getState().clearRunningCheck(runId)

        toast.error(`Nightshift failed: ${error}`, {
          id: `nightshift-${runId}`,
        })
      })
    )

    return () => {
      listeners.forEach((l) => l.then((unlisten) => unlisten()))
    }
  }, [queryClient])
}
