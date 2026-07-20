import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Zap } from 'lucide-react'
import { dismissibleToast } from '@/lib/dismissible-toast'
import { invoke } from '@/lib/transport'
import { useUIStore } from '@/store/ui-store'
import {
  gitPush,
  triggerImmediateGitPoll,
  fetchWorktreesStatus,
  performGitPull,
} from '@/services/git-status'
import { useChatStore } from '@/store/chat-store'
import { pushNeedsRemotePicker, useRemotePicker } from '@/hooks/useRemotePicker'
import { useAllBackendsMcpHealth } from '@/services/mcp'
import { getModelFastInfo, type ClaudeModel } from '@/types/preferences'
import {
  getSupportedExecutionModes,
  type EffortLevel,
  type ThinkingLevel,
} from '@/types/chat'
import type { ChatToolbarProps } from '@/components/chat/toolbar/types'
import { MobileToolbarMenu } from '@/components/chat/toolbar/MobileToolbarMenu'
import { MobileSettingsMenu } from '@/components/chat/toolbar/MobileSettingsMenu'
import { MobileBackendModelPickerSheet } from '@/components/chat/toolbar/MobileBackendModelPickerSheet'
import { DesktopToolbarControls } from '@/components/chat/toolbar/DesktopToolbarControls'
import { DockBurgerButton } from '@/components/chat/toolbar/DockBurgerButton'
import { ExecutionModeDropdown } from '@/components/chat/toolbar/ExecutionModeDropdown'
import { SendCancelButton } from '@/components/chat/toolbar/SendCancelButton'
import { ContextViewerDialog } from '@/components/chat/toolbar/ContextViewerDialog'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  CODEX_MODEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
  MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
  PI_MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { useToolbarDropdownShortcuts } from '@/components/chat/toolbar/useToolbarDropdownShortcuts'
