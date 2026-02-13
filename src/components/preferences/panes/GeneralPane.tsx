import React, { useState, useCallback, type FC } from 'react'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, ChevronDown } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  useClaudeCliStatus,
  useClaudeCliAuth,
  claudeCliQueryKeys,
} from '@/services/claude-cli'
import { useGhCliStatus, useGhCliAuth, ghCliQueryKeys } from '@/services/gh-cli'
import { useUIStore } from '@/store/ui-store'
import type { ClaudeAuthStatus } from '@/types/claude-cli'
import type { GhAuthStatus } from '@/types/gh-cli'
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
import {
  usePreferences,
  useSavePreferences,
} from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import {
  modelOptions,
  thinkingLevelOptions,
  effortLevelOptions,
  terminalOptions,
  editorOptions,
  gitPollIntervalOptions,
  remotePollIntervalOptions,
  archiveRetentionOptions,
  removalBehaviorOptions,
  notificationSoundOptions,
  type RemovalBehavior,
  type ClaudeModel,
  type TerminalApp,
  type EditorApp,
  type NotificationSound,
} from '@/types/preferences'
import { playNotificationSound } from '@/lib/sounds'
import type { ThinkingLevel, EffortLevel } from '@/types/chat'
import { isServerApp } from '@/lib/environment'
import {
  setGitPollInterval,
  setRemotePollInterval,
} from '@/services/git-status'

interface CleanupResult {
  deleted_worktrees: number
  deleted_sessions: number
}

const SettingsSection: React.FC<{
  title: string
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
        <div className="text-xs text-muted-foreground truncate">
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

  // Auth status queries - only enabled when CLI is installed
  const { data: claudeAuth, isLoading: isClaudeAuthLoading } = useClaudeCliAuth(
    {
      enabled: !!cliStatus?.installed,
    }
  )
  const { data: ghAuth, isLoading: isGhAuthLoading } = useGhCliAuth({
    enabled: !!ghStatus?.installed,
  })

  // Track which auth check is in progress (for manual refresh)
  const [checkingClaudeAuth, setCheckingClaudeAuth] = useState(false)
  const [checkingGhAuth, setCheckingGhAuth] = useState(false)

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
    openCliLoginModal('claude', escapedPath)
  }, [cliStatus?.path, openCliLoginModal, queryClient])

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
      {isServerApp() && (
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
                  'Required'
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

      {isServerApp() && (
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

      <SettingsSection title="Defaults">
        <div className="space-y-4">
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
            label="Thinking in plan mode only"
            description="Disable thinking in build/yolo for faster iteration"
          >
            <Switch
              checked={preferences?.disable_thinking_in_non_plan_modes ?? true}
              onCheckedChange={checked => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    disable_thinking_in_non_plan_modes: checked,
                  })
                }
              }}
            />
          </InlineField>

          <AiLanguageField
            preferences={preferences}
            savePreferences={savePreferences}
          />

          <InlineField
            label="Allow web tools in plan mode"
            description="Auto-approve WebFetch/WebSearch without prompts"
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

          {isServerApp() && (
            <InlineField label="Editor" description="App to open worktrees in">
              <Select
                value={preferences?.editor ?? 'vscode'}
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

          {isServerApp() && (
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

      <SettingsSection title="Archive">
        <div className="space-y-4">
          <InlineField
            label="Removal behavior"
            description="What happens when closing sessions or worktrees"
          >
            <Select
              value={preferences?.removal_behavior ?? 'archive'}
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

  const hasChanges =
    localValue !== (preferences?.ai_language ?? '')

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
