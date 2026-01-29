import React, { useState, useCallback } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, ChevronDown } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useClaudeCliStatus, useClaudeCliAuth, claudeCliQueryKeys } from '@/services/claude-cli'
import { useGhCliStatus, useGhCliAuth, ghCliQueryKeys } from '@/services/gh-cli'
import { useGlabCliStatus, useGlabCliAuth, glabCliQueryKeys } from '@/services/glab-cli'
import {
  useGeminiCliStatus,
  useGeminiCliAuth,
  useCodexCliStatus,
  useCodexCliAuth,
} from '@/services/ai-cli'
import { useUIStore } from '@/store/ui-store'
import type { ClaudeAuthStatus } from '@/types/claude-cli'
import type { GhAuthStatus } from '@/types/gh-cli'
import type { GlabAuthStatus } from '@/types/glab-cli'
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
import { usePreferences, useSavePreferences } from '@/services/preferences'
import {
  thinkingLevelOptions,
  terminalOptions,
  editorOptions,
  gitPollIntervalOptions,
  remotePollIntervalOptions,
  archiveRetentionOptions,
  notificationSoundOptions,
  aiProviderOptions,
  getModelOptionsForProvider,
  getDefaultModelForProvider,
  type ClaudeModel,
  type TerminalApp,
  type EditorApp,
  type NotificationSound,
  type AiCliProvider,
} from '@/types/preferences'
import { playNotificationSound } from '@/lib/sounds'
import type { ThinkingLevel } from '@/types/chat'
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
  <div className="flex items-center gap-4">
    <div className="w-96 shrink-0 space-y-0.5">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
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
  const { data: glabStatus, isLoading: isGlabLoading } = useGlabCliStatus()
  const { data: geminiStatus, isLoading: isGeminiLoading } = useGeminiCliStatus()
  const { data: codexStatus, isLoading: isCodexLoading } = useCodexCliStatus()

  // Auth status queries - only enabled when CLI is installed
  const { data: claudeAuth, isLoading: isClaudeAuthLoading } = useClaudeCliAuth({
    enabled: !!cliStatus?.installed,
  })
  const { data: ghAuth, isLoading: isGhAuthLoading } = useGhCliAuth({
    enabled: !!ghStatus?.installed,
  })
  const { data: glabAuth, isLoading: isGlabAuthLoading } = useGlabCliAuth({
    enabled: !!glabStatus?.installed,
  })
  const { data: geminiAuth, isLoading: isGeminiAuthLoading } = useGeminiCliAuth(
    !!geminiStatus?.installed
  )
  const { data: codexAuth, isLoading: isCodexAuthLoading } = useCodexCliAuth(
    !!codexStatus?.installed
  )

  // Track which auth check is in progress (for manual refresh)
  const [checkingClaudeAuth, setCheckingClaudeAuth] = useState(false)
  const [checkingGhAuth, setCheckingGhAuth] = useState(false)
  const [checkingGlabAuth, setCheckingGlabAuth] = useState(false)
  const [checkingGeminiAuth, _setCheckingGeminiAuth] = useState(false)
  const [checkingCodexAuth, _setCheckingCodexAuth] = useState(false)

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

  const handleModelChange = (value: string) => {
    if (preferences) {
      // Type assertion since we know it's a valid model for the current provider
      savePreferences.mutate({ ...preferences, selected_model: value as ClaudeModel })
    }
  }

  // When AI provider changes, reset the model to the default for that provider
  const handleProviderChange = (value: AiCliProvider) => {
    if (preferences) {
      const defaultModel = getDefaultModelForProvider(value)
      savePreferences.mutate({
        ...preferences,
        default_ai_provider: value,
        selected_model: defaultModel as ClaudeModel,
      })
    }
  }

  // Get model options based on current provider
  const currentProvider = preferences?.default_ai_provider ?? 'claude'
  const currentModelOptions = getModelOptionsForProvider(currentProvider)

  const handleThinkingLevelChange = (value: ThinkingLevel) => {
    if (preferences) {
      savePreferences.mutate({ ...preferences, thinking_level: value })
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
      await queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.auth() })
      const result = await queryClient.fetchQuery<ClaudeAuthStatus>({ queryKey: claudeCliQueryKeys.auth() })

      if (result?.authenticated) {
        toast.success('Claude CLI is already authenticated')
        return
      }
    } finally {
      setCheckingClaudeAuth(false)
    }

    // Not authenticated, open login modal
    const escapedPath = `'${cliStatus.path.replace(/'/g, "'\\''")}'`
    openCliLoginModal('claude', escapedPath)
  }, [cliStatus?.path, openCliLoginModal, queryClient])

  const handleGhLogin = useCallback(async () => {
    if (!ghStatus?.path) return

    // First check if already authenticated
    setCheckingGhAuth(true)
    try {
      // Invalidate cache and refetch to get fresh status
      await queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.auth() })
      const result = await queryClient.fetchQuery<GhAuthStatus>({ queryKey: ghCliQueryKeys.auth() })

      if (result?.authenticated) {
        toast.success('GitHub CLI is already authenticated')
        return
      }
    } finally {
      setCheckingGhAuth(false)
    }

    // Not authenticated, open login modal
    const escapedPath = `'${ghStatus.path.replace(/'/g, "'\\''")}'`
    openCliLoginModal('gh', `${escapedPath} auth login`)
  }, [ghStatus?.path, openCliLoginModal, queryClient])

  const claudeStatusDescription = cliStatus?.installed
    ? cliStatus.path
    : 'Claude CLI is required for chat functionality'

  const ghStatusDescription = ghStatus?.installed
    ? ghStatus.path
    : 'GitHub CLI is required for GitHub integration'

  const handleGlabLogin = useCallback(async () => {
    if (!glabStatus?.path) return

    // First check if already authenticated
    setCheckingGlabAuth(true)
    try {
      // Invalidate cache and refetch to get fresh status
      await queryClient.invalidateQueries({ queryKey: glabCliQueryKeys.auth() })
      const result = await queryClient.fetchQuery<GlabAuthStatus>({ queryKey: glabCliQueryKeys.auth() })

      if (result?.authenticated) {
        toast.success('GitLab CLI is already authenticated')
        return
      }
    } finally {
      setCheckingGlabAuth(false)
    }

    // Not authenticated, open login modal
    const escapedPath = `'${glabStatus.path.replace(/'/g, "'\\''")}'`
    openCliLoginModal('glab', `${escapedPath} auth login`)
  }, [glabStatus?.path, openCliLoginModal, queryClient])

  const glabStatusDescription = glabStatus?.installed
    ? glabStatus.path
    : 'GitLab CLI is required for GitLab integration'

  const geminiStatusDescription = geminiStatus?.installed
    ? geminiStatus.path
    : 'Gemini CLI for Google AI'

  const codexStatusDescription = codexStatus?.installed
    ? codexStatus.path
    : 'Codex CLI for OpenAI'

  const handleCopyPath = useCallback((path: string | null | undefined) => {
    if (!path) return
    navigator.clipboard.writeText(path)
    toast.success('Path copied to clipboard')
  }, [])

  return (
    <div className="space-y-6">
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
              <Button
                variant="outline"
                size="sm"
                onClick={handleClaudeLogin}
              >
                Login
              </Button>
            )
          ) : (
            <span className="text-sm text-muted-foreground">Not installed</span>
          )
        }
      >
        <div className="space-y-4">
          <InlineField
            label={cliStatus?.installed ? 'Version' : 'Status'}
            description={
              cliStatus?.installed ? (
                <button
                  onClick={() => handleCopyPath(cliStatus.path)}
                  className="text-left hover:underline cursor-pointer"
                  title="Click to copy path"
                >
                  {claudeStatusDescription}
                </button>
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
              <Button
                variant="outline"
                size="sm"
                onClick={handleGhLogin}
              >
                Login
              </Button>
            )
          ) : (
            <span className="text-sm text-muted-foreground">Not installed</span>
          )
        }
      >
        <div className="space-y-4">
          <InlineField
            label={ghStatus?.installed ? 'Version' : 'Status'}
            description={
              ghStatus?.installed ? (
                <button
                  onClick={() => handleCopyPath(ghStatus.path)}
                  className="text-left hover:underline cursor-pointer"
                  title="Click to copy path"
                >
                  {ghStatusDescription}
                </button>
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

      <SettingsSection
        title="GitLab CLI"
        actions={
          glabStatus?.installed ? (
            checkingGlabAuth || isGlabAuthLoading ? (
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-3 animate-spin" />
                Checking...
              </span>
            ) : glabAuth?.authenticated ? (
              <span className="text-sm text-muted-foreground">
                {glabAuth.host ? `Logged in to ${glabAuth.host}` : 'Logged in'}
              </span>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={handleGlabLogin}
              >
                Login
              </Button>
            )
          ) : (
            <span className="text-sm text-muted-foreground">Not installed</span>
          )
        }
      >
        <div className="space-y-4">
          <InlineField
            label={glabStatus?.installed ? 'Version' : 'Status'}
            description={
              glabStatus?.installed ? (
                <button
                  onClick={() => handleCopyPath(glabStatus.path)}
                  className="text-left hover:underline cursor-pointer"
                  title="Click to copy path"
                >
                  {glabStatusDescription}
                </button>
              ) : (
                'Optional'
              )
            }
          >
            {isGlabLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : glabStatus?.installed ? (
              <Button
                variant="outline"
                className="w-40 justify-between"
                onClick={() => openCliUpdateModal('glab')}
              >
                {glabStatus.version ?? 'Installed'}
                <ChevronDown className="size-3" />
              </Button>
            ) : (
              <Button
                className="w-40"
                onClick={() => openCliUpdateModal('glab')}
              >
                Install
              </Button>
            )}
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Gemini CLI"
        actions={
          geminiStatus?.installed ? (
            checkingGeminiAuth || isGeminiAuthLoading ? (
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-3 animate-spin" />
                Checking...
              </span>
            ) : geminiAuth?.authenticated ? (
              <span className="text-sm text-muted-foreground">Logged in</span>
            ) : (
              <span className="text-sm text-muted-foreground">Not authenticated</span>
            )
          ) : (
            <span className="text-sm text-muted-foreground">Not installed</span>
          )
        }
      >
        <div className="space-y-4">
          <InlineField
            label={geminiStatus?.installed ? 'Version' : 'Status'}
            description={
              geminiStatus?.installed ? (
                <button
                  onClick={() => handleCopyPath(geminiStatus.path)}
                  className="text-left hover:underline cursor-pointer"
                  title="Click to copy path"
                >
                  {geminiStatusDescription}
                </button>
              ) : (
                'Optional - npm install -g @google/generative-ai-cli'
              )
            }
          >
            {isGeminiLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : geminiStatus?.installed ? (
              <Button
                variant="outline"
                className="w-40 justify-between"
                disabled
              >
                {geminiStatus.version ?? 'Installed'}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="w-40"
                onClick={() => {
                  navigator.clipboard.writeText('npm install -g @google/generative-ai-cli')
                  toast.success('Install command copied to clipboard')
                }}
              >
                Copy install cmd
              </Button>
            )}
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Codex CLI"
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
              <span className="text-sm text-muted-foreground">Not authenticated</span>
            )
          ) : (
            <span className="text-sm text-muted-foreground">Not installed</span>
          )
        }
      >
        <div className="space-y-4">
          <InlineField
            label={codexStatus?.installed ? 'Version' : 'Status'}
            description={
              codexStatus?.installed ? (
                <button
                  onClick={() => handleCopyPath(codexStatus.path)}
                  className="text-left hover:underline cursor-pointer"
                  title="Click to copy path"
                >
                  {codexStatusDescription}
                </button>
              ) : (
                'Optional - npm install -g @openai/codex'
              )
            }
          >
            {isCodexLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : codexStatus?.installed ? (
              <Button
                variant="outline"
                className="w-40 justify-between"
                disabled
              >
                {codexStatus.version ?? 'Installed'}
              </Button>
            ) : (
              <Button
                variant="outline"
                className="w-40"
                onClick={() => {
                  navigator.clipboard.writeText('npm install -g @openai/codex')
                  toast.success('Install command copied to clipboard')
                }}
              >
                Copy install cmd
              </Button>
            )}
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection title="Workspace">
        <div className="space-y-4">
          <InlineField
            label="Workspace folder"
            description={preferences?.workspace_folder || '~/jean (default)'}
          >
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="w-40"
                onClick={async () => {
                  const selected = await open({
                    directory: true,
                    multiple: false,
                    title: 'Select workspace folder',
                  })
                  if (selected && preferences) {
                    savePreferences.mutate({ ...preferences, workspace_folder: selected as string })
                    toast.success('Workspace folder updated')
                  }
                }}
              >
                {preferences?.workspace_folder ? 'Change' : 'Select folder'}
              </Button>
              {preferences?.workspace_folder && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (preferences) {
                      savePreferences.mutate({ ...preferences, workspace_folder: '' })
                      toast.success('Reset to default ~/jean')
                    }
                  }}
                >
                  Reset
                </Button>
              )}
            </div>
          </InlineField>

          <InlineField
            label="Default AI provider"
            description="AI CLI for new sessions (changing resets model)"
          >
            <Select
              value={preferences?.default_ai_provider ?? 'claude'}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {aiProviderOptions.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection title="Defaults">
        <div className="space-y-4">
          <InlineField
            label="Model"
            description={`Model for ${currentProvider === 'claude' ? 'Claude' : currentProvider === 'gemini' ? 'Gemini' : 'Codex'} AI assistance`}
          >
            <Select
              value={preferences?.selected_model ?? getDefaultModelForProvider(currentProvider)}
              onValueChange={handleModelChange}
            >
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {currentModelOptions.map(option => (
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
              <SelectTrigger className="w-40">
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

          <InlineField
            label="AI Language"
            description="Language for AI responses (e.g. French, 日本語)"
          >
            <Input
              className="w-40"
              placeholder="Default"
              value={preferences?.ai_language ?? ''}
              onChange={e => {
                if (preferences) {
                  savePreferences.mutate({
                    ...preferences,
                    ai_language: e.target.value,
                  })
                }
              }}
            />
          </InlineField>

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

          <InlineField label="Editor" description="App to open worktrees in">
            <Select
              value={preferences?.editor ?? 'vscode'}
              onValueChange={handleEditorChange}
            >
              <SelectTrigger className="w-40">
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

          <InlineField label="Terminal" description="App to open terminals in">
            <Select
              value={preferences?.terminal ?? 'terminal'}
              onValueChange={handleTerminalChange}
            >
              <SelectTrigger className="w-40">
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

          <InlineField
            label="Git poll interval"
            description="Check for branch updates when focused"
          >
            <Select
              value={String(preferences?.git_poll_interval ?? 60)}
              onValueChange={handleGitPollIntervalChange}
            >
              <SelectTrigger className="w-40">
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
              <SelectTrigger className="w-40">
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
              <SelectTrigger className="w-40">
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
              <SelectTrigger className="w-40">
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
            label="Auto-delete archives"
            description="Delete archived items older than this"
          >
            <Select
              value={String(preferences?.archive_retention_days ?? 30)}
              onValueChange={handleArchiveRetentionChange}
            >
              <SelectTrigger className="w-48">
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

      <AlertDialog open={showDeleteAllDialog} onOpenChange={setShowDeleteAllDialog}>
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