import { useToolbarDerivedState } from '@/components/chat/toolbar/useToolbarDerivedState'
import { useContextViewer } from '@/components/chat/toolbar/useContextViewer'
import {
  formatOpencodeModelLabel,
  formatPiModelLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { useAvailablePiModels } from '@/services/pi-cli'
import { useIsMobile } from '@/hooks/use-mobile'
import {
  BackendLabel,
  getBackendPlainLabel,
} from '@/components/ui/backend-label'
import type { RevertCommitResponse } from '@/types/projects'

// eslint-disable-next-line react-refresh/only-export-components
export {
  MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  THINKING_LEVEL_OPTIONS,
  EFFORT_LEVEL_OPTIONS,
  PI_EFFORT_LEVEL_OPTIONS,
}
export type { ChatToolbarProps }

/** Tracks concurrent ChatToolbar mounts (remount races during session switch). */
let chatToolbarMountCount = 0

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
  prUrl,
  prNumber,
  displayStatus,
  checkStatus,
  mergeableStatus,
  activeWorktreePath,
  worktreeId,
  activeSessionId,
  projectId,
  runScripts,
  packageScripts,
  favoritePackageScripts,
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
  onMergePr,
  onResolvePrConflicts,
  onResolveConflicts,
  hasOpenPr,
  installedBackends,
  onModelChange,
  onBackendModelChange,
  onProviderChange,
  customCliProfiles,
  onThinkingLevelChange,
  onEffortLevelChange,
  onSetExecutionMode,
  onAttach,
  onCancel,
  queuedMessageCount,
  availableMcpServers,
  enabledMcpServers,
  onToggleMcpServer,
  onOpenProjectSettings,
  onRunCommand,
  onRunPackageScript,
  onToggleFavoritePackageScript,
}: ChatToolbarProps) {
  const {
    statuses: mcpStatuses,
    isFetching: isHealthChecking,
    refetchAll: checkHealth,
  } = useAllBackendsMcpHealth(installedBackends, activeWorktreePath)

  const [providerDropdownOpen, setProviderDropdownOpen] = useState(false)
  const [thinkingDropdownOpen, setThinkingDropdownOpen] = useState(false)
  const [mcpDropdownOpen, setMcpDropdownOpen] = useState(false)
  const [mobileBackendModelPickerOpen, setMobileBackendModelPickerOpen] =
    useState(false)
  const isMobile = useIsMobile()
  const [revertConfirmOpen, setRevertConfirmOpen] = useState(false)

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
    setThinkingDropdownOpen,
  })

  // Signal to FloatingDock that its burger counterpart now lives in this toolbar.
  // Use a process-wide mount count so React remount races (session key change)
  // cannot leave chatToolbarMounted=false while a newer toolbar is mounted —
  // that would show FloatingDock over a blank-looking chat on mobile/web.
  useEffect(() => {
    chatToolbarMountCount += 1
    useUIStore.getState().setChatToolbarMounted(true)
    return () => {
      chatToolbarMountCount = Math.max(0, chatToolbarMountCount - 1)
      if (chatToolbarMountCount === 0) {
        useUIStore.getState().setChatToolbarMounted(false)
      }
    }
  }, [])

  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: selectedBackend === 'opencode',
  })
  const opencodeModelOptions =
    availableOpencodeModels?.map(model => ({
      value: model,
      label: formatOpencodeModelLabel(model),
    })) ?? OPENCODE_MODEL_OPTIONS
  const { data: availablePiModels } = useAvailablePiModels({
    enabled: selectedBackend === 'pi',
  })
  const piModelOptions =
    availablePiModels?.map(model => ({
      value: `pi/${model.id}`,
      label: model.label || formatPiModelLabel(model.id),
      is_default: model.is_default,
    })) ?? PI_MODEL_OPTIONS

  const {
    isCodex,
    activeMcpCount,
    backendModelSections,
    selectedModelLabel,
    selectedModelReasoning,
  } = useToolbarDerivedState({
    selectedBackend,
    selectedProvider,
    selectedModel,
    opencodeModelOptions,
    piModelOptions,
    customCliProfiles,
    installedBackends,
    availableMcpServers,
    enabledMcpServers,
  })
  useEffect(() => {
    if (!selectedModelReasoning) return
    const values = new Set(
      selectedModelReasoning.levels.map(level => level.value)
    )
    if (selectedModelReasoning.type === 'effort') {
      if (!values.has(selectedEffortLevel)) {
        onEffortLevelChange(selectedModelReasoning.default as EffortLevel)
      }
    } else if (!values.has(selectedThinkingLevel)) {
      onThinkingLevelChange(selectedModelReasoning.default as ThinkingLevel)
    }
  }, [
    onEffortLevelChange,
    onThinkingLevelChange,
    selectedEffortLevel,
    selectedModelReasoning,
    selectedThinkingLevel,
  ])
  const availableExecutionModes = getSupportedExecutionModes(selectedBackend)
  const hasMultipleBackendModelChoices =
    backendModelSections.reduce(
      (count, section) => count + section.options.length,
      0
    ) > 1

  const backendModelLabel = useMemo(
    () => (
      <>
        <BackendLabel
          backend={selectedBackend}
          badgeClassName="text-[9px] leading-3"
        />
        <span className="truncate">· {selectedModelLabel}</span>
        {getModelFastInfo(selectedBackend, selectedModel).isFast && (
          <Zap
            className="h-3 w-3 shrink-0 fill-current text-yellow-500"
            aria-label="Fast mode"
          />
        )}
      </>
    ),
    [selectedBackend, selectedModel, selectedModelLabel]
  )

  const backendModelLabelText = useMemo(
    () => `${getBackendPlainLabel(selectedBackend)} · ${selectedModelLabel}`,
    [selectedBackend, selectedModelLabel]
  )

  const {
    viewingContext,
    setViewingContext,
    handleViewIssue,
    handleViewPR,
    handleViewSavedContext,
    handleViewSecurityAlert,
    handleViewAdvisory,
    handleViewLinear,
  } = useContextViewer({
    activeSessionId,
    activeWorktreePath,
    worktreeId,
    projectId,
  })

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
      if (provider && provider !== '__anthropic__') {
        if (selectedModel === 'claude-opus-4-8[1m]') {
          onModelChange('claude-opus-4-8' as ClaudeModel)
        } else if (selectedModel === 'claude-opus-4-7[1m]') {
          onModelChange('claude-opus-4-7' as ClaudeModel)
        } else if (
          selectedModel === 'claude-opus-4-6[1m]' ||
          selectedModel === 'claude-sonnet-4-6[1m]' ||
          selectedModel === 'claude-opus-4-6-fast' ||
          selectedModel === 'claude-opus-4-6[1m]-fast'
        ) {
          onModelChange('claude-opus-4-6' as ClaudeModel)
        }
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

    const runPush = async (remote?: string) => {
      const { setWorktreeLoading, clearWorktreeLoading } =
        useChatStore.getState()
      setWorktreeLoading(worktreeId, 'push')
      const opToast = dismissibleToast.loading('Pushing changes...')
      try {
        const result = await gitPush(activeWorktreePath, prNumber, remote)
        triggerImmediateGitPoll()
        if (projectId) fetchWorktreesStatus(projectId)
        if (result.fellBack) {
          opToast.warning(
            'Could not push to PR branch, pushed to new branch instead'
          )
        } else {
          opToast.success('Changes pushed')
        }
      } catch (error) {
        opToast.error(`Push failed: ${error}`)
      } finally {
        clearWorktreeLoading(worktreeId)
      }
    }

    if (pushNeedsRemotePicker(prNumber)) {
      pickRemoteOrRun(runPush)
    } else {
      runPush()
    }
  }, [activeWorktreePath, worktreeId, projectId, prNumber, pickRemoteOrRun])

  const executeRevertLastCommit = useCallback(async () => {
    if (!activeWorktreePath) return
    const revertToast = dismissibleToast.loading('Reverting last commit...')
    try {
      const result = await invoke<RevertCommitResponse>(
        'revert_last_local_commit',
        { worktreePath: activeWorktreePath }
      )
      triggerImmediateGitPoll()
      if (projectId) fetchWorktreesStatus(projectId)
      revertToast.success(`Reverted: ${result.commit_message}`)
    } catch (error) {
      revertToast.error(`Failed to revert: ${error}`)
    }
  }, [activeWorktreePath, projectId])

  const handleRevertLastCommit = useCallback(() => {
    if (!activeWorktreePath) return
    setRevertConfirmOpen(true)
  }, [activeWorktreePath])

  const canSend = hasInputValue || hasPendingAttachments

  return (
    <>
      <AlertDialog open={revertConfirmOpen} onOpenChange={setRevertConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revert last commit?</AlertDialogTitle>
            <AlertDialogDescription>
              This will undo the latest local commit on this worktree. Your
              working tree changes from that commit will be restored, but this
              action can be disruptive.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={executeRevertLastCommit}>
              Revert last commit
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="@container flex justify-start px-4 py-2 md:px-6">
        <div className="inline-flex max-w-full flex-nowrap items-center overflow-x-auto whitespace-nowrap bg-transparent scrollbar-hide">
          <DockBurgerButton className="flex @xl:hidden" />

          <MobileToolbarMenu
            isDisabled={false}
            hasOpenPr={hasOpenPr}
            hasIssueContexts={loadedIssueContexts.length > 0}
            hasPrContexts={loadedPRContexts.length > 0}
            onSaveContext={onSaveContext}
            onLoadContext={onLoadContext}
            onCommit={onCommit}
            onCommitAndPush={onCommitAndPush}
            onRevertLastCommit={handleRevertLastCommit}
            onOpenPr={onOpenPr}
            onReview={onReview}
            onMerge={onMerge}
            onMergePr={onMergePr}
            handlePullClick={handlePullClick}
            handlePushClick={handlePushClick}
          />

          <MobileSettingsMenu
            isDisabled={false}
            providerLocked={providerLocked}
            selectedBackend={selectedBackend}
            selectedProvider={selectedProvider}
            backendModelLabel={backendModelLabel}
            backendModelLabelText={backendModelLabelText}
            hasMultipleBackendModelChoices={hasMultipleBackendModelChoices}
            selectedEffortLevel={selectedEffortLevel}
            selectedThinkingLevel={selectedThinkingLevel}
            hideThinkingLevel={hideThinkingLevel}
            useAdaptiveThinking={useAdaptiveThinking}
            isCodex={isCodex}
            modelReasoning={selectedModelReasoning}
            customCliProfiles={customCliProfiles}
            onOpenBackendModelPicker={() =>
              setMobileBackendModelPickerOpen(true)
            }
            handleProviderChange={handleProviderChange}
            handleEffortLevelChange={handleEffortLevelChange}
            handleThinkingLevelChange={handleThinkingLevelChange}
            loadedIssueContexts={loadedIssueContexts}
            loadedPRContexts={loadedPRContexts}
            loadedSecurityContexts={loadedSecurityContexts}
            loadedAdvisoryContexts={loadedAdvisoryContexts}
            loadedLinearContexts={loadedLinearContexts}
            attachedSavedContexts={attachedSavedContexts}
            handleViewIssue={handleViewIssue}
            handleViewPR={handleViewPR}
            handleViewSecurityAlert={handleViewSecurityAlert}
            handleViewAdvisory={handleViewAdvisory}
            handleViewLinear={handleViewLinear}
            handleViewSavedContext={handleViewSavedContext}
            availableMcpServers={availableMcpServers}
            enabledMcpServers={enabledMcpServers}
            activeMcpCount={activeMcpCount}
            onToggleMcpServer={onToggleMcpServer}
            prUrl={prUrl}
            prNumber={prNumber}
            prDisplayStatus={displayStatus}
            worktreeId={worktreeId}
            onAttach={onAttach}
            runScripts={runScripts}
            onRunCommand={onRunCommand}
            packageScripts={packageScripts}
            favoritePackageScripts={favoritePackageScripts}
            onRunPackageScript={onRunPackageScript}
            onToggleFavoritePackageScript={onToggleFavoritePackageScript}
          />

          {isMobile && (
            <MobileBackendModelPickerSheet
              open={mobileBackendModelPickerOpen}
              onOpenChange={setMobileBackendModelPickerOpen}
              sessionHasMessages={sessionHasMessages}
              providerLocked={providerLocked}
              selectedBackend={selectedBackend}
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              installedBackends={installedBackends}
              customCliProfiles={customCliProfiles}
              onModelChange={handleModelChange}
              onBackendModelChange={onBackendModelChange}
            />
          )}

          <div className="block @xl:hidden h-4 w-px shrink-0 bg-border/50" />

          <ExecutionModeDropdown
            executionMode={executionMode}
            availableModes={availableExecutionModes}
            disabled={hasPendingQuestions}
            onSetExecutionMode={onSetExecutionMode}
            className="flex @xl:hidden shrink-0"
            align="end"
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
            isCodex={isCodex}
            modelReasoning={selectedModelReasoning}
            prUrl={prUrl}
            prNumber={prNumber}
            displayStatus={displayStatus}
            checkStatus={checkStatus}
            mergeableStatus={mergeableStatus}
            activeWorktreePath={activeWorktreePath}
            availableMcpServers={availableMcpServers}
            enabledMcpServers={enabledMcpServers}
            isHealthChecking={isHealthChecking}
            mcpStatuses={mcpStatuses}
            loadedIssueContexts={loadedIssueContexts}
            loadedPRContexts={loadedPRContexts}
            loadedSecurityContexts={loadedSecurityContexts}
            loadedAdvisoryContexts={loadedAdvisoryContexts}
            loadedLinearContexts={loadedLinearContexts}
            attachedSavedContexts={attachedSavedContexts}
            providerDropdownOpen={providerDropdownOpen}
            thinkingDropdownOpen={thinkingDropdownOpen}
            mcpDropdownOpen={mcpDropdownOpen}
            setProviderDropdownOpen={setProviderDropdownOpen}
            setThinkingDropdownOpen={setThinkingDropdownOpen}
            onMcpDropdownOpenChange={handleMcpDropdownOpenChange}
            onOpenMagicModal={onOpenMagicModal}
            onOpenProjectSettings={onOpenProjectSettings}
            onResolvePrConflicts={onResolvePrConflicts}
            onLoadContext={onLoadContext}
            onAttach={onAttach}
            installedBackends={installedBackends}
            onSetExecutionMode={onSetExecutionMode}
            availableExecutionModes={availableExecutionModes}
            onToggleMcpServer={onToggleMcpServer}
            handleModelChange={handleModelChange}
            handleBackendModelChange={onBackendModelChange}
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
    </>
  )
})
