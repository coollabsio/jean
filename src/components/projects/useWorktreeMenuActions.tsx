import { useState, useCallback } from 'react'
import { invoke } from '@/lib/transport'
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
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { useSessions } from '@/services/chat'
import { useProjectsStore } from '@/store/projects-store'
import { useTerminalStore } from '@/store/terminal-store'
import { useChatStore } from '@/store/chat-store'
import { useUIStore } from '@/store/ui-store'
import type { SessionDigest } from '@/types/chat'

interface UseWorktreeMenuActionsProps {
  worktree: Worktree
  projectId: string
}

export function useWorktreeMenuActions({
  worktree,
  projectId,
}: UseWorktreeMenuActionsProps) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const archiveWorktree = useArchiveWorktree()
  const closeBaseSession = useCloseBaseSession()
  const deleteWorktree = useDeleteWorktree()
  const openInFinder = useOpenWorktreeInFinder()
  const openInTerminal = useOpenWorktreeInTerminal()
  const openInEditor = useOpenWorktreeInEditor()
  const { data: runScripts = [] } = useRunScripts(worktree.path)
  const { data: preferences } = usePreferences()
  const { data: sessionsData } = useSessions(worktree.id, worktree.path)
  const isBase = isBaseSession(worktree)

  // Check if any session has at least one message (for recap generation)
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

  const handleOpenJeanConfig = useCallback(() => {
    useProjectsStore.getState().openProjectSettings(projectId, 'jean-json')
  }, [projectId])

  const handleGenerateRecap = useCallback(async () => {
    const sessions = sessionsData?.sessions ?? []
    const sessionWithMessages = sessions.find(s => s.messages.length >= 2)

    if (!sessionWithMessages) {
      toast.error('No session with enough messages for recap')
      return
    }

    const toastId = toast.loading('Generating recap...')

    try {
      const digest = await invoke<SessionDigest>('generate_session_digest', {
        sessionId: sessionWithMessages.id,
      })

      useChatStore.getState().markSessionNeedsDigest(sessionWithMessages.id)
      useChatStore.getState().setSessionDigest(sessionWithMessages.id, digest)

      invoke('update_session_digest', {
        sessionId: sessionWithMessages.id,
        digest,
      }).catch(err => {
        console.error('[useWorktreeMenuActions] Failed to persist digest:', err)
      })

      toast.success(
        <div className="space-y-1">
          <div className="font-medium">{digest.chat_summary}</div>
          <div className="text-xs text-muted-foreground">
            {digest.last_action}
          </div>
        </div>,
        { id: toastId, duration: 8000 }
      )
    } catch (error) {
      toast.error(`Failed to generate recap: ${error}`, { id: toastId })
    }
  }, [sessionsData?.sessions])

  return {
    // State
    showDeleteConfirm,
    setShowDeleteConfirm,
    isBase,
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
    handleOpenJeanConfig,
    handleGenerateRecap,
  }
}
