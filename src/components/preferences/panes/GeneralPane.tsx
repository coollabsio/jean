import React, { useState, useCallback, useMemo, type FC } from 'react'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, ChevronDown, Check, ChevronsUpDown } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  useClaudeCliStatus,
  useClaudeCliAuth,
  claudeCliQueryKeys,
} from '@/services/claude-cli'
import { useGhCliStatus, useGhCliAuth, ghCliQueryKeys } from '@/services/gh-cli'
import {
  useCodexCliStatus,
  useCodexCliAuth,
  codexCliQueryKeys,
} from '@/services/codex-cli'
import {
  useOpenCodeCliStatus,
  useOpenCodeCliAuth,
  useAvailableOpencodeModels,
  opencodeCliQueryKeys,
} from '@/services/opencode-cli'
import { useUIStore } from '@/store/ui-store'
import type { ClaudeAuthStatus } from '@/types/claude-cli'
import type { GhAuthStatus } from '@/types/gh-cli'
import type { CodexAuthStatus } from '@/types/codex-cli'
import type { OpenCodeAuthStatus } from '@/types/opencode-cli'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { usePreferences, useSavePreferences } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import {
  modelOptions,
  thinkingLevelOptions,
  effortLevelOptions,
  codexModelOptions,
  codexReasoningOptions,
  backendOptions,
  terminalOptions,
  editorOptions,
  gitPollIntervalOptions,
  remotePollIntervalOptions,
  archiveRetentionOptions,
  removalBehaviorOptions,
  notificationSoundOptions,
  type RemovalBehavior,
  type ClaudeModel,
  type CodexModel,
  type CodexReasoningEffort,
  type CliBackend,
  type TerminalApp,
  type EditorApp,
  type NotificationSound,
  openInDefaultOptions,
  type OpenInDefault,
} from '@/types/preferences'
import { OPENCODE_MODEL_OPTIONS } from '@/components/chat/toolbar/toolbar-options'
import { formatOpencodeModelLabel } from '@/components/chat/toolbar/toolbar-utils'
import { playNotificationSound } from '@/lib/sounds'
import type { ThinkingLevel, EffortLevel } from '@/types/chat'
import { isNativeApp } from '@/lib/environment'
import { cn } from '@/lib/utils'
import {
  setGitPollInterval,
  setRemotePollInterval,
} from '@/services/git-status'

interface CleanupResult {
  deleted_worktrees: number
  deleted_sessions: number
}

const SettingsSection: React.FC<{
  title: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
}> = ({ title, actions, children }) => (
  <div className="space-y-4">
    <div>
      <div className="flex items-center gap-3">
        <h3 className="text-lg font-medium text-foreground">{title}</h3>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

const InlineField: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-96 sm:shrink-0">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground break-words">
          {description}
        </div>
      )}
    </div>
    {children}
  </div>
)

