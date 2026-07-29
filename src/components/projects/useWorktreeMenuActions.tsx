import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import { isBaseSession, type Worktree } from '@/types/projects'
import {
  useArchiveWorktree,
  useCloseBaseSession,
  useDeleteWorktree,
  useOpenWorktreeInFinder,
  useOpenWorktreeInTerminal,
  useOpenWorktreeInEditor,
  useRunScripts,
  useUpdateWorktreeStandby,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { useSessions } from '@/services/chat'
import { useJenkinsStatusCached } from '@/services/jenkins'
import {
  useFinishAiPipelinePr,
  useHasAiPipelineAccess,
} from '@/services/ai-pipeline'
import { useTerminalStore } from '@/store/terminal-store'
import { useUIStore } from '@/store/ui-store'
import { openExternal } from '@/lib/platform'
import { clickUpTaskIdFromBranch, clickupTaskUrl } from '@/lib/clickup'
import { reportSteps } from '@/lib/ai-pipeline-steps'

interface UseWorktreeMenuActionsProps {
  worktree: Worktree
  projectId: string
}

export function useWorktreeMenuActions({
  worktree,
  projectId,
}: UseWorktreeMenuActionsProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [showFinishConfirm, setShowFinishConfirm] = useState(false)
  const [showStandbyDialog, setShowStandbyDialog] = useState(false)
  const archiveWorktree = useArchiveWorktree()
  const closeBaseSession = useCloseBaseSession()
  const deleteWorktree = useDeleteWorktree()
  const openInFinder = useOpenWorktreeInFinder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()
  const updateStandby = useUpdateWorktreeStandby()
  const { data: runScripts = [] } = useRunScripts(worktree.path)
  const { data: preferences } = usePreferences()
  const { data: sessionsData } = useSessions(worktree.id, worktree.path)
  const isBase = isBaseSession(worktree)
  const isStandby = !!worktree.standby_reason && !!worktree.standby_until

  // Quick-open external links (cache-only Jenkins read; ClickUp from branch).
  const { data: jenkins } = useJenkinsStatusCached(worktree.id)
  const prUrl = worktree.pr_url ?? null
  const jenkinsUrl = jenkins?.pipeline?.url ?? null
  const previewUrl = jenkins?.previewUrl ?? null
  const clickUpTaskId = clickUpTaskIdFromBranch(worktree.branch)
  const clickUpUrl = clickUpTaskId ? clickupTaskUrl(clickUpTaskId) : null

  // Finish the feature in one action: ClickUp task → TO DEPLOY + merge the PR.
  // Only meaningful for AI-pipeline projects on a worktree that has a PR.
  const hasAiPipelineAccess = useHasAiPipelineAccess()
  const finish = useFinishAiPipelinePr(projectId)
  const canFinish = !isBase && !!prUrl && hasAiPipelineAccess

  const openPr = useCallback(() => {
    if (prUrl) openExternal(prUrl)
  }, [prUrl])
  const openJenkins = useCallback(() => {
    if (jenkinsUrl) openExternal(jenkinsUrl)
  }, [jenkinsUrl])
  const openPreview = useCallback(() => {
    if (previewUrl) openExternal(previewUrl)
  }, [previewUrl])
  const openClickUp = useCallback(() => {
    if (clickUpUrl) openExternal(clickUpUrl)
  }, [clickUpUrl])

  const hasMessages = sessionsData?.sessions?.some(
    session => session.messages.length > 0
  )

  const handleRun = useCallback(() => {
    const first = runScripts[0]
    if (first) {
      useTerminalStore.getState().startRun(worktree.id, first)
      useUIStore.getState().setSessionChatModalOpen(true, worktree.id)
      useTerminalStore.getState().setModalTerminalOpen(worktree.id, true)
    }
  }, [runScripts, worktree.id])

  const handleRunCommand = useCallback(
    (cmd: string) => {
      useTerminalStore.getState().startRun(worktree.id, cmd)
      useUIStore.getState().setSessionChatModalOpen(true, worktree.id)
      useTerminalStore.getState().setModalTerminalOpen(worktree.id, true)
    },
    [worktree.id]
  )

  const handleOpenTerminalPanel = useCallback(() => {
    useTerminalStore.getState().addTerminal(worktree.id)
  }, [worktree.id])

  const handleOpenInFinder = useCallback(() => {
    openInFinder.mutate(worktree.path)
  }, [openInFinder, worktree.path])

  const handleOpenInTerminal = useCallback(() => {
    openInTerminal.mutate({
      worktreePath: worktree.path,
      terminal: preferences?.terminal,
    })
  }, [openInTerminal, worktree.path, preferences?.terminal])

  const handleOpenInEditor = useCallback(() => {
    openInEditor.mutate({
      worktreePath: worktree.path,
      editor: preferences?.editor,
    })
  }, [openInEditor, worktree.path, preferences?.editor])

  const handleArchiveOrClose = useCallback(() => {
    if (isBase) {
      closeBaseSession.mutate({ worktreeId: worktree.id, projectId })
    } else if (preferences?.removal_behavior === 'delete') {
      deleteWorktree.mutate({ worktreeId: worktree.id, projectId })
    } else {
      archiveWorktree.mutate({ worktreeId: worktree.id, projectId })
    }
  }, [
    isBase,
    closeBaseSession,
    archiveWorktree,
    deleteWorktree,
    worktree.id,
    projectId,
    preferences?.removal_behavior,
  ])

  const handleDelete = useCallback(() => {
    deleteWorktree.mutate({ worktreeId: worktree.id, projectId })
    setShowDeleteConfirm(false)
  }, [deleteWorktree, worktree.id, projectId])

  const handleSetStandby = useCallback(
    (reason: string, standbyUntil: number) => {
      setShowStandbyDialog(false)
      updateStandby.mutate(
        {
          worktreeId: worktree.id,
          projectId,
          reason,
          standbyUntil,
        },
        {
          onSuccess: () => toast.success('Worktree mis en standby métier'),
        }
      )
    },
    [projectId, updateStandby, worktree.id]
  )

  const handleClearStandby = useCallback(() => {
    updateStandby.mutate(
      { worktreeId: worktree.id, projectId },
      {
        onSuccess: () => toast.success('Worktree sorti du standby'),
      }
    )
  }, [projectId, updateStandby, worktree.id])

  const handleFinish = useCallback(() => {
    setShowFinishConfirm(false)
    const toastId = toast.loading('Terminer : ClickUp → TO DEPLOY + merge…')
    finish.mutate(
      { worktreePath: worktree.path, taskId: clickUpTaskId ?? undefined },
      {
        onSuccess: res =>
          reportSteps(toastId, 'PR terminée', [res.clickup, res.merge]),
        onError: e => toast.error(`Échec : ${e}`, { id: toastId }),
      }
    )
  }, [finish, worktree.path, clickUpTaskId])

  return {
    // State
    showDeleteConfirm,
    setShowDeleteConfirm,
    showFinishConfirm,
    setShowFinishConfirm,
    showStandbyDialog,
    setShowStandbyDialog,
    isBase,
    isStandby,
    hasMessages,
    runScripts,
    preferences,

    // Handlers
    handleRun,
    handleRunCommand,
    handleOpenTerminalPanel,
    handleOpenInFinder,
    handleOpenInTerminal,
    handleOpenInEditor,
    handleArchiveOrClose,
    handleDelete,
    handleSetStandby,
    handleClearStandby,
    isUpdatingStandby: updateStandby.isPending,

    // Finish (TO DEPLOY + merge) — gated to AI-pipeline projects with a PR.
    finish: {
      canFinish,
      isPending: finish.isPending,
      handleFinish,
      clickUpTaskId,
    },

    // Quick-open external links (null URL = hide the entry)
    openLinks: {
      prUrl,
      jenkinsUrl,
      previewUrl,
      clickUpUrl,
      openPr,
      openJenkins,
      openPreview,
      openClickUp,
    },
  }
}
