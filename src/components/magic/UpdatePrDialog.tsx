import { useCallback, useEffect, useState } from 'react'
import { invoke } from '@/lib/transport'
import {
  AlertCircle,
  ArrowRight,
  ExternalLink,
  GitPullRequest,
  Loader2,
} from 'lucide-react'
import { toast } from 'sonner'
import { openExternal } from '@/lib/platform'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { useProjects, useWorktrees } from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { useCreateSession, useSendMessage } from '@/services/chat'
import { buildReleaseNotesSessionPrompt } from '@/lib/release-notes-prompt'
import { resolveMcpConfigForSend } from '@/services/mcp'
import { usePreferences } from '@/services/preferences'
import type { CliBackend } from '@/types/preferences'

interface DetectPrResponse {
  pr_number: number
  pr_url: string
  title: string
}

export function UpdatePrDialog() {
  const { updatePrModalOpen, setUpdatePrModalOpen } = useUIStore()
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)

  const { data: worktrees } = useWorktrees(selectedProjectId)
  const selectedWorktreeId = useProjectsStore(state => state.selectedWorktreeId)
  const worktree = worktrees?.find(w => w.id === selectedWorktreeId) ?? null

  const linkedPrNumber = worktree?.pr_number ?? null
  const linkedPrUrl = worktree?.pr_url ?? null
  const worktreePath = worktree?.path

  const createSession = useCreateSession()
  const sendMessage = useSendMessage()
  const { data: preferences } = usePreferences()
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null

  const [branchPr, setBranchPr] = useState<DetectPrResponse | null>(null)
  const [isDetectingBranchPr, setIsDetectingBranchPr] = useState(false)
  const [prNumberInput, setPrNumberInput] = useState('')
  const [isLaunching, setIsLaunching] = useState(false)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    if (!updatePrModalOpen) return

    setPrNumberInput(linkedPrNumber ? String(linkedPrNumber) : '')
    setIsLaunching(false)
    setIsDetectingBranchPr(false)
    setErrorMessage(null)
  }, [updatePrModalOpen, linkedPrNumber])

  useEffect(() => {
    if (!updatePrModalOpen || !worktreePath) return

    let cancelled = false
    setIsDetectingBranchPr(true)

    invoke<DetectPrResponse | null>('detect_open_pr_for_branch', {
      worktreePath,
    })
      .then(result => {
        if (!cancelled) {
          setBranchPr(result)
          setIsDetectingBranchPr(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBranchPr(null)
          setIsDetectingBranchPr(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [updatePrModalOpen, worktreePath])

  const handleOpenChange = useCallback(
    (open: boolean) => {
      if (!open) {
        setPrNumberInput('')
        setIsLaunching(false)
        setIsDetectingBranchPr(false)
        setErrorMessage(null)
      }
      setUpdatePrModalOpen(open)
    },
    [setUpdatePrModalOpen]
  )

  // Spawn a fresh yolo chat session seeded with the release-notes instruction so
  // the agent generates user-facing notes and updates the PR description via gh.
  const launchSessionForPr = useCallback(
    async (prNumberValue: number) => {
      const parsedPrNumber = Number(prNumberValue)
      if (!Number.isInteger(parsedPrNumber) || parsedPrNumber <= 0) {
        setErrorMessage('Enter a valid pull request number.')
        return
      }
      if (!selectedWorktreeId || !worktreePath) {
        setErrorMessage('No worktree selected.')
        return
      }

      setErrorMessage(null)
      setIsLaunching(true)

      try {
        const worktreeId = selectedWorktreeId
        const baseSessionId =
          useChatStore.getState().activeSessionIds[worktreeId]

        const session = await createSession.mutateAsync({
          worktreeId,
          worktreePath,
          name: `Update PR #${parsedPrNumber}`,
        })

        // Inherit the worktree's current session settings (backend/model/provider)
        // then force yolo so the gh PR edit runs without approval prompts.
        const { copySessionSettings, setExecutionMode, setActiveSession } =
          useChatStore.getState()
        if (baseSessionId) {
          copySessionSettings(baseSessionId, session.id)
        }
        setExecutionMode(session.id, 'yolo')

        // Re-read state AFTER the mutations above (the earlier snapshot is stale).
        const store = useChatStore.getState()
        const backend =
          store.selectedBackends[session.id] ?? session.backend ?? undefined
        const model =
          store.selectedModels[session.id] ??
          session.selected_model ??
          undefined
        const provider =
          store.selectedProviders[session.id] ??
          session.selected_provider ??
          undefined

        setActiveSession(worktreeId, session.id)

        const resolvedBackend = (backend ?? 'claude') as CliBackend
        const { mcpConfig, enabledServers } = await resolveMcpConfigForSend({
          worktreePath,
          backend: resolvedBackend,
          projectEnabled: project?.enabled_mcp_servers,
          globalEnabled: preferences?.default_enabled_mcp_servers,
          knownServers:
            project?.known_mcp_servers ?? preferences?.known_mcp_servers,
        })
        store.setEnabledMcpServers(session.id, enabledServers)
        invoke('update_session_state', {
          worktreeId,
          worktreePath,
          sessionId: session.id,
          enabledMcpServers: enabledServers,
        }).catch(() => undefined)

        // Open the session and close this modal immediately — the send below is
        // fire-and-forget (send_chat_message only resolves once the run finishes).
        window.dispatchEvent(
          new CustomEvent('open-session-modal', {
            detail: { sessionId: session.id, worktreeId, worktreePath },
          })
        )
        setUpdatePrModalOpen(false)

        sendMessage.mutate({
          sessionId: session.id,
          worktreeId,
          worktreePath,
          message: buildReleaseNotesSessionPrompt(parsedPrNumber),
          executionMode: 'yolo',
          backend,
          model,
          customProfileName: provider,
          mcpConfig,
        })
      } catch (error) {
        setErrorMessage(String(error))
        toast.error(`Failed to start PR update session: ${error}`)
        setIsLaunching(false)
      }
    },
    [
      selectedWorktreeId,
      worktreePath,
      createSession,
      sendMessage,
      setUpdatePrModalOpen,
      project?.enabled_mcp_servers,
      project?.known_mcp_servers,
      preferences?.default_enabled_mcp_servers,
      preferences?.known_mcp_servers,
    ]
  )

  const launchFromInput = useCallback(() => {
    void launchSessionForPr(Number(prNumberInput.trim()))
  }, [prNumberInput, launchSessionForPr])

  return (
    <Dialog open={updatePrModalOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="!max-w-md w-[min(92vw,28rem)] p-0 flex flex-col">
        <DialogHeader className="px-4 pt-5 pb-0">
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequest className="h-4 w-4" />
            Update PR description
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 px-4 pb-4 pt-2 flex flex-col gap-4">
          <div className="space-y-2">
            <label
              htmlFor="update-pr-number"
              className="text-xs font-medium text-muted-foreground block"
            >
              Pull request number
            </label>
            <Input
              id="update-pr-number"
              value={prNumberInput}
              onChange={e => {
                setPrNumberInput(e.target.value.replace(/[^\d]/g, ''))
                if (errorMessage) setErrorMessage(null)
              }}
              placeholder="e.g. 9521"
              className="text-base md:text-sm"
              disabled={isLaunching}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  launchFromInput()
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              Jean starts a yolo session that generates user-facing release
              notes for this PR and updates its description automatically.
            </p>
          </div>

          {errorMessage && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <div className="font-medium">Could not start session</div>
                <div className="text-destructive/90">{errorMessage}</div>
              </div>
            </div>
          )}

          {isDetectingBranchPr && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Checking for open PR on this branch...
            </div>
          )}

          {(linkedPrNumber || branchPr) && (
            <div className="flex flex-wrap items-center gap-2">
              {linkedPrNumber && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={isLaunching}
                  onClick={() => {
                    setPrNumberInput(String(linkedPrNumber))
                    void launchSessionForPr(linkedPrNumber)
                  }}
                >
                  Use linked PR #{linkedPrNumber}
                </Button>
              )}
              {linkedPrUrl && linkedPrNumber && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => openExternal(linkedPrUrl)}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                  Open linked PR
                </Button>
              )}
              {branchPr && branchPr.pr_number !== linkedPrNumber && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isLaunching}
                    onClick={() => {
                      setPrNumberInput(String(branchPr.pr_number))
                      void launchSessionForPr(branchPr.pr_number)
                    }}
                  >
                    Use open branch PR #{branchPr.pr_number}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => openExternal(branchPr.pr_url)}
                  >
                    <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                    Open branch PR
                  </Button>
                </>
              )}
            </div>
          )}

          <div className="mt-auto flex justify-end">
            <Button
              onClick={launchFromInput}
              disabled={!prNumberInput.trim() || isLaunching}
            >
              {isLaunching ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <ArrowRight className="h-3.5 w-3.5 mr-1.5" />
              )}
              {isLaunching ? 'Starting...' : 'Generate & update'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