export const GeneralPane: React.FC = () => {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const savePreferences = useSavePreferences()
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

  // CLI status hooks
  const { data: cliStatus, isLoading: isCliLoading } = useClaudeCliStatus()
  const { data: ghStatus, isLoading: isGhLoading } = useGhCliStatus()
  const { data: codexStatus, isLoading: isCodexLoading } = useCodexCliStatus()
  const { data: opencodeStatus, isLoading: isOpenCodeLoading } =
    useOpenCodeCliStatus()

  // Auth status queries - only enabled when CLI is installed
  const { data: claudeAuth, isLoading: isClaudeAuthLoading } = useClaudeCliAuth(
    {
      enabled: !!cliStatus?.installed,
    }
  )
  const { data: ghAuth, isLoading: isGhAuthLoading } = useGhCliAuth({
    enabled: !!ghStatus?.installed,
  })
  const { data: codexAuth, isLoading: isCodexAuthLoading } = useCodexCliAuth({
    enabled: !!codexStatus?.installed,
  })
  const { data: opencodeAuth, isLoading: isOpenCodeAuthLoading } =
    useOpenCodeCliAuth({
      enabled: !!opencodeStatus?.installed,
    })
  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: !!opencodeStatus?.installed,
  })

  // Track which auth check is in progress (for manual refresh)
  const [checkingClaudeAuth, setCheckingClaudeAuth] = useState(false)
  const [checkingGhAuth, setCheckingGhAuth] = useState(false)
  const [checkingCodexAuth, setCheckingCodexAuth] = useState(false)
  const [checkingOpenCodeAuth, setCheckingOpenCodeAuth] = useState(false)
  const [openCodeModelPopoverOpen, setOpenCodeModelPopoverOpen] =
    useState(false)

  // Use global ui-store for CLI modals
  const openCliUpdateModal = useUIStore(state => state.openCliUpdateModal)
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)

  const handleDeleteAllArchives = useCallback(async () => {
    setIsDeleting(true)
    const toastId = toast.loading('Deleting all archives...')

    try {
      const result = await invoke<CleanupResult>('delete_all_archives')

      // Invalidate archive queries to refresh UI
      queryClient.invalidateQueries({ queryKey: ['archived-worktrees'] })
      queryClient.invalidateQueries({ queryKey: ['all-archived-sessions'] })

      const parts: string[] = []
      if (result.deleted_worktrees > 0) {
        parts.push(
          `${result.deleted_worktrees} worktree${result.deleted_worktrees === 1 ? '' : 's'}`
        )
      }
      if (result.deleted_sessions > 0) {
        parts.push(
          `${result.deleted_sessions} session${result.deleted_sessions === 1 ? '' : 's'}`
        )
      }

      if (parts.length > 0) {
        toast.success(`Deleted ${parts.join(' and ')}`, { id: toastId })
      } else {
        toast.info('No archives to delete', { id: toastId })
      }
    } catch (error) {
      toast.error(`Failed to delete archives: ${error}`, { id: toastId })
    } finally {
      setIsDeleting(false)
      setShowDeleteAllDialog(false)
    }
  }, [queryClient])

  const handleModelChange = (value: ClaudeModel) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, selected_model: value })
    }
  }

  const handleThinkingLevelChange = (value: ThinkingLevel) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, thinking_level: value })
    }
  }

  const handleEffortLevelChange = (value: EffortLevel) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, default_effort_level: value })
    }
  }

  const handleBackendChange = (value: CliBackend) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, default_backend: value })
    }
  }

  // If stored default_backend isn't installed, fall back to the first installed one
  const stored = preferences?.default_backend ?? 'claude'
  const claudeInstalled = cliStatus?.installed
  const codexInstalled = codexStatus?.installed
  const opencodeInstalled = opencodeStatus?.installed
  const effectiveBackend = useMemo(() => {
    const installed: Record<string, boolean | undefined> = {
      claude: claudeInstalled,
      codex: codexInstalled,
      opencode: opencodeInstalled,
    }
    if (installed[stored]) return stored
    const first = backendOptions.find(o => installed[o.value])
    return first?.value ?? stored
  }, [stored, claudeInstalled, codexInstalled, opencodeInstalled])

  const handleCodexModelChange = (value: CodexModel) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, selected_codex_model: value })
    }
  }

  const handleCodexReasoningChange = (value: CodexReasoningEffort) => {
    if (preferences) {
      savePreferences.mutate({
        ...preferences,
        default_codex_reasoning_effort: value,
      })
    }
  }

  const handleOpenCodeModelChange = (value: string) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, selected_opencode_model: value })
    }
  }

  const selectedOpenCodeModel =
    preferences?.selected_opencode_model ?? 'opencode/gpt-5'
  const formatOpenCodeModelLabelForSettings = (value: string) => {
    const formatted = formatOpencodeModelLabel(value)
    return value.startsWith('opencode/')
      ? formatted.replace(/\s+\(OpenCode\)$/, '')
      : formatted
  }
  const openCodeModelOptions = (
    availableOpencodeModels?.length
      ? availableOpencodeModels
      : OPENCODE_MODEL_OPTIONS.map(option => option.value)
  ).map(value => ({
    value,
    label: formatOpenCodeModelLabelForSettings(value),
  }))
  const selectedOpenCodeModelLabel =
    openCodeModelOptions.find(option => option.value === selectedOpenCodeModel)
      ?.label ?? formatOpenCodeModelLabelForSettings(selectedOpenCodeModel)

  const handleCodexMultiAgentToggle = (enabled: boolean) => {
    if (preferences) {
      savePreferences.mutate({
        ...preferences,
        codex_multi_agent_enabled: enabled,
      })
    }
  }

  const handleCodexMaxThreadsChange = (value: string) => {
    if (preferences) {
      const num = Math.max(1, Math.min(8, parseInt(value, 10) || 3))
      savePreferences.mutate({
        ...preferences,
        codex_max_agent_threads: num,
      })
    }
  }

  const handleTerminalChange = (value: TerminalApp) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, terminal: value })
    }
  }

  const handleEditorChange = (value: EditorApp) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, editor: value })
    }
  }

  const handleOpenInChange = (value: OpenInDefault) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, open_in: value })
    }
  }

  const handleAutoBranchNamingChange = (checked: boolean) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, auto_branch_naming: checked })
    }
  }

  const handleAutoSessionNamingChange = (checked: boolean) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, auto_session_naming: checked })
    }
  }

  const handleGitPollIntervalChange = (value: string) => {
    const seconds = parseInt(value, 10)
    if (preferences && !isNaN(seconds)) {
      savePreferences.mutate({ ...preferences, git_poll_interval: seconds })
      // Also update the backend immediately
      setGitPollInterval(seconds)
    }
  }

  const handleRemotePollIntervalChange = (value: string) => {
    const seconds = parseInt(value, 10)
    if (preferences && !isNaN(seconds)) {
      savePreferences.mutate({ ...preferences, remote_poll_interval: seconds })
      // Also update the backend immediately
      setRemotePollInterval(seconds)
    }
  }

  const handleArchiveRetentionChange = (value: string) => {
    const days = parseInt(value, 10)
    if (preferences && !isNaN(days)) {
      savePreferences.mutate({ ...preferences, archive_retention_days: days })
    }
  }

  const handleWaitingSoundChange = (value: NotificationSound) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, waiting_sound: value })
      // Play preview of the selected sound
      playNotificationSound(value)
    }
  }

  const handleReviewSoundChange = (value: NotificationSound) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, review_sound: value })
      // Play preview of the selected sound
      playNotificationSound(value)
    }
  }

  const handleClaudeLogin = useCallback(async () => {
    if (!cliStatus?.path) return

    // First check if already authenticated
    setCheckingClaudeAuth(true)
    try {
      // Invalidate cache and refetch to get fresh status
      await queryClient.invalidateQueries({
        queryKey: claudeCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<ClaudeAuthStatus>({
        queryKey: claudeCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('Claude CLI is already authenticated')
        return
      }
    } finally {
      setCheckingClaudeAuth(false)
    }

    // Not authenticated, open login modal
    // Use & "path" syntax for PowerShell on Windows, single-quote escaping for Unix
    const isWindows = navigator.userAgent.includes('Windows')
    const escapedPath = isWindows
      ? `& "${cliStatus.path}"`
      : `'${cliStatus.path.replace(/'/g, "'\\''")}'`
    openCliLoginModal(
      'claude',
      cliStatus.supports_auth_command
        ? escapedPath + ' auth login'
        : escapedPath
    )
  }, [
    cliStatus?.path,
    cliStatus?.supports_auth_command,
    openCliLoginModal,
    queryClient,
  ])

  const handleGhLogin = useCallback(async () => {
    if (!ghStatus?.path) return

    // First check if already authenticated
    setCheckingGhAuth(true)
    try {
      // Invalidate cache and refetch to get fresh status
      await queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.auth() })
      const result = await queryClient.fetchQuery<GhAuthStatus>({
        queryKey: ghCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('GitHub CLI is already authenticated')
        return
      }
    } finally {
      setCheckingGhAuth(false)
    }

    // Not authenticated, open login modal
    // Use & "path" syntax for PowerShell on Windows, single-quote escaping for Unix
    const isWindows = navigator.userAgent.includes('Windows')
    const escapedPath = isWindows
      ? `& "${ghStatus.path}" auth login`
      : `'${ghStatus.path.replace(/'/g, "'\\''")}'` + ' auth login'
    openCliLoginModal('gh', escapedPath)
  }, [ghStatus?.path, openCliLoginModal, queryClient])

  const handleCodexLogin = useCallback(async () => {
    if (!codexStatus?.path) return

    setCheckingCodexAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: codexCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<CodexAuthStatus>({
        queryKey: codexCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('Codex CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCodexAuth(false)
    }

    // Not authenticated, open login modal with `codex login`
    const isWindows = navigator.userAgent.includes('Windows')
    const escapedPath = isWindows
      ? `& "${codexStatus.path}" login`
      : `'${codexStatus.path.replace(/'/g, "'\\''")}'` + ' login'
    openCliLoginModal('codex', escapedPath)
  }, [codexStatus?.path, openCliLoginModal, queryClient])

  const handleOpenCodeLogin = useCallback(async () => {
    if (!opencodeStatus?.path) return

    setCheckingOpenCodeAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: opencodeCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<OpenCodeAuthStatus>({
        queryKey: opencodeCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('OpenCode CLI is already authenticated')
        return
      }
    } finally {
      setCheckingOpenCodeAuth(false)
    }

    const isWindows = navigator.userAgent.includes('Windows')
    const escapedPath = isWindows
      ? `& "${opencodeStatus.path}" auth login`
      : `'${opencodeStatus.path.replace(/'/g, "'\\''")}'` + ' auth login'
    openCliLoginModal('opencode', escapedPath)
  }, [opencodeStatus?.path, openCliLoginModal, queryClient])

  const claudeStatusDescription = cliStatus?.installed
    ? cliStatus.path
    : 'Claude CLI is required for chat functionality'

  const ghStatusDescription = ghStatus?.installed
    ? ghStatus.path
    : 'GitHub CLI is required for GitHub integration'

  const handleCopyPath = useCallback((path: string | null | undefined) => {
    if (!path) return
    navigator.clipboard.writeText(path)
    toast.success('Path copied to clipboard')
  }, [])

  return (
    <div className="space-y-6">
      {isNativeApp() && (
        <SettingsSection
          title="Claude CLI"
          actions={
            cliStatus?.installed ? (
              checkingClaudeAuth || isClaudeAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : claudeAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground">Logged in</span>
              ) : (
                <Button variant="outline" size="sm" onClick={handleClaudeLogin}>
                  Login
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Not installed
              </span>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={cliStatus?.installed ? 'Version' : 'Status'}
              description={
                cliStatus?.installed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleCopyPath(cliStatus.path)}
                        className="text-left hover:underline cursor-pointer"
                      >
                        {claudeStatusDescription}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                ) : (
                  'Optional — enables Claude AI sessions'
                )
              }
            >
              {isCliLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : cliStatus?.installed ? (
                <Button
                  variant="outline"
                  className="w-40 justify-between"
                  onClick={() => openCliUpdateModal('claude')}
                >
                  {cliStatus.version ?? 'Installed'}
                  <ChevronDown className="size-3" />
                </Button>
              ) : (
                <Button
                  className="w-40"
                  onClick={() => openCliUpdateModal('claude')}
                >
                  Install
                </Button>
              )}
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {isNativeApp() && (
        <SettingsSection
          title="GitHub CLI"
          actions={
            ghStatus?.installed ? (
              checkingGhAuth || isGhAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : ghAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground">Logged in</span>
              ) : (
                <Button variant="outline" size="sm" onClick={handleGhLogin}>
                  Login
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Not installed
              </span>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={ghStatus?.installed ? 'Version' : 'Status'}
              description={
                ghStatus?.installed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleCopyPath(ghStatus.path)}
                        className="text-left hover:underline cursor-pointer"
                      >
                        {ghStatusDescription}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                ) : (
                  'Optional'
                )
              }
            >
              {isGhLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : ghStatus?.installed ? (
                <Button
                  variant="outline"
                  className="w-40 justify-between"
                  onClick={() => openCliUpdateModal('gh')}
                >
                  {ghStatus.version ?? 'Installed'}
                  <ChevronDown className="size-3" />
                </Button>
              ) : (
                <Button
                  className="w-40"
                  onClick={() => openCliUpdateModal('gh')}
                >
                  Install
                </Button>
              )}
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {isNativeApp() && (
        <SettingsSection
          title={
            <>
              Codex CLI{' '}
              <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                BETA
              </span>
            </>
          }
          actions={
            codexStatus?.installed ? (
              checkingCodexAuth || isCodexAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : codexAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground">Logged in</span>
              ) : (
                <Button variant="outline" size="sm" onClick={handleCodexLogin}>
                  Login
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Not installed
              </span>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={codexStatus?.installed ? 'Version' : 'Status'}
              description={
                codexStatus?.installed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleCopyPath(codexStatus.path)}
                        className="text-left hover:underline cursor-pointer"
                      >
                        {codexStatus.path ?? 'Unknown path'}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                ) : (
                  'Optional — enables Codex AI sessions'
                )
              }
            >
              {isCodexLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : codexStatus?.installed ? (
                <Button
                  variant="outline"
                  className="w-40 justify-between"
                  onClick={() => openCliUpdateModal('codex')}
                >
                  {codexStatus.version ?? 'Installed'}
                  <ChevronDown className="size-3" />
                </Button>
              ) : (
                <Button
                  className="w-40"
                  onClick={() => openCliUpdateModal('codex')}
                >
                  Install
                </Button>
              )}
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {isNativeApp() && (
        <SettingsSection
          title={
            <>
              OpenCode CLI{' '}
              <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                BETA
              </span>
            </>
          }
          actions={
            opencodeStatus?.installed ? (
              checkingOpenCodeAuth || isOpenCodeAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : opencodeAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground">Logged in</span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleOpenCodeLogin}
                >
                  Login
                </Button>
              )
            ) : (
              <span className="text-sm text-muted-foreground">
                Not installed
              </span>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={opencodeStatus?.installed ? 'Version' : 'Status'}
              description={
                opencodeStatus?.installed ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => handleCopyPath(opencodeStatus.path)}
                        className="text-left hover:underline cursor-pointer"
                      >
                        {opencodeStatus.path ?? 'Unknown path'}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                ) : (
                  'Optional — enables OpenCode AI sessions'
                )
              }
            >
              {isOpenCodeLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : opencodeStatus?.installed ? (
                <Button
                  variant="outline"
                  className="w-40 justify-between"
                  onClick={() => openCliUpdateModal('opencode')}
                >
                  {opencodeStatus.version ?? 'Installed'}
                  <ChevronDown className="size-3" />
                </Button>
              ) : (
                <Button
                  className="w-40"
                  onClick={() => openCliUpdateModal('opencode')}
                >
                  Install
                </Button>
              )}
            </InlineField>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title="Defaults">
        <div className="space-y-4">
          <InlineField
            label="Default backend"
            description="CLI to use for new sessions"
          >
            <Select
              value={effectiveBackend}
              onValueChange={handleBackendChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {backendOptions
                  .filter(option =>
                    option.value === 'claude'
                      ? cliStatus?.installed
                      : option.value === 'codex'
                        ? codexStatus?.installed
                        : opencodeStatus?.installed
                  )
                  .map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </InlineField>

          {/* Claude subsection */}
          <div className="pt-2">
            <div className="text-sm font-semibold text-foreground/80 mb-3">
              Claude
            </div>
          </div>

          <InlineField
            label="Model"
            description="Claude model for AI assistance"
          >
            <Select
              value={preferences?.selected_model ?? 'opus'}
              onValueChange={handleModelChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {modelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Thinking"
            description="Extended thinking for complex tasks"
          >
            <Select
              value={preferences?.thinking_level ?? 'off'}
              onValueChange={handleThinkingLevelChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {thinkingLevelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Effort level"
            description="Effort for Opus (requires CLI 2.1.32+)"
          >
            <Select
              value={preferences?.default_effort_level ?? 'high'}
              onValueChange={handleEffortLevelChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {effortLevelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Chrome browser integration"
            description="Enable browser automation via Chrome extension"
          >
            <Switch
              checked={preferences?.chrome_enabled ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    chrome_enabled: checked,
                  })
                }
              }}
            />
          </InlineField>

          {/* Codex subsection */}
          <div className="pt-2">
            <div className="text-sm font-semibold text-foreground/80 mb-3">
              Codex{' '}
              <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                BETA
              </span>
            </div>
          </div>

          <InlineField
            label="Model"
            description="Codex model for AI assistance"
          >
            <Select
              value={preferences?.selected_codex_model ?? 'gpt-5.3-codex'}
              onValueChange={handleCodexModelChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {codexModelOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Reasoning effort"
            description="Codex reasoning depth"
          >
            <Select
              value={preferences?.default_codex_reasoning_effort ?? 'high'}
              onValueChange={handleCodexReasoningChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {codexReasoningOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Multi-Agent"
            description="Allow Codex to spawn parallel subagents (experimental)"
          >
            <Switch
              checked={preferences?.codex_multi_agent_enabled ?? false}
              onCheckedChange={handleCodexMultiAgentToggle}
            />
          </InlineField>

          {preferences?.codex_multi_agent_enabled && (
            <InlineField
              label="Max agent threads"
              description="Maximum concurrent subagents (1–8)"
            >
              <Input
                type="number"
                min={1}
                max={8}
                className="w-20"
                value={preferences?.codex_max_agent_threads ?? 3}
                onChange={e => handleCodexMaxThreadsChange(e.target.value)}
              />
            </InlineField>
          )}

          {/* OpenCode subsection */}
          <div className="pt-2">
            <div className="text-sm font-semibold text-foreground/80 mb-3">
              OpenCode{' '}
              <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                BETA
              </span>
            </div>
          </div>

          <InlineField
            label="Model"
            description="OpenCode model for AI assistance"
          >
            <Popover
              open={openCodeModelPopoverOpen}
              onOpenChange={setOpenCodeModelPopoverOpen}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={openCodeModelPopoverOpen}
                  aria-label="Select OpenCode model"
                  className="w-80 max-w-full justify-between"
                >
                  <span className="max-w-[16rem] truncate text-left">
                    {selectedOpenCodeModelLabel}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-[var(--radix-popover-trigger-width)] p-0"
              >
                <Command>
                  <CommandInput placeholder="Search models..." />
                  <CommandList>
                    <CommandEmpty>No models found.</CommandEmpty>
                    <CommandGroup>
                      {openCodeModelOptions.map(option => (
                        <CommandItem
                          key={option.value}
                          value={`${option.label} ${option.value}`}
                          onSelect={() => {
                            handleOpenCodeModelChange(option.value)
                            setOpenCodeModelPopoverOpen(false)
                          }}
                        >
                          <span className="max-w-[18rem] truncate">
                            {option.label}
                          </span>
                          <Check
                            className={cn(
                              'ml-auto h-4 w-4',
                              selectedOpenCodeModel === option.value
                                ? 'opacity-100'
                                : 'opacity-0'
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </InlineField>

          {/* Shared settings */}
          <div className="pt-2">
            <div className="text-sm font-semibold text-foreground/80 mb-3">
              General
            </div>
          </div>

          <AiLanguageField
            preferences={preferences}
            savePreferences={savePreferences}
          />

          <InlineField
            label="Allow web tools in plan mode"
            description="WebFetch/WebSearch for Claude, --search for Codex"
          >
            <Switch
              checked={preferences?.allow_web_tools_in_plan_mode ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    allow_web_tools_in_plan_mode: checked,
                  })
                }
              }}
            />
          </InlineField>

          {isNativeApp() && (
            <InlineField label="Editor" description="App to open worktrees in">
              <Select
                value={preferences?.editor ?? 'zed'}
                onValueChange={handleEditorChange}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {editorOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>
          )}

          {isNativeApp() && (
            <InlineField
              label="Terminal"
              description="App to open terminals in"
            >
              <Select
                value={preferences?.terminal ?? 'terminal'}
                onValueChange={handleTerminalChange}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {terminalOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>
          )}

          {isNativeApp() && (
            <InlineField
              label="Open In"
              description="Default app for Open button"
            >
              <Select
                value={preferences?.open_in ?? 'editor'}
                onValueChange={handleOpenInChange}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {openInDefaultOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>
          )}

          <InlineField
            label="Git poll interval"
            description="Check for branch updates when focused"
          >
            <Select
              value={String(preferences?.git_poll_interval ?? 60)}
              onValueChange={handleGitPollIntervalChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {gitPollIntervalOptions.map(option => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Remote poll interval"
            description="Check for PR status updates"
          >
            <Select
              value={String(preferences?.remote_poll_interval ?? 60)}
              onValueChange={handleRemotePollIntervalChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {remotePollIntervalOptions.map(option => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection title="Notifications">
        <div className="space-y-4">
          <InlineField
            label="Waiting sound"
            description="Play when session needs your input"
          >
            <Select
              value={preferences?.waiting_sound ?? 'none'}
              onValueChange={handleWaitingSoundChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {notificationSoundOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Review sound"
            description="Play when session finishes"
          >
            <Select
              value={preferences?.review_sound ?? 'none'}
              onValueChange={handleReviewSoundChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {notificationSoundOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection title="Auto-generate">
        <div className="space-y-4">
          <InlineField
            label="Branch names"
            description="Generate branch names from your first message"
          >
            <Switch
              checked={preferences?.auto_branch_naming ?? true}
              onCheckedChange={handleAutoBranchNamingChange}
            />
          </InlineField>
          <InlineField
            label="Session names"
            description="Generate session names from your first message"
          >
            <Switch
              checked={preferences?.auto_session_naming ?? true}
              onCheckedChange={handleAutoSessionNamingChange}
            />
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection title="Worktrees">
        <div className="space-y-4">
          <InlineField
            label="Auto-pull base branch"
            description="Pull the latest changes before creating a new worktree"
          >
            <Switch
              checked={preferences?.auto_pull_base_branch ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    auto_pull_base_branch: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Restore last session on project switch"
            description="Automatically reopen the last worktree and session when switching projects"
          >
            <Switch
              checked={preferences?.restore_last_session ?? false}
              onCheckedChange={checked => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    restore_last_session: checked,
                  })
                }
              }}
            />
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection title="Archive">
        <div className="space-y-4">
          <InlineField
            label="Confirm before closing"
            description="Show confirmation dialog when closing sessions or worktrees"
          >
            <Switch
              checked={preferences?.confirm_session_close ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    confirm_session_close: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Removal behavior"
            description="What happens when closing sessions or worktrees"
          >
            <Select
              value={preferences?.removal_behavior ?? 'delete'}
              onValueChange={(value: RemovalBehavior) => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    removal_behavior: value,
                  })
                }
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {removalBehaviorOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Auto-archive on PR merge"
            description="Archive worktrees when their PR is merged"
          >
            <Switch
              checked={preferences?.auto_archive_on_pr_merged ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    auto_archive_on_pr_merged: checked,
                  })
                }
              }}
            />
          </InlineField>

          <InlineField
            label="Auto-delete archives"
            description="Delete archived items older than this"
          >
            <Select
              value={String(preferences?.archive_retention_days ?? 30)}
              onValueChange={handleArchiveRetentionChange}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {archiveRetentionOptions.map(option => (
                  <SelectItem key={option.value} value={String(option.value)}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>

          <InlineField
            label="Delete all archives"
            description="Permanently delete all archived worktrees and sessions"
          >
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowDeleteAllDialog(true)}
              disabled={isDeleting}
            >
              Delete All
            </Button>
          </InlineField>
        </div>
      </SettingsSection>

      <AlertDialog
        open={showDeleteAllDialog}
        onOpenChange={setShowDeleteAllDialog}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete all archives?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete all archived worktrees and sessions,
              including their git branches and worktree directories. This action
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAllArchives}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const AiLanguageField: FC<{
  preferences: AppPreferences | undefined
  savePreferences: ReturnType<typeof useSavePreferences>
}> = ({ preferences, savePreferences }) => {
  const [localValue, setLocalValue] = useState(preferences?.ai_language ?? '')

  const hasChanges = localValue !== (preferences?.ai_language ?? '')

  const handleSave = useCallback(() => {
    if (!preferences) return
    savePreferences.mutate({
      ...preferences,
      ai_language: localValue,
    })
  }, [preferences, savePreferences, localValue])

  return (
    <InlineField
      label="AI Language"
      description="Language for AI responses (e.g. French, 日本語)"
    >
      <div className="flex items-center gap-2">
        <Input
          className="w-40"
          placeholder="Default"
          value={localValue}
          onChange={e => setLocalValue(e.target.value)}
        />
        <Button
          size="sm"
          onClick={handleSave}
          disabled={!hasChanges || savePreferences.isPending}
        >
          {savePreferences.isPending && (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          Save
        </Button>
      </div>
    </InlineField>
  )
}
