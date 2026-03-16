import { memo, useCallback, useState } from 'react'
import { toast } from 'sonner'
import {
  gitPush,
  triggerImmediateGitPoll,
  fetchWorktreesStatus,
  performGitPull,
} from '@/services/git-status'
import { useChatStore } from '@/store/chat-store'
import { useRemotePicker } from '@/hooks/useRemotePicker'
import { useAllBackendsMcpHealth } from '@/services/mcp'
import type { ClaudeModel } from '@/types/preferences'
import type { EffortLevel, ThinkingLevel } from '@/types/chat'
import type { ChatToolbarProps } from '@/components/chat/toolbar/types'
import { MobileToolbarMenu } from '@/components/chat/toolbar/MobileToolbarMenu'
import { DesktopToolbarControls } from '@/components/chat/toolbar/DesktopToolbarControls'
import { SendCancelButton } from '@/components/chat/toolbar/SendCancelButton'
import { ContextViewerDialog } from '@/components/chat/toolbar/ContextViewerDialog'
import {
  CODEX_MODEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { useToolbarDropdownShortcuts } from '@/components/chat/toolbar/useToolbarDropdownShortcuts'
import { useToolbarDerivedState } from '@/components/chat/toolbar/useToolbarDerivedState'
import { useContextViewer } from '@/components/chat/toolbar/useContextViewer'
import { formatOpencodeModelLabel } from '@/components/chat/toolbar/toolbar-utils'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'

// eslint-disable-next-line react-refresh/only-export-components
export {
  MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
}
export type { ChatToolbarProps }

export const ChatToolbar = memo(function ChatToolbar({
  isSending,
  hasPendingQuestions,
  hasPendingAttachments,
  hasInputValue,
  executionMode,
  selectedBackend,
  selectedModel,
  selectedProvider,
  selectedThinkingLevel,
  selectedEffortLevel,
  useAdaptiveThinking,
  hideThinkingLevel,
  sessionHasMessages,
  providerLocked,
  baseBranch,
  uncommittedAdded,
  uncommittedRemoved,
  branchDiffAdded,
  branchDiffRemoved,
  prUrl,
  prNumber,
  displayStatus,
  checkStatus,
  mergeableStatus,
  activeWorktreePath,
  worktreeId,
  activeSessionId,
  projectId,
  loadedIssueContexts,
  loadedPRContexts,
  loadedSecurityContexts,
  loadedAdvisoryContexts,
  loadedLinearContexts,
  attachedSavedContexts,
  onOpenMagicModal,
  onSaveContext,
  onLoadContext,
  onCommit,
  onCommitAndPush,
  onOpenPr,
  onReview,
  onMerge,
  onResolvePrConflicts,
  onResolveConflicts,
  hasOpenPr,
  onSetDiffRequest,
  installedBackends,
  onBackendChange,
  onModelChange,
  onProviderChange,
  customCliProfiles,
  onThinkingLevelChange,
  onEffortLevelChange,
  onSetExecutionMode,
  onCancel,
  queuedMessageCount,
  availableMcpServers,
  enabledMcpServers,
  onToggleMcpServer,
  onOpenProjectSettings,
}: ChatToolbarProps) {
  const {
    statuses: mcpStatuses,
    isFetching: isHealthChecking,
    refetchAll: checkHealth,
  } = useAllBackendsMcpHealth(installedBackends)

  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false)
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false)
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false)
  const [mcpDropdownOpen, setMcpDropdownOpen] = useState(false)

  const pickRemoteOrRun = useRemotePicker(activeWorktreePath)

  const handleMcpDropdownOpenChange = useCallback(
    (open: boolean) => {
      setMcpDropdownOpen(open)
      if (open) {
        checkHealth()
      }
    },
    [checkHealth]
  )

  useToolbarDropdownShortcuts({
    setProviderDropdownOpen,
    setModelDropdownOpen,
    setThinkingDropdownOpen,
  })

  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: selectedBackend === 'opencode',
  })
  const opencodeModelOptions =
    availableOpencodeModels?.map(model => ({
      value: model,
      label: formatOpencodeModelLabel(model),
    })) ?? OPENCODE_MODEL_OPTIONS

  const { isCodex, activeMcpCount, filteredModelOptions, selectedModelLabel } =
    useToolbarDerivedState({
      selectedBackend,
      selectedProvider,
      selectedModel,
      opencodeModelOptions,
      customCliProfiles,
      availableMcpServers,
      enabledMcpServers,
    })

  const {
    viewingContext,
    setViewingContext,
    handleViewIssue,
    handleViewPR,
    handleViewSavedContext,
    handleViewSecurityAlert,
    handleViewAdvisory,
    handleViewLinear,
  } = useContextViewer({ activeSessionId, activeWorktreePath, worktreeId, projectId })

  const handleModelChange = useCallback(
    (value: string) => {
      onModelChange(value as ClaudeModel)
    },
    [onModelChange]
  )

  const handleProviderChange = useCallback(
    (value: string) => {
      const provider = value === 'default' ? null : value
      onProviderChange(provider)
      if (
        provider &&
        provider !== '__anthropic__' &&
        (selectedModel === 'opus-4.5' ||
          selectedModel === 'claude-opus-4-6[1m]' ||
          selectedModel === 'claude-sonnet-4-6[1m]')
      ) {
        onModelChange('opus' as ClaudeModel)
      }
    },
    [onProviderChange, onModelChange, selectedModel]
  )

  const handleThinkingLevelChange = useCallback(
    (value: string) => {
      onThinkingLevelChange(value as ThinkingLevel)
    },
    [onThinkingLevelChange]
  )

  const handleEffortLevelChange = useCallback(
    (value: string) => {
      onEffortLevelChange(value as EffortLevel)
    },
    [onEffortLevelChange]
  )

  const handlePullClick = useCallback(async () => {
    if (!activeWorktreePath || !worktreeId) return
    await performGitPull({
      worktreeId,
      worktreePath: activeWorktreePath,
      baseBranch,
      projectId,
      onMergeConflict: onResolveConflicts,
    })
  }, [
    activeWorktreePath,
    baseBranch,
    worktreeId,
    projectId,
    onResolveConflicts,
  ])

  const handlePushClick = useCallback(() => {
    if (!activeWorktreePath || !worktreeId) return
    pickRemoteOrRun(async remote => {
      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()
      setWorktreeLoading(worktreeId, 'push')
      const toastId = toast.loading('Pushing changes...')
      try {
        const result = await gitPush(activeWorktreePath, prNumber, remote)
        triggerImmediateGitPoll()
        if (projectId) fetchWorktreesStatus(projectId)
        if (result.fellBack) {
          toast.warning('Could not push to PR branch, pushed to new branch instead', { id: toastId })
        } else {
          toast.success('Changes pushed', { id: toastId })
        }
      } catch (error) {
        toast.error(`Push failed: ${error}`, { id: toastId })
      } finally {
        clearWorktreeLoading(worktreeId)
      }
    })
  }, [activeWorktreePath, worktreeId, projectId, prNumber, pickRemoteOrRun])

  const handleUncommittedDiffClick = useCallback(() => {
    onSetDiffRequest({
      type: 'uncommitted',
      worktreePath: activeWorktreePath ?? '',
      baseBranch,
    })
  }, [activeWorktreePath, baseBranch, onSetDiffRequest])

  const handleBranchDiffClick = useCallback(() => {
    onSetDiffRequest({
      type: 'branch',
      worktreePath: activeWorktreePath ?? '',
      baseBranch,
    })
  }, [activeWorktreePath, baseBranch, onSetDiffRequest])

  const canSend = hasInputValue || hasPendingAttachments

  return (
    <div className="@container flex justify-start px-4 py-2 md:px-6">
      <div className="inline-flex max-w-full flex-nowrap items-center overflow-hidden whitespace-nowrap rounded-lg bg-muted/50">
        <MobileToolbarMenu
          isDisabled={isSending || hasPendingQuestions}
          hasOpenPr={hasOpenPr}
          sessionHasMessages={sessionHasMessages}
          providerLocked={providerLocked}
          selectedBackend={selectedBackend}
          selectedProvider={selectedProvider}
          selectedModel={selectedModel}
          selectedEffortLevel={selectedEffortLevel}
          selectedThinkingLevel={selectedThinkingLevel}
          hideThinkingLevel={hideThinkingLevel}
          useAdaptiveThinking={useAdaptiveThinking}
          isCodex={isCodex}
          executionMode={executionMode}
          customCliProfiles={customCliProfiles}
          filteredModelOptions={filteredModelOptions}
          uncommittedAdded={uncommittedAdded}
          uncommittedRemoved={uncommittedRemoved}
          branchDiffAdded={branchDiffAdded}
          branchDiffRemoved={branchDiffRemoved}
          prUrl={prUrl}
          prNumber={prNumber}
          displayStatus={displayStatus}
          checkStatus={checkStatus}
          activeWorktreePath={activeWorktreePath}
          onSaveContext={onSaveContext}
          onLoadContext={onLoadContext}
          onCommit={onCommit}
          onCommitAndPush={onCommitAndPush}
          onOpenPr={onOpenPr}
          onReview={onReview}
          onMerge={onMerge}
          onResolveConflicts={onResolveConflicts}
          installedBackends={installedBackends}
          onBackendChange={onBackendChange}
          onSetExecutionMode={onSetExecutionMode}
          handlePullClick={handlePullClick}
          handlePushClick={handlePushClick}
          handleUncommittedDiffClick={handleUncommittedDiffClick}
          handleBranchDiffClick={handleBranchDiffClick}
          handleProviderChange={handleProviderChange}
          handleModelChange={handleModelChange}
          handleEffortLevelChange={handleEffortLevelChange}
          handleThinkingLevelChange={handleThinkingLevelChange}
          availableMcpServers={availableMcpServers}
          enabledMcpServers={enabledMcpServers}
          activeMcpCount={activeMcpCount}
          onToggleMcpServer={onToggleMcpServer}
        />

        <DesktopToolbarControls
          hasPendingQuestions={hasPendingQuestions}
          selectedBackend={selectedBackend}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          selectedThinkingLevel={selectedThinkingLevel}
          selectedEffortLevel={selectedEffortLevel}
          executionMode={executionMode}
          useAdaptiveThinking={useAdaptiveThinking}
          hideThinkingLevel={hideThinkingLevel}
          sessionHasMessages={sessionHasMessages}
          providerLocked={providerLocked}
          customCliProfiles={customCliProfiles}
          filteredModelOptions={filteredModelOptions}
          selectedModelLabel={selectedModelLabel}
          isCodex={isCodex}
          prUrl={prUrl}
          prNumber={prNumber}
          displayStatus={displayStatus}
          checkStatus={checkStatus}
          mergeableStatus={mergeableStatus}
          activeWorktreePath={activeWorktreePath}
          availableMcpServers={availableMcpServers}
          enabledMcpServers={enabledMcpServers}
          activeMcpCount={activeMcpCount}
          isHealthChecking={isHealthChecking}
          mcpStatuses={mcpStatuses}
          loadedIssueContexts={loadedIssueContexts}
          loadedPRContexts={loadedPRContexts}
          loadedSecurityContexts={loadedSecurityContexts}
          loadedAdvisoryContexts={loadedAdvisoryContexts}
          loadedLinearContexts={loadedLinearContexts}
          attachedSavedContexts={attachedSavedContexts}
          providerDropdownOpen={providerDropdownOpen}
          modelDropdownOpen={modelDropdownOpen}
          thinkingDropdownOpen={thinkingDropdownOpen}
          mcpDropdownOpen={mcpDropdownOpen}
          setProviderDropdownOpen={setProviderDropdownOpen}
          setModelDropdownOpen={setModelDropdownOpen}
          setThinkingDropdownOpen={setThinkingDropdownOpen}
          onMcpDropdownOpenChange={handleMcpDropdownOpenChange}
          onOpenMagicModal={onOpenMagicModal}
          onOpenProjectSettings={onOpenProjectSettings}
          onResolvePrConflicts={onResolvePrConflicts}
          onLoadContext={onLoadContext}
          installedBackends={installedBackends}
          onBackendChange={onBackendChange}
          onSetExecutionMode={onSetExecutionMode}
          onToggleMcpServer={onToggleMcpServer}
          handleModelChange={handleModelChange}
          handleProviderChange={handleProviderChange}
          handleThinkingLevelChange={handleThinkingLevelChange}
          handleEffortLevelChange={handleEffortLevelChange}
          handleViewIssue={handleViewIssue}
          handleViewPR={handleViewPR}
          handleViewSecurityAlert={handleViewSecurityAlert}
          handleViewAdvisory={handleViewAdvisory}
          handleViewLinear={handleViewLinear}
          handleViewSavedContext={handleViewSavedContext}
        />

        <div className="h-4 w-px shrink-0 bg-border/50" />

        <div className="shrink-0">
          <SendCancelButton
            isSending={isSending}
            canSend={canSend}
            executionMode={executionMode}
            queuedMessageCount={queuedMessageCount}
            onCancel={onCancel}
          />
        </div>
      </div>

      <ContextViewerDialog
        viewingContext={viewingContext}
        onClose={() => setViewingContext(null)}
      />
    </div>
  )
})
