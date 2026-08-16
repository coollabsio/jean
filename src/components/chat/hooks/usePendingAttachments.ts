import { useCallback, type RefObject } from 'react'
import { generateId } from '@/lib/uuid'
import { persistEnqueue } from '@/services/chat'
import { useChatStore } from '@/store/chat-store'
import { buildMcpConfigJson } from '@/services/mcp'
import { getFilename } from '@/lib/path-utils'
import type { CliBackend } from '@/types/preferences'
import type {
  QueuedMessage,
  ClaudeCommand,
  ExecutionMode,
  ThinkingLevel,
  EffortLevel,
  McpServerInfo,
} from '@/types/chat'

interface UsePendingAttachmentsParams {
  activeSessionId: string | null | undefined
  activeWorktreeId: string | null | undefined
  activeWorktreePath: string | null | undefined
  selectedModelRef: RefObject<string>
  selectedProviderRef: RefObject<string | null>
  executionModeRef: RefObject<ExecutionMode>
  selectedThinkingLevelRef: RefObject<ThinkingLevel>
  selectedEffortLevelRef: RefObject<EffortLevel>
  useAdaptiveThinkingRef: RefObject<boolean>
  isCodexBackendRef: RefObject<boolean>
  mcpServersDataRef: RefObject<McpServerInfo[] | undefined>
  enabledMcpServersRef: RefObject<string[]>
  selectedBackendRef: RefObject<CliBackend>
  setInputDraft: (sessionId: string, draft: string) => void
  sendMessageNow: (queuedMsg: QueuedMessage) => void
}

/**
 * Handlers for removing pending attachments and executing slash commands.
 */
export function usePendingAttachments({
  activeSessionId,
  activeWorktreeId,
  activeWorktreePath,
  selectedModelRef,
  selectedProviderRef,
  executionModeRef,
  selectedThinkingLevelRef,
  selectedEffortLevelRef,
  useAdaptiveThinkingRef,
  isCodexBackendRef,
  mcpServersDataRef,
  enabledMcpServersRef,
  selectedBackendRef,
  setInputDraft,
  sendMessageNow,
}: UsePendingAttachmentsParams) {
  const handleRemovePendingImage = useCallback(
    (imageId: string) => {
      if (!activeSessionId) return
      useChatStore.getState().removePendingImage(activeSessionId, imageId)
    },
    [activeSessionId]
  )

  const handleRemovePendingTextFile = useCallback(
    (textFileId: string) => {
      if (!activeSessionId) return
      useChatStore.getState().removePendingTextFile(activeSessionId, textFileId)
    },
    [activeSessionId]
  )

  const handleRemovePendingSkill = useCallback(
    (skillId: string) => {
      if (!activeSessionId) return
      useChatStore.getState().removePendingSkill(activeSessionId, skillId)
    },
    [activeSessionId]
  )

  const handleRemovePendingFile = useCallback(
    (fileId: string) => {
      if (!activeSessionId) return
      const { removePendingFile, getPendingFiles, inputDrafts } =
        useChatStore.getState()

      const files = getPendingFiles(activeSessionId)
      const file = files.find(f => f.id === fileId)
      if (file && !file.attached) {
        const filename = getFilename(file.relativePath)
        const currentInput = inputDrafts[activeSessionId] ?? ''
        const pattern = new RegExp(
          `@${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\s|$)`,
          'g'
        )
        const newInput = currentInput
          .replace(pattern, '')
          .replace(/\s+/g, ' ')
          .trim()
        setInputDraft(activeSessionId, newInput)
      }

      removePendingFile(activeSessionId, fileId)
    },
    [activeSessionId, setInputDraft]
  )

  const handleCommandExecute = useCallback(
    (command: ClaudeCommand) => {
      if (!activeSessionId || !activeWorktreeId || !activeWorktreePath) return

      const queuedMessage: QueuedMessage = {
        id: generateId(),
        message: `Run the /${command.name} command from ${command.path}`,
        pendingImages: [],
        pendingFiles: [],
        pendingSkills: [],
        pendingTextFiles: [],
        model: selectedModelRef.current,
        provider: selectedProviderRef.current,
        executionMode: executionModeRef.current,
        thinkingLevel: selectedThinkingLevelRef.current,
        effortLevel:
          useAdaptiveThinkingRef.current ||
          isCodexBackendRef.current ||
          selectedBackendRef.current === 'pi'
            ? selectedEffortLevelRef.current
            : undefined,
        mcpConfig: buildMcpConfigJson(
          mcpServersDataRef.current ?? [],
          enabledMcpServersRef.current,
          selectedBackendRef.current
        ),
        queuedAt: Date.now(),
      }

      const { isSending: checkIsSendingNow, enqueueMessage } =
        useChatStore.getState()
      if (checkIsSendingNow(activeSessionId)) {
        enqueueMessage(activeSessionId, queuedMessage)
        if (activeWorktreeId && activeWorktreePath) {
          persistEnqueue(
            activeWorktreeId,
            activeWorktreePath,
            activeSessionId,
            queuedMessage
          )
        }
      } else {
        sendMessageNow(queuedMessage)
      }
    },
    [activeSessionId, activeWorktreeId, activeWorktreePath, sendMessageNow]
  )

  return {
    handleRemovePendingImage,
    handleRemovePendingTextFile,
    handleRemovePendingSkill,
    handleRemovePendingFile,
    handleCommandExecute,
  }
}
