import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type FC,
} from 'react'
import { invoke } from '@/lib/transport'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Loader2, Check, ChevronsUpDown, Play } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { BackendLabel } from '@/components/ui/backend-label'
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
  useAvailableCliVersions,
  claudeCliQueryKeys,
  useClaudePathDetection,
} from '@/services/claude-cli'
import {
  useGhCliStatus,
  useGhCliAuth,
  useGhPathDetection,
  useAvailableGhVersions,
  ghCliQueryKeys,
} from '@/services/gh-cli'
import {
  useCodexCliStatus,
  useCodexCliAuth,
  useAvailableCodexVersions,
  codexCliQueryKeys,
  useCodexPathDetection,
} from '@/services/codex-cli'
import {
  useCodeRabbitCliStatus,
  useCodeRabbitCliAuth,
  useCodeRabbitPathDetection,
  useAvailableCodeRabbitVersions,
  useInstallCodeRabbitCli,
  useUpdateCodeRabbitCli,
  coderabbitCliQueryKeys,
} from '@/services/coderabbit-cli'
import {
  useOpenCodeCliStatus,
  useOpenCodeCliAuth,
  useAvailableOpencodeModels,
  useAvailableOpencodeVersions,
  opencodeCliQueryKeys,
  useOpenCodePathDetection,
} from '@/services/opencode-cli'
import { useUIStore } from '@/store/ui-store'
import {
  getCursorInstallCommand,
  useCursorCliStatus,
  useCursorCliAuth,
  useCursorPathDetection,
  useAvailableCursorModels,
  cursorCliQueryKeys,
} from '@/services/cursor-cli'
import {
  useAvailablePiModels,
  usePiCliStatus,
  usePiCliAuth,
  usePiPathDetection,
  piCliQueryKeys,
} from '@/services/pi-cli'
import {
  useAvailableCommandCodeModels,
  useCommandCodeCliStatus,
  useCommandCodeCliAuth,
  useCommandCodePathDetection,
  commandcodeCliQueryKeys,
} from '@/services/commandcode-cli'
import {
  useGrokCliStatus,
  useGrokCliAuth,
  useGrokPathDetection,
  useAvailableGrokModels,
  grokCliQueryKeys,
} from '@/services/grok-cli'
import {
  useKimiCliStatus,
  useKimiCliAuth,
  useKimiPathDetection,
  useAvailableKimiModels,
  kimiCliQueryKeys,
} from '@/services/kimi-cli'
import type { ClaudeAuthStatus } from '@/types/claude-cli'
import type { GhAuthStatus } from '@/types/gh-cli'
import type { CodexAuthStatus } from '@/types/codex-cli'
import type { CodeRabbitAuthStatus } from '@/types/coderabbit-cli'
import type { OpenCodeAuthStatus } from '@/types/opencode-cli'
import type { CursorAuthStatus } from '@/types/cursor-cli'
import type { PiAuthStatus } from '@/types/pi-cli'
import type { CommandCodeAuthStatus } from '@/types/commandcode-cli'
import type { GrokAuthStatus } from '@/types/grok-cli'
import type { KimiAuthStatus } from '@/types/kimi-cli'
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
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  getCatalogDefaultModelOptions,
  getCatalogModelOptions,
  getCatalogModelReasoning,
  useModelCatalog,
} from '@/services/model-catalog'
import type { AppPreferences } from '@/types/preferences'
import {
  effortLevelOptions,
  codexReasoningOptions,
  codexModelVerbosityOptions,
  grokReasoningOptions,
  backendOptions,
  getTerminalOptions,
  getEditorOptions,
  gitPollIntervalOptions,
  remotePollIntervalOptions,
  archiveRetentionOptions,
  removalBehaviorOptions,
  notificationSoundOptions,
  type RemovalBehavior,
  type ClaudeModel,
  type CodexModel,
  type CodexGoalExecutionMode,
  type CodexReasoningEffort,
  type CodexModelVerbosity,
  type GrokReasoningEffort,
  type CursorModel,
  type PiModel,
  type GrokModel,
  type KimiModel,
  type CliBackend,
  type TerminalApp,
  type EditorApp,
  type NotificationSound,
  openInDefaultOptions,
  type OpenInDefault,
  newSessionKindOptions,
  type NewSessionKind,
} from '@/types/preferences'
import {
  COMMANDCODE_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  GROK_MODEL_OPTIONS,
  KIMI_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_MODEL_OPTIONS,
  KIMI_EFFORT_LEVEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import {
  formatCursorModelLabel,
  formatOpencodeModelLabel,
  formatPiModelLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import { playNotificationSound } from '@/lib/sounds'
import { CLIENT_BUILD_INFO } from '@/lib/build-info'
import type { ThinkingLevel, EffortLevel } from '@/types/chat'
import { hasBackend, isNativeApp } from '@/lib/environment'
import { isWindows, openExternal } from '@/lib/platform'
import { isNewerVersion } from '@/lib/version-utils'
import { cn } from '@/lib/utils'
import { copyToClipboard } from '@/lib/clipboard'
import {
  setGitPollInterval,
  setRemotePollInterval,
} from '@/services/git-status'
import { getPathUpdateAction } from '@/lib/cli-update'
import { BackendPaneHeader, SettingsSection } from '../SettingsSection'
import { AiLanguageField } from './AiLanguageField'
import {
  resolveDefaultModelForBackend,
  resolvePiDefaultModel,
} from '@/lib/session-defaults'

interface CleanupResult {
  deleted_worktrees: number
  deleted_sessions: number
  deleted_orphan_indexes?: number
}

const InlineField: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="settings-inline-field flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-56 sm:shrink-0 lg:w-72">
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

type PreferencesPaneScope =
  | 'general'
  | 'claude'
  | 'codex'
  | 'opencode'
  | 'cursor'
  | 'pi'
  | 'commandcode'
  | 'grok'
  | 'kimi'
  | 'github'
  | 'coderabbit'

const backendPaneMeta = {
  claude: {
    description:
      'Configure the Claude CLI, default model, and native Claude session behavior.',
  },
  codex: {
    description:
      'Configure the Codex CLI, default model, reasoning, and native Codex session behavior.',
  },
  opencode: {
    description:
      'Configure the OpenCode CLI, default model, and native OpenCode session behavior.',
  },
  cursor: {
    description:
      'Configure the Cursor CLI, default model, and native Cursor session behavior.',
  },
  pi: {
    description:
      'Configure the PI CLI, active provider model, and native PI session behavior.',
  },
  commandcode: {
    description:
      'Configure the Command Code CLI and default model for native sessions.',
  },
  grok: {
    description:
      'Configure the Grok CLI, default model, effort level, and native ACP session behavior.',
  },
  kimi: {
    description:
      'Configure the Kimi Code CLI, default model, and native ACP session behavior.',
  },
} satisfies Partial<
  Record<PreferencesPaneScope, { description: React.ReactNode }>
>

export const GeneralPane: React.FC<{ scope?: PreferencesPaneScope }> = ({
  scope = 'general',
}) => {
  const isGeneralScope = scope === 'general'
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const { data: modelCatalog } = useModelCatalog()
  const codexReasoning = getCatalogModelReasoning(
    modelCatalog,
    'codex',
    preferences?.selected_codex_model ?? 'gpt-5.6-sol'
  )
  const selectedCodexReasoningOptions =
    codexReasoning?.type === 'effort'
      ? codexReasoning.levels
      : codexReasoningOptions
  const grokReasoning = getCatalogModelReasoning(
    modelCatalog,
    'grok',
    preferences?.selected_grok_model ?? 'grok/grok-4.5'
  )
  const selectedGrokReasoningOptions =
    grokReasoning?.type === 'effort'
      ? grokReasoning.levels
      : grokReasoningOptions
  const claudeReasoning = getCatalogModelReasoning(
    modelCatalog,
    'claude',
    preferences?.selected_model ?? 'claude-opus-4-8[1m]'
  )
  const patchPreferences = usePatchPreferences()
  const isWebAccessView = !isNativeApp()
  const webAccessSoundsEnabled = preferences?.web_access_sounds_enabled ?? true
  const soundsEnabledInCurrentView = !isWebAccessView || webAccessSoundsEnabled
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteCliTarget, setDeleteCliTarget] = useState<
    | 'claude'
    | 'codex'
    | 'opencode'
    | 'pi'
    | 'gh'
    | 'coderabbit'
    | 'commandcode'
    | 'grok'
    | 'kimi'
    | null
  >(null)
  const [isDeletingCli, setIsDeletingCli] = useState(false)

  const remoteClaudeModelOptions = useMemo(
    () => getCatalogModelOptions(modelCatalog, 'claude'),
    [modelCatalog]
  )
  const remoteCodexDefaultModelOptions = useMemo(
    () => getCatalogDefaultModelOptions(modelCatalog, 'codex'),
    [modelCatalog]
  )

  // PATH detection
  const { data: pathDetection } = useClaudePathDetection()
  const { data: codexPathDetection } = useCodexPathDetection()
  const { data: opencodePathDetection } = useOpenCodePathDetection()
  const { data: ghPathDetection } = useGhPathDetection()
  const { data: coderabbitPathDetection } = useCodeRabbitPathDetection()
  const { data: cursorPathDetection } = useCursorPathDetection()
  const { data: piPathDetection } = usePiPathDetection()
  const { data: commandcodePathDetection } = useCommandCodePathDetection()
  const { data: grokPathDetection } = useGrokPathDetection()
  const { data: kimiPathDetection } = useKimiPathDetection()

  // CLI status hooks
  const { data: cliStatus, isLoading: isCliLoading } = useClaudeCliStatus()
  const isPathSource = preferences?.claude_cli_source === 'path'
  const { data: claudeVersions, isLoading: isClaudeVersionsLoading } =
    useAvailableCliVersions({ enabled: isPathSource && !!cliStatus?.installed })
  const claudeLatestStable = claudeVersions?.find(v => !v.prerelease)
  const claudeHasUpdate =
    !!cliStatus?.version &&
    !!claudeLatestStable &&
    isNewerVersion(claudeLatestStable.version, cliStatus.version)
  const { data: ghStatus, isLoading: isGhLoading } = useGhCliStatus()
  const { data: cursorStatus, isLoading: isCursorLoading } =
    useCursorCliStatus()
  const { data: piStatus, isLoading: isPiLoading } = usePiCliStatus()
  const { data: commandcodeStatus, isLoading: isCommandCodeLoading } =
    useCommandCodeCliStatus()
  const { data: grokStatus, isLoading: isGrokLoading } = useGrokCliStatus()
  const { data: kimiStatus, isLoading: isKimiLoading } = useKimiCliStatus()
  const isGhPathSource = preferences?.gh_cli_source === 'path'
  const { data: ghVersions, isLoading: isGhVersionsLoading } =
    useAvailableGhVersions({ enabled: isGhPathSource && !!ghStatus?.installed })
  const ghLatestStable = ghVersions?.find(v => !v.prerelease)
  const ghHasUpdate =
    !!ghStatus?.version &&
    !!ghLatestStable &&
    isNewerVersion(ghLatestStable.version, ghStatus.version)
  const { data: codexStatus, isLoading: isCodexLoading } = useCodexCliStatus()
  const isCodexPathSource = preferences?.codex_cli_source === 'path'
  const { data: codexVersions, isLoading: isCodexVersionsLoading } =
    useAvailableCodexVersions({
      enabled: isCodexPathSource && !!codexStatus?.installed,
    })
  const codexLatestStable = codexVersions?.find(v => !v.prerelease)
  const codexHasUpdate =
    !!codexStatus?.version &&
    !!codexLatestStable &&
    isNewerVersion(codexLatestStable.version, codexStatus.version)
  const { data: coderabbitStatus, isLoading: isCodeRabbitLoading } =
    useCodeRabbitCliStatus()
  const isCodeRabbitPathSource = preferences?.coderabbit_cli_source === 'path'
  const { data: coderabbitVersions, isLoading: isCodeRabbitVersionsLoading } =
    useAvailableCodeRabbitVersions({
      enabled: !!coderabbitStatus?.installed,
    })
  const coderabbitLatestStable = coderabbitVersions?.find(v => !v.prerelease)
  const coderabbitHasUpdate =
    !!coderabbitStatus?.version &&
    !!coderabbitLatestStable &&
    isNewerVersion(coderabbitLatestStable.version, coderabbitStatus.version)
  const installCodeRabbitCli = useInstallCodeRabbitCli()
  const updateCodeRabbitCli = useUpdateCodeRabbitCli()
  const { data: opencodeStatus, isLoading: isOpenCodeLoading } =
    useOpenCodeCliStatus()
  const isOpencodePathSource = preferences?.opencode_cli_source === 'path'
  const { data: opencodeVersions, isLoading: isOpencodeVersionsLoading } =
    useAvailableOpencodeVersions({
      enabled: isOpencodePathSource && !!opencodeStatus?.installed,
    })
  const opencodeLatestStable = opencodeVersions?.find(v => !v.prerelease)
  const opencodeHasUpdate =
    !!opencodeStatus?.version &&
    !!opencodeLatestStable &&
    isNewerVersion(opencodeLatestStable.version, opencodeStatus.version)

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
  const { data: coderabbitAuth, isLoading: isCodeRabbitAuthLoading } =
    useCodeRabbitCliAuth({
      enabled: !!coderabbitStatus?.installed,
    })
  const { data: opencodeAuth, isLoading: isOpenCodeAuthLoading } =
    useOpenCodeCliAuth({
      enabled: !!opencodeStatus?.installed,
    })
  const { data: cursorAuth, isLoading: isCursorAuthLoading } = useCursorCliAuth(
    {
      enabled: !!cursorStatus?.installed,
    }
  )
  const { data: piAuth, isLoading: isPiAuthLoading } = usePiCliAuth({
    enabled: !!piStatus?.installed,
  })
  const { data: commandcodeAuth, isLoading: isCommandCodeAuthLoading } =
    useCommandCodeCliAuth({
      enabled: !!commandcodeStatus?.installed,
    })
  const { data: grokAuth, isLoading: isGrokAuthLoading } = useGrokCliAuth({
    enabled: !!grokStatus?.installed,
  })
  const { data: kimiAuth, isLoading: isKimiAuthLoading } = useKimiCliAuth({
    enabled: !!kimiStatus?.installed,
  })
  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: !!opencodeStatus?.installed,
  })
  const { data: availableCursorModels } = useAvailableCursorModels({
    enabled: !!cursorStatus?.installed,
  })
  const { data: availablePiModels } = useAvailablePiModels({
    enabled: !!piStatus?.installed,
  })
  const { data: availableCommandCodeModels } = useAvailableCommandCodeModels({
    enabled: !!commandcodeStatus?.installed,
  })
  const { data: availableGrokModels } = useAvailableGrokModels({
    enabled: !!grokStatus?.installed,
  })
  const { data: availableKimiModels } = useAvailableKimiModels({
    enabled: !!kimiStatus?.installed,
  })

  // Re-check CLI status when the source preference changes (handles initial load
  // with source already set to "path" and any timing issues with onSuccess invalidation)
  const prevSources = useRef({
    claude: preferences?.claude_cli_source,
    gh: preferences?.gh_cli_source,
    codex: preferences?.codex_cli_source,
    opencode: preferences?.opencode_cli_source,
    pi: preferences?.pi_cli_source,
    grok: preferences?.grok_cli_source,
    kimi: preferences?.kimi_cli_source,
    coderabbit: preferences?.coderabbit_cli_source,
    commandcode: preferences?.commandcode_cli_source,
  })
  useEffect(() => {
    const cur = {
      claude: preferences?.claude_cli_source,
      gh: preferences?.gh_cli_source,
      codex: preferences?.codex_cli_source,
      opencode: preferences?.opencode_cli_source,
      pi: preferences?.pi_cli_source,
      grok: preferences?.grok_cli_source,
      kimi: preferences?.kimi_cli_source,
      coderabbit: preferences?.coderabbit_cli_source,
      commandcode: preferences?.commandcode_cli_source,
    }
    if (cur.claude !== prevSources.current.claude) {
      queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.status() })
    }
    if (cur.gh !== prevSources.current.gh) {
      queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.status() })
    }
    if (cur.codex !== prevSources.current.codex) {
      queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.status() })
    }
    if (cur.opencode !== prevSources.current.opencode) {
      queryClient.invalidateQueries({ queryKey: opencodeCliQueryKeys.status() })
    }
    if (cur.grok !== prevSources.current.grok) {
      queryClient.invalidateQueries({ queryKey: grokCliQueryKeys.status() })
    }
    if (cur.kimi !== prevSources.current.kimi) {
      queryClient.invalidateQueries({ queryKey: kimiCliQueryKeys.status() })
    }
    if (cur.coderabbit !== prevSources.current.coderabbit) {
      queryClient.invalidateQueries({
        queryKey: coderabbitCliQueryKeys.status(),
      })
    }
    if (cur.pi !== prevSources.current.pi) {
      queryClient.invalidateQueries({ queryKey: piCliQueryKeys.status() })
    }
    if (cur.commandcode !== prevSources.current.commandcode) {
      queryClient.invalidateQueries({
        queryKey: commandcodeCliQueryKeys.status(),
      })
    }
    prevSources.current = cur
  }, [
    preferences?.claude_cli_source,
    preferences?.gh_cli_source,
    preferences?.codex_cli_source,
    preferences?.opencode_cli_source,
    preferences?.pi_cli_source,
    preferences?.grok_cli_source,
    preferences?.kimi_cli_source,
    preferences?.coderabbit_cli_source,
    preferences?.commandcode_cli_source,
    queryClient,
  ])

  useEffect(() => {
    if (!preferences?.build_backend) return
    const backend = preferences.build_backend
    if (backend === 'cursor' && !cursorStatus?.installed) {
      patchPreferences.mutate({
        build_backend: null,
        build_model: null,
        build_thinking_level: null,
      })
    }
  }, [patchPreferences, preferences?.build_backend, cursorStatus?.installed])

  // Track which auth check is in progress (for manual refresh)
  const [checkingClaudeAuth, setCheckingClaudeAuth] = useState(false)
  const [checkingGhAuth, setCheckingGhAuth] = useState(false)
  const [checkingCodexAuth, setCheckingCodexAuth] = useState(false)
  const [checkingCodeRabbitAuth, setCheckingCodeRabbitAuth] = useState(false)
  const [checkingOpenCodeAuth, setCheckingOpenCodeAuth] = useState(false)
  const [checkingCursorAuth, setCheckingCursorAuth] = useState(false)
  const [checkingPiAuth, setCheckingPiAuth] = useState(false)
  const [checkingCommandCodeAuth, setCheckingCommandCodeAuth] = useState(false)
  const [checkingGrokAuth, setCheckingGrokAuth] = useState(false)
  const [checkingKimiAuth, setCheckingKimiAuth] = useState(false)
  const [openCodeModelPopoverOpen, setOpenCodeModelPopoverOpen] =
    useState(false)
  const [cursorModelPopoverOpen, setCursorModelPopoverOpen] = useState(false)
  const [piModelPopoverOpen, setPiModelPopoverOpen] = useState(false)
  const [buildModelPopoverOpen, setBuildModelPopoverOpen] = useState(false)
  const [yoloModelPopoverOpen, setYoloModelPopoverOpen] = useState(false)

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
      if ((result.deleted_orphan_indexes ?? 0) > 0) {
        parts.push(
          `${result.deleted_orphan_indexes} orphaned session index file${result.deleted_orphan_indexes === 1 ? '' : 's'}`
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
      patchPreferences.mutate({ selected_model: value })
    }
  }

  const handleThinkingLevelChange = (value: ThinkingLevel) => {
    if (preferences) {
      patchPreferences.mutate({ thinking_level: value })
    }
  }

  const handleEffortLevelChange = (value: EffortLevel) => {
    if (preferences) {
      patchPreferences.mutate({ default_effort_level: value })
    }
  }

  const handleBuildModelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        build_model: value === 'default' ? null : value,
      })
    }
  }

  const handleBuildBackendChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        build_backend: value === 'default' ? null : value,
        // Reset model and thinking/effort when backend changes
        build_model: null,
        build_thinking_level: null,
        build_effort_level: null,
      })
    }
  }

  const handleYoloModelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        yolo_model: value === 'default' ? null : value,
      })
    }
  }

  const handleYoloBackendChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        yolo_backend: value === 'default' ? null : value,
        // Reset model and thinking/effort when backend changes
        yolo_model: null,
        yolo_thinking_level: null,
        yolo_effort_level: null,
      })
    }
  }

  const handleBuildThinkingLevelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        build_thinking_level: value === 'default' ? null : value,
      })
    }
  }

  const handleYoloThinkingLevelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        yolo_thinking_level: value === 'default' ? null : value,
      })
    }
  }

  const handleBuildEffortLevelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        build_effort_level: value === 'default' ? null : value,
      })
    }
  }

  const handleYoloEffortLevelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({
        yolo_effort_level: value === 'default' ? null : value,
      })
    }
  }

  const handleClaudeSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { claude_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleCodexSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { codex_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: codexCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleCodeRabbitSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { coderabbit_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({
              queryKey: coderabbitCliQueryKeys.all,
            })
          },
        }
      )
    }
  }

  const handleOpencodeSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { opencode_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({
              queryKey: opencodeCliQueryKeys.all,
            })
          },
        }
      )
    }
  }

  const handlePiSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { pi_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: piCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleCommandCodeSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { commandcode_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({
              queryKey: commandcodeCliQueryKeys.all,
            })
          },
        }
      )
    }
  }

  const handleGrokSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { grok_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: grokCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleKimiSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { kimi_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: kimiCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleConfirmDeleteCli = async () => {
    if (!deleteCliTarget) return
    const target = deleteCliTarget
    const labelMap = {
      claude: { name: 'Claude CLI', cmd: 'uninstall_claude_cli' as const },
      codex: { name: 'Codex CLI', cmd: 'uninstall_codex_cli' as const },
      opencode: {
        name: 'OpenCode CLI',
        cmd: 'uninstall_opencode_cli' as const,
      },
      pi: { name: 'PI CLI', cmd: 'uninstall_pi_cli' as const },
      gh: { name: 'GitHub CLI', cmd: 'uninstall_gh_cli' as const },
      coderabbit: {
        name: 'CodeRabbit CLI',
        cmd: 'uninstall_coderabbit_cli' as const,
      },
      commandcode: {
        name: 'Command Code CLI',
        cmd: 'uninstall_commandcode_cli' as const,
      },
      grok: { name: 'Grok CLI', cmd: 'uninstall_grok_cli' as const },
      kimi: { name: 'Kimi Code CLI', cmd: 'uninstall_kimi_cli' as const },
    }
    const { name, cmd } = labelMap[target]
    setIsDeletingCli(true)
    const toastId = toast.loading(`Removing Jean-managed ${name}...`)
    try {
      await invoke(cmd)
      const sourceKey =
        target === 'claude'
          ? 'claude_cli_source'
          : target === 'codex'
            ? 'codex_cli_source'
            : target === 'opencode'
              ? 'opencode_cli_source'
              : target === 'pi'
                ? 'pi_cli_source'
                : target === 'gh'
                  ? 'gh_cli_source'
                  : target === 'commandcode'
                    ? 'commandcode_cli_source'
                    : target === 'grok'
                      ? 'grok_cli_source'
                      : target === 'kimi'
                        ? 'kimi_cli_source'
                        : 'coderabbit_cli_source'
      await new Promise<void>((resolve, reject) => {
        patchPreferences.mutate(
          { [sourceKey]: 'path' } as Partial<AppPreferences>,
          {
            onSuccess: () => resolve(),
            onError: err => reject(err),
          }
        )
      })
      const queryKeys =
        target === 'claude'
          ? claudeCliQueryKeys.all
          : target === 'codex'
            ? codexCliQueryKeys.all
            : target === 'opencode'
              ? opencodeCliQueryKeys.all
              : target === 'pi'
                ? piCliQueryKeys.all
                : target === 'gh'
                  ? ghCliQueryKeys.all
                  : target === 'commandcode'
                    ? commandcodeCliQueryKeys.all
                    : target === 'grok'
                      ? grokCliQueryKeys.all
                      : target === 'kimi'
                        ? kimiCliQueryKeys.all
                        : coderabbitCliQueryKeys.all
      queryClient.invalidateQueries({ queryKey: queryKeys })
      const pathFound =
        target === 'claude'
          ? pathDetection?.found
          : target === 'codex'
            ? codexPathDetection?.found
            : target === 'opencode'
              ? opencodePathDetection?.found
              : target === 'pi'
                ? piPathDetection?.found
                : target === 'gh'
                  ? ghPathDetection?.found
                  : target === 'commandcode'
                    ? commandcodePathDetection?.found
                    : target === 'grok'
                      ? grokPathDetection?.found
                      : target === 'kimi'
                        ? kimiPathDetection?.found
                        : coderabbitPathDetection?.found
      if (pathFound) {
        toast.success(`Jean-managed ${name} removed. Using system PATH.`, {
          id: toastId,
        })
      } else {
        toast.warning(
          `Jean-managed ${name} removed. No system PATH version found — ${name} unavailable until reinstalled.`,
          { id: toastId }
        )
      }
    } catch (err) {
      toast.error(`Failed to remove ${name}: ${err}`, { id: toastId })
    } finally {
      setIsDeletingCli(false)
      setDeleteCliTarget(null)
    }
  }

  const handleGhSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { gh_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.all })
          },
        }
      )
    }
  }

  const handleBackendChange = (value: CliBackend) => {
    if (preferences) {
      patchPreferences.mutate({ default_backend: value })
    }
  }

  // If stored default_backend isn't installed, fall back to the first installed one
  const stored = preferences?.default_backend ?? 'claude'
  const claudeInstalled = cliStatus?.installed
  const codexInstalled = codexStatus?.installed
  const opencodeInstalled = opencodeStatus?.installed
  const cursorInstalled = cursorStatus?.installed
  const piInstalled = piStatus?.installed
  const commandcodeInstalled = commandcodeStatus?.installed
  const grokInstalled = grokStatus?.installed
  const kimiInstalled = kimiStatus?.installed
  const installedBackendOptions = useMemo(
    () =>
      backendOptions.filter(option =>
        option.value === 'claude'
          ? cliStatus?.installed
          : option.value === 'codex'
            ? codexStatus?.installed
            : option.value === 'opencode'
              ? opencodeStatus?.installed
              : option.value === 'cursor'
                ? cursorStatus?.installed
                : option.value === 'pi'
                  ? piStatus?.installed
                  : option.value === 'commandcode'
                    ? commandcodeStatus?.installed
                    : option.value === 'grok'
                      ? grokStatus?.installed
                      : option.value === 'kimi'
                        ? kimiStatus?.installed
                        : false
      ),
    [
      cliStatus?.installed,
      codexStatus?.installed,
      opencodeStatus?.installed,
      cursorStatus?.installed,
      piStatus?.installed,
      commandcodeStatus?.installed,
      grokStatus?.installed,
      kimiStatus?.installed,
    ]
  )

  const effectiveBackend = useMemo(() => {
    const installed: Record<string, boolean | undefined> = {
      claude: claudeInstalled,
      codex: codexInstalled,
      opencode: opencodeInstalled,
      cursor: cursorInstalled,
      pi: piInstalled,
      commandcode: commandcodeInstalled,
      grok: grokInstalled,
      kimi: kimiInstalled,
    }
    if (installed[stored]) return stored
    const first = installedBackendOptions[0]
    return first?.value ?? stored
  }, [
    stored,
    claudeInstalled,
    codexInstalled,
    opencodeInstalled,
    cursorInstalled,
    piInstalled,
    commandcodeInstalled,
    grokInstalled,
    kimiInstalled,
    installedBackendOptions,
  ])

  const handleCodexModelChange = (value: CodexModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_codex_model: value })
    }
  }

  const handleCodexReasoningChange = (value: CodexReasoningEffort) => {
    if (preferences) {
      patchPreferences.mutate({
        default_codex_reasoning_effort: value,
      })
    }
  }

  const handleCodexModelVerbosityChange = (value: CodexModelVerbosity) => {
    if (preferences) {
      patchPreferences.mutate({
        default_codex_model_verbosity: value,
      })
    }
  }

  const handleCodexGoalExecutionModeChange = (
    value: CodexGoalExecutionMode
  ) => {
    if (preferences) {
      patchPreferences.mutate({
        codex_goal_execution_mode: value,
      })
    }
  }

  const handleOpenCodeModelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({ selected_opencode_model: value })
    }
  }

  const handleCursorModelChange = (value: CursorModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_cursor_model: value })
    }
  }

  const handlePiModelChange = (value: PiModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_pi_model: value })
    }
  }

  const handleCommandCodeModelChange = (value: string) => {
    if (preferences) {
      patchPreferences.mutate({ selected_commandcode_model: value })
    }
  }
  const handleGrokModelChange = (value: GrokModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_grok_model: value })
    }
  }

  const handleGrokReasoningChange = (value: GrokReasoningEffort) => {
    if (preferences) {
      patchPreferences.mutate({
        default_grok_reasoning_effort: value,
      })
    }
  }

  const handleKimiModelChange = (value: KimiModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_kimi_model: value })
    }
  }

  const selectedOpenCodeModel =
    preferences?.selected_opencode_model ?? 'opencode/gpt-5.6-sol'
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
  const selectedCursorModel =
    preferences?.selected_cursor_model ?? 'cursor/auto'
  const cursorModelOptions: { value: CursorModel; label: string }[] = (
    availableCursorModels?.length
      ? availableCursorModels.map(model => ({
          value: `cursor/${model.id}` as CursorModel,
          label: model.label || formatCursorModelLabel(model.id),
        }))
      : (CURSOR_MODEL_OPTIONS as { value: CursorModel; label: string }[])
  ).map(option => ({
    value: option.value,
    label: option.label || formatCursorModelLabel(option.value),
  }))
  const selectedCursorModelLabel =
    cursorModelOptions.find(option => option.value === selectedCursorModel)
      ?.label ?? formatCursorModelLabel(selectedCursorModel)
  const selectedGrokModel = preferences?.selected_grok_model ?? 'grok/grok-4.5'
  const grokModelOptions: { value: GrokModel; label: string }[] = (
    availableGrokModels?.length
      ? availableGrokModels.map(model => ({
          value: `grok/${model.id}` as GrokModel,
          label: model.label,
        }))
      : (GROK_MODEL_OPTIONS as { value: GrokModel; label: string }[])
  ).map(option => ({
    value: option.value,
    label: option.label,
  }))
  const selectedGrokModelLabel =
    grokModelOptions.find(option => option.value === selectedGrokModel)
      ?.label ?? selectedGrokModel.replace(/^grok\//, '')
  const selectedKimiModel = preferences?.selected_kimi_model ?? 'kimi/default'
  const kimiModelOptions: { value: KimiModel; label: string }[] = [
    ...(KIMI_MODEL_OPTIONS as { value: KimiModel; label: string }[]),
    ...(availableKimiModels ?? [])
      .filter(model => model.id !== 'default')
      .map(model => ({
        value: `kimi/${model.id}` as KimiModel,
        label: model.isDefault ? `${model.label} (default)` : model.label,
      })),
  ]
  const selectedKimiModelLabel =
    kimiModelOptions.find(option => option.value === selectedKimiModel)
      ?.label ?? selectedKimiModel.replace(/^kimi\//, '')
  const buildBackendOptions = backendOptions
  const effectiveBuildBackend = (preferences?.build_backend ??
    effectiveBackend) as CliBackend
  const effectiveYoloBackend = (preferences?.yolo_backend ??
    effectiveBackend) as CliBackend
  const piModelOptions: {
    value: PiModel
    label: string
    is_default?: boolean
  }[] = (
    availablePiModels?.length
      ? availablePiModels.map(model => ({
          value: `pi/${model.id}` as PiModel,
          label: model.label || formatPiModelLabel(model.id),
          is_default: model.is_default,
        }))
      : (PI_MODEL_OPTIONS as {
          value: PiModel
          label: string
          is_default?: boolean
        }[])
  ).map(option => ({
    value: option.value,
    label: option.label || formatPiModelLabel(option.value),
    is_default: option.is_default,
  }))
  const selectedPiModel = resolvePiDefaultModel(
    preferences?.selected_pi_model,
    piModelOptions
  ) as PiModel
  const selectedPiModelLabel =
    piModelOptions.find(option => option.value === selectedPiModel)?.label ??
    formatPiModelLabel(selectedPiModel)
  const buildModel =
    preferences?.build_model ??
    resolveDefaultModelForBackend(
      effectiveBuildBackend,
      preferences,
      piModelOptions
    )
  const yoloModel =
    preferences?.yolo_model ??
    resolveDefaultModelForBackend(
      effectiveYoloBackend,
      preferences,
      piModelOptions
    )
  const buildReasoning =
    getCatalogModelReasoning(modelCatalog, effectiveBuildBackend, buildModel) ??
    (['codex', 'opencode', 'pi', 'grok', 'kimi'].includes(effectiveBuildBackend)
      ? {
          type: 'effort' as const,
          default: 'high',
          levels:
            effectiveBuildBackend === 'codex'
              ? codexReasoningOptions
              : effectiveBuildBackend === 'kimi'
                ? KIMI_EFFORT_LEVEL_OPTIONS
                : effortLevelOptions,
        }
      : null)
  const yoloReasoning =
    getCatalogModelReasoning(modelCatalog, effectiveYoloBackend, yoloModel) ??
    (['codex', 'opencode', 'pi', 'grok', 'kimi'].includes(effectiveYoloBackend)
      ? {
          type: 'effort' as const,
          default: 'high',
          levels:
            effectiveYoloBackend === 'codex'
              ? codexReasoningOptions
              : effectiveYoloBackend === 'kimi'
                ? KIMI_EFFORT_LEVEL_OPTIONS
                : effortLevelOptions,
        }
      : null)
  const piAuthMessage = piAuth?.error

  const selectedCommandCodeModel =
    preferences?.selected_commandcode_model ?? 'commandcode/default'
  const commandCodeModelOptions = availableCommandCodeModels?.length
    ? [
        { value: 'commandcode/default', label: 'CLI default (no --model)' },
        ...availableCommandCodeModels.map(model => ({
          value: `commandcode/${model.id}`,
          label: model.label,
        })),
      ]
    : COMMANDCODE_MODEL_OPTIONS
  const cursorAuthMessage = cursorAuth?.timed_out
    ? 'Auth check timed out. Try again or run login manually.'
    : cursorAuth?.error
  const commandCodeAuthMessage = commandcodeAuth?.timedOut
    ? 'Auth check timed out. Try again or run login manually.'
    : commandcodeAuth?.error
  const grokAuthMessage = grokAuth?.timedOut
    ? 'Auth check timed out. Try again or run `grok login` manually.'
    : grokAuth?.error
  const kimiAuthMessage = kimiAuth?.timedOut
    ? 'Auth check timed out. Try again or run `kimi login` manually.'
    : kimiAuth?.error

  const handleCodexMultiAgentToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        codex_multi_agent_enabled: enabled,
      })
    }
  }

  const handleCodexAutoSteerToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        codex_auto_steer_enabled: enabled,
      })
    }
  }

  const handleOpenCodeAutoSteerToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        opencode_auto_steer_enabled: enabled,
      })
    }
  }

  const handlePiAutoSteerToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        pi_auto_steer_enabled: enabled,
      })
    }
  }

  const handleGrokAutoSteerToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        grok_auto_steer_enabled: enabled,
      })
    }
  }

  const handleKimiAutoSteerToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        kimi_auto_steer_enabled: enabled,
      })
    }
  }

  const handleCodexMaxThreadsChange = (value: string) => {
    if (preferences) {
      const num = Math.max(1, Math.min(8, parseInt(value, 10) || 3))
      patchPreferences.mutate({
        codex_max_agent_threads: num,
      })
    }
  }

  const handleTerminalChange = (value: TerminalApp) => {
    if (preferences) {
      patchPreferences.mutate({ terminal: value })
    }
  }

  const handleEditorChange = (value: EditorApp) => {
    if (preferences) {
      patchPreferences.mutate({ editor: value })
    }
  }

  const handleOpenInChange = (value: OpenInDefault) => {
    if (preferences) {
      patchPreferences.mutate({ open_in: value })
    }
  }

  const handleNewSessionKindChange = (value: NewSessionKind) => {
    if (preferences) {
      patchPreferences.mutate({ default_new_session_kind: value })
    }
  }

  const handleAutoBranchNamingChange = (checked: boolean) => {
    if (preferences) {
      patchPreferences.mutate({ auto_branch_naming: checked })
    }
  }

  const handleAutoSessionNamingChange = (checked: boolean) => {
    if (preferences) {
      patchPreferences.mutate({ auto_session_naming: checked })
    }
  }

  const handleGitPollIntervalChange = (value: string) => {
    const seconds = parseInt(value, 10)
    if (preferences && !isNaN(seconds)) {
      patchPreferences.mutate({ git_poll_interval: seconds })
      // Also update the backend immediately
      setGitPollInterval(seconds)
    }
  }

  const handleRemotePollIntervalChange = (value: string) => {
    const seconds = parseInt(value, 10)
    if (preferences && !isNaN(seconds)) {
      patchPreferences.mutate({ remote_poll_interval: seconds })
      // Also update the backend immediately
      setRemotePollInterval(seconds)
    }
  }

  const handleArchiveRetentionChange = (value: string) => {
    const days = parseInt(value, 10)
    if (preferences && !isNaN(days)) {
      patchPreferences.mutate({ archive_retention_days: days })
    }
  }

  const handleWaitingSoundChange = (value: NotificationSound) => {
    if (preferences) {
      patchPreferences.mutate({ waiting_sound: value })
      // Play preview of the selected sound
      playNotificationSound(value, {
        webAccessSoundsEnabled,
      })
    }
  }

  const handleReviewSoundChange = (value: NotificationSound) => {
    if (preferences) {
      patchPreferences.mutate({ review_sound: value })
      // Play preview of the selected sound
      playNotificationSound(value, {
        webAccessSoundsEnabled,
      })
    }
  }

  const handleWebAccessSoundsEnabledChange = (checked: boolean | string) => {
    if (preferences) {
      patchPreferences.mutate({
        web_access_sounds_enabled: checked === true,
      })
    }
  }

  const handleDesktopNotificationsEnabledChange = (checked: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        desktop_notifications_enabled: checked,
      })
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
    const args = cliStatus.supports_auth_command ? ['auth', 'login'] : ['login']
    openCliLoginModal('claude', cliStatus.path, args)
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
    openCliLoginModal('gh', ghStatus.path, ['auth', 'login'])
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

    // Not authenticated, open login modal
    openCliLoginModal('codex', codexStatus.path, ['login'])
  }, [codexStatus?.path, openCliLoginModal, queryClient])

  const handleCodeRabbitLogin = useCallback(async () => {
    if (!coderabbitStatus?.path) return

    setCheckingCodeRabbitAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: coderabbitCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<CodeRabbitAuthStatus>({
        queryKey: coderabbitCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('CodeRabbit CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCodeRabbitAuth(false)
    }

    openCliLoginModal('coderabbit', coderabbitStatus.path, ['auth', 'login'])
  }, [coderabbitStatus?.path, openCliLoginModal, queryClient])

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

    openCliLoginModal('opencode', opencodeStatus.path, ['auth', 'login'])
  }, [opencodeStatus?.path, openCliLoginModal, queryClient])

  const handleClaudeRelogin = useCallback(() => {
    if (!cliStatus?.path) return
    const args = cliStatus.supports_auth_command ? ['auth', 'login'] : ['login']
    openCliLoginModal('claude', cliStatus.path, args)
  }, [cliStatus?.path, cliStatus?.supports_auth_command, openCliLoginModal])

  const handleGhRelogin = useCallback(() => {
    if (!ghStatus?.path) return
    openCliLoginModal('gh', ghStatus.path, ['auth', 'login'])
  }, [ghStatus?.path, openCliLoginModal])

  const handleCodexRelogin = useCallback(() => {
    if (!codexStatus?.path) return
    openCliLoginModal('codex', codexStatus.path, ['login'])
  }, [codexStatus?.path, openCliLoginModal])

  const handleOpenCodeRelogin = useCallback(() => {
    if (!opencodeStatus?.path) return
    openCliLoginModal('opencode', opencodeStatus.path, ['auth', 'login'])
  }, [opencodeStatus?.path, openCliLoginModal])

  const handleCodeRabbitRelogin = useCallback(() => {
    if (!coderabbitStatus?.path) return
    openCliLoginModal('coderabbit', coderabbitStatus.path, ['auth', 'login'])
  }, [coderabbitStatus?.path, openCliLoginModal])

  const handleCursorLogin = useCallback(async () => {
    if (!cursorStatus?.path) return

    setCheckingCursorAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: cursorCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<CursorAuthStatus>({
        queryKey: cursorCliQueryKeys.auth(),
      })

      if (result?.authenticated) {
        toast.success('Cursor CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCursorAuth(false)
    }

    openCliLoginModal('cursor', cursorStatus.path, ['login'])
  }, [cursorStatus?.path, openCliLoginModal, queryClient])

  const handleCursorRelogin = useCallback(() => {
    if (!cursorStatus?.path) return
    openCliLoginModal('cursor', cursorStatus.path, ['login'])
  }, [cursorStatus?.path, openCliLoginModal])

  const handleCursorUpdate = useCallback(() => {
    if (!cursorStatus?.path) return
    openCliLoginModal('cursor', cursorStatus.path, ['update'], 'update')
  }, [cursorStatus?.path, openCliLoginModal])

  const handleCursorInstall = useCallback(async () => {
    try {
      const installCommand = await getCursorInstallCommand()
      openCliLoginModal(
        'cursor',
        installCommand.command,
        installCommand.args,
        'install'
      )
    } catch (error) {
      toast.error('Failed to prepare Cursor Agent install command', {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [openCliLoginModal])

  const handlePiLogin = useCallback(async () => {
    if (!piStatus?.path) return
    setCheckingPiAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: piCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<PiAuthStatus>({
        queryKey: piCliQueryKeys.auth(),
      })
      if (result?.authenticated) {
        toast.success('PI CLI is already authenticated')
        return
      }
    } finally {
      setCheckingPiAuth(false)
    }
    openCliLoginModal('pi', piStatus.path, [])
  }, [piStatus?.path, openCliLoginModal, queryClient])

  const handlePiRelogin = useCallback(() => {
    if (!piStatus?.path) return
    openCliLoginModal('pi', piStatus.path, [])
  }, [piStatus?.path, openCliLoginModal])

  const handlePiInstall = useCallback(() => {
    if (preferences?.pi_cli_source !== 'jean') {
      patchPreferences.mutate({ pi_cli_source: 'jean' })
    }
    openCliUpdateModal('pi')
  }, [openCliUpdateModal, patchPreferences, preferences?.pi_cli_source])

  const handleCommandCodeLogin = useCallback(async () => {
    if (!commandcodeStatus?.path) return
    setCheckingCommandCodeAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: commandcodeCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<CommandCodeAuthStatus>({
        queryKey: commandcodeCliQueryKeys.auth(),
      })
      if (result?.authenticated) {
        toast.success('Command Code CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCommandCodeAuth(false)
    }
    openCliLoginModal('commandcode', commandcodeStatus.path, ['login'])
  }, [commandcodeStatus?.path, openCliLoginModal, queryClient])

  const handleCommandCodeRelogin = useCallback(() => {
    if (!commandcodeStatus?.path) return
    openCliLoginModal('commandcode', commandcodeStatus.path, ['login'])
  }, [commandcodeStatus?.path, openCliLoginModal])

  const handleCommandCodeInstall = useCallback(() => {
    if (preferences?.commandcode_cli_source !== 'jean') {
      patchPreferences.mutate({ commandcode_cli_source: 'jean' })
    }
    openCliUpdateModal('commandcode')
  }, [
    openCliUpdateModal,
    patchPreferences,
    preferences?.commandcode_cli_source,
  ])

  const handleGrokLogin = useCallback(async () => {
    if (!grokStatus?.path) return
    setCheckingGrokAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: grokCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<GrokAuthStatus>({
        queryKey: grokCliQueryKeys.auth(),
      })
      if (result?.authenticated) {
        toast.success('Grok CLI is already authenticated')
        return
      }
    } finally {
      setCheckingGrokAuth(false)
    }
    openCliLoginModal('grok', grokStatus.path, ['login'])
  }, [grokStatus?.path, openCliLoginModal, queryClient])

  const handleGrokRelogin = useCallback(() => {
    if (!grokStatus?.path) return
    openCliLoginModal('grok', grokStatus.path, ['login'])
  }, [grokStatus?.path, openCliLoginModal])

  const handleGrokInstall = useCallback(() => {
    if (preferences?.grok_cli_source !== 'jean') {
      patchPreferences.mutate({ grok_cli_source: 'jean' })
    }
    openCliUpdateModal('grok')
  }, [openCliUpdateModal, patchPreferences, preferences?.grok_cli_source])

  const handleKimiLogin = useCallback(async () => {
    if (!kimiStatus?.path) return
    setCheckingKimiAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: kimiCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<KimiAuthStatus>({
        queryKey: kimiCliQueryKeys.auth(),
      })
      if (result?.authenticated) {
        toast.success('Kimi Code CLI is already authenticated')
        return
      }
    } finally {
      setCheckingKimiAuth(false)
    }
    openCliLoginModal('kimi', kimiStatus.path, ['login'])
  }, [kimiStatus?.path, openCliLoginModal, queryClient])

  const handleKimiRelogin = useCallback(() => {
    if (!kimiStatus?.path) return
    openCliLoginModal('kimi', kimiStatus.path, ['login'])
  }, [kimiStatus?.path, openCliLoginModal])

  const handleKimiInstall = useCallback(() => {
    if (preferences?.kimi_cli_source !== 'jean') {
      patchPreferences.mutate({ kimi_cli_source: 'jean' })
    }
    openCliUpdateModal('kimi')
  }, [openCliUpdateModal, patchPreferences, preferences?.kimi_cli_source])

  const handleCopyPath = useCallback((path: string | null | undefined) => {
    if (!path) return
    copyToClipboard(path)
    toast.success('Path copied to clipboard')
  }, [])

  return (
    <div className="space-y-6">
      {scope in backendPaneMeta && (
        <BackendPaneHeader
          backend={scope as CliBackend}
          description={
            backendPaneMeta[scope as keyof typeof backendPaneMeta].description
          }
        />
      )}

      {hasBackend() && scope === 'claude' && (
        <SettingsSection
          title="CLI source"
          anchorId="pref-claude-section-cli"
          variant="card"
          actions={
            cliStatus?.installed ? (
              checkingClaudeAuth || isClaudeAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : claudeAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button size="sm" onClick={handleClaudeRelogin}>
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button size="sm" onClick={handleClaudeLogin}>
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
                cliStatus?.installed
                  ? 'Enables Claude AI sessions'
                  : 'Optional — enables Claude AI sessions'
              }
            >
              {isCliLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : cliStatus?.installed ? (
                isPathSource ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {cliStatus.version ?? 'Installed'}
                    </span>
                    {isClaudeVersionsLoading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!claudeHasUpdate}
                        onClick={() => {
                          const action = getPathUpdateAction(
                            cliStatus.path,
                            pathDetection?.package_manager,
                            'claude-code',
                            ['update']
                          )
                          if (action) {
                            openCliLoginModal(
                              'claude',
                              action[0],
                              action[1],
                              'update'
                            )
                          } else {
                            openCliUpdateModal('claude')
                          }
                        }}
                      >
                        {claudeHasUpdate
                          ? `Update to ${claudeLatestStable?.version}`
                          : 'Up to date'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={() => openCliUpdateModal('claude')}
                  >
                    {cliStatus.version ?? 'Installed'}
                  </Button>
                )
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={() => openCliUpdateModal('claude')}
                >
                  Install
                </Button>
              )}
            </InlineField>
            <InlineField
              label="Source"
              description={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() =>
                        handleCopyPath(
                          preferences?.claude_cli_source === 'path'
                            ? pathDetection?.path
                            : cliStatus?.path
                        )
                      }
                      className="text-left hover:underline cursor-pointer"
                    >
                      {preferences?.claude_cli_source === 'path'
                        ? (pathDetection?.path ?? 'System PATH')
                        : (cliStatus?.path ?? 'Not installed')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy path</TooltipContent>
                </Tooltip>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={preferences?.claude_cli_source ?? 'jean'}
                  onValueChange={handleClaudeSourceChange}
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jean">Jean-managed</SelectItem>
                    <SelectItem value="path" disabled={!pathDetection?.found}>
                      System PATH
                      {!pathDetection?.found && ' (not found)'}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {preferences?.claude_cli_source === 'jean' &&
                  cliStatus?.installed && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteCliTarget('claude')}
                    >
                      Uninstall
                    </Button>
                  )}
              </div>
            </InlineField>
            {!cliStatus?.installed && !pathDetection?.found && (
              <p className="text-xs text-muted-foreground px-1">
                Install with Jean, or install <code>claude</code> yourself in
                your environment — we&apos;ll detect it on your PATH.
              </p>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && scope === 'github' && (
        <SettingsSection
          title="GitHub CLI"
          anchorId="pref-github-section-cli"
          actions={
            ghStatus?.installed ? (
              checkingGhAuth || isGhAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : ghAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button variant="outline" size="sm" onClick={handleGhRelogin}>
                    Relogin
                  </Button>
                </span>
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
                ghStatus?.installed
                  ? 'Enables GitHub integration'
                  : 'Optional — enables GitHub integration'
              }
            >
              {isGhLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : ghStatus?.installed ? (
                isGhPathSource ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {ghStatus.version ?? 'Installed'}
                    </span>
                    {isGhVersionsLoading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!ghHasUpdate}
                        onClick={() => {
                          const action = getPathUpdateAction(
                            ghStatus.path,
                            ghPathDetection?.package_manager,
                            'gh',
                            null
                          )
                          if (action) {
                            openCliLoginModal(
                              'gh',
                              action[0],
                              action[1],
                              'update'
                            )
                          } else {
                            openCliUpdateModal('gh')
                          }
                        }}
                      >
                        {ghHasUpdate
                          ? `Update to ${ghLatestStable?.version}`
                          : 'Up to date'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={() => openCliUpdateModal('gh')}
                  >
                    {ghStatus.version ?? 'Installed'}
                  </Button>
                )
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={() => openCliUpdateModal('gh')}
                >
                  Install
                </Button>
              )}
            </InlineField>
            <InlineField
              label="Source"
              description={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() =>
                        handleCopyPath(
                          preferences?.gh_cli_source === 'path'
                            ? ghPathDetection?.path
                            : ghStatus?.path
                        )
                      }
                      className="text-left hover:underline cursor-pointer"
                    >
                      {preferences?.gh_cli_source === 'path'
                        ? (ghPathDetection?.path ?? 'System PATH')
                        : (ghStatus?.path ?? 'Not installed')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy path</TooltipContent>
                </Tooltip>
              }
            >
              <Select
                value={preferences?.gh_cli_source ?? 'jean'}
                onValueChange={handleGhSourceChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jean">Jean (managed)</SelectItem>
                  <SelectItem value="path" disabled={!ghPathDetection?.found}>
                    System PATH
                    {!ghPathDetection?.found && ' (not found)'}
                  </SelectItem>
                </SelectContent>
              </Select>
            </InlineField>
            {!ghStatus?.installed && !ghPathDetection?.found && (
              <p className="text-xs text-muted-foreground px-1">
                Install with Jean, or install <code>gh</code> yourself in your
                environment — we&apos;ll detect it on your PATH.
              </p>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && scope === 'coderabbit' && (
        <SettingsSection
          title="CodeRabbit CLI"
          anchorId="pref-coderabbit-section-cli"
          actions={
            coderabbitStatus?.installed ? (
              checkingCodeRabbitAuth || isCodeRabbitAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : coderabbitAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCodeRabbitRelogin}
                  >
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleCodeRabbitLogin}
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
              label={coderabbitStatus?.installed ? 'Version' : 'Status'}
              description={
                coderabbitStatus?.installed
                  ? 'Enables secondary CodeRabbit code reviews'
                  : 'Optional — enables secondary CodeRabbit code reviews'
              }
            >
              {isCodeRabbitLoading || installCodeRabbitCli.isPending ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : coderabbitStatus?.installed ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {coderabbitStatus.version ?? 'Installed'}
                  </span>
                  {isCodeRabbitVersionsLoading ? (
                    <Loader2 className="size-4 animate-spin text-muted-foreground" />
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={
                        updateCodeRabbitCli.isPending || !coderabbitHasUpdate
                      }
                      onClick={() => {
                        if (!coderabbitHasUpdate) return
                        if (isCodeRabbitPathSource) {
                          const action = getPathUpdateAction(
                            coderabbitStatus.path,
                            coderabbitPathDetection?.package_manager,
                            'coderabbit',
                            ['update'],
                            undefined,
                            coderabbitLatestStable?.version
                          )
                          if (action) {
                            openCliLoginModal(
                              'coderabbit',
                              action[0],
                              action[1],
                              'update'
                            )
                            return
                          }
                        }
                        updateCodeRabbitCli.mutate()
                      }}
                    >
                      {updateCodeRabbitCli.isPending
                        ? 'Updating...'
                        : coderabbitHasUpdate
                          ? `Update to ${coderabbitLatestStable?.version}`
                          : 'Up to date'}
                    </Button>
                  )}
                </div>
              ) : (
                <Button
                  className="w-full sm:w-40"
                  disabled={installCodeRabbitCli.isPending}
                  onClick={() => installCodeRabbitCli.mutate(undefined)}
                >
                  {installCodeRabbitCli.isPending ? 'Installing...' : 'Install'}
                </Button>
              )}
            </InlineField>
            {(coderabbitStatus?.installed ||
              coderabbitPathDetection?.found) && (
              <InlineField
                label="Source"
                description={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          handleCopyPath(
                            preferences?.coderabbit_cli_source === 'path'
                              ? coderabbitPathDetection?.path
                              : coderabbitStatus?.path
                          )
                        }
                        className="text-left hover:underline cursor-pointer"
                      >
                        {preferences?.coderabbit_cli_source === 'path'
                          ? (coderabbitPathDetection?.path ?? 'System PATH')
                          : (coderabbitStatus?.path ?? 'Not installed')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                }
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.coderabbit_cli_source ?? 'jean'}
                    onValueChange={handleCodeRabbitSourceChange}
                  >
                    <SelectTrigger className="w-full sm:w-80">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jean">Jean (managed)</SelectItem>
                      <SelectItem
                        value="path"
                        disabled={!coderabbitPathDetection?.found}
                      >
                        System PATH
                        {!coderabbitPathDetection?.found && ' (not found)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {preferences?.coderabbit_cli_source === 'jean' &&
                    coderabbitStatus?.installed && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setDeleteCliTarget('coderabbit')}
                      >
                        Delete managed install
                      </Button>
                    )}
                </div>
              </InlineField>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && scope === 'codex' && (
        <SettingsSection
          title="CLI source"
          anchorId="pref-codex-section-cli"
          variant="card"
          actions={
            codexStatus?.installed ? (
              checkingCodexAuth || isCodexAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : codexAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button size="sm" onClick={handleCodexRelogin}>
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button size="sm" onClick={handleCodexLogin}>
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
                codexStatus?.installed
                  ? 'Enables Codex AI sessions'
                  : 'Optional — enables Codex AI sessions'
              }
            >
              {isCodexLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : codexStatus?.installed ? (
                isCodexPathSource ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {codexStatus.version ?? 'Installed'}
                    </span>
                    {isCodexVersionsLoading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!codexHasUpdate}
                        onClick={() => {
                          const action = getPathUpdateAction(
                            codexStatus.path,
                            codexPathDetection?.package_manager,
                            'codex',
                            null,
                            '@openai/codex',
                            codexLatestStable?.version
                          )
                          if (action) {
                            openCliLoginModal(
                              'codex',
                              action[0],
                              action[1],
                              'update'
                            )
                          } else {
                            openCliUpdateModal('codex')
                          }
                        }}
                      >
                        {codexHasUpdate
                          ? `Update to ${codexLatestStable?.version}`
                          : 'Up to date'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={() => openCliUpdateModal('codex')}
                  >
                    {codexStatus.version ?? 'Installed'}
                  </Button>
                )
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={() => openCliUpdateModal('codex')}
                >
                  Install
                </Button>
              )}
            </InlineField>
            <InlineField
              label="Source"
              description={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() =>
                        handleCopyPath(
                          preferences?.codex_cli_source === 'path'
                            ? codexPathDetection?.path
                            : codexStatus?.path
                        )
                      }
                      className="text-left hover:underline cursor-pointer"
                    >
                      {preferences?.codex_cli_source === 'path'
                        ? (codexPathDetection?.path ?? 'System PATH')
                        : (codexStatus?.path ?? 'Not installed')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy path</TooltipContent>
                </Tooltip>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={preferences?.codex_cli_source ?? 'jean'}
                  onValueChange={handleCodexSourceChange}
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jean">Jean-managed</SelectItem>
                    <SelectItem
                      value="path"
                      disabled={!codexPathDetection?.found}
                    >
                      System PATH
                      {!codexPathDetection?.found && ' (not found)'}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {preferences?.codex_cli_source === 'jean' &&
                  codexStatus?.installed && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteCliTarget('codex')}
                    >
                      Uninstall
                    </Button>
                  )}
              </div>
            </InlineField>
            {!codexStatus?.installed && !codexPathDetection?.found && (
              <p className="text-xs text-muted-foreground px-1">
                Install with Jean, or install <code>codex</code> yourself in
                your environment — we&apos;ll detect it on your PATH.
              </p>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && scope === 'opencode' && (
        <SettingsSection
          title="CLI source"
          anchorId="pref-opencode-section-cli"
          variant="card"
          actions={
            opencodeStatus?.installed ? (
              checkingOpenCodeAuth || isOpenCodeAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : opencodeAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button size="sm" onClick={handleOpenCodeRelogin}>
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button size="sm" onClick={handleOpenCodeLogin}>
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
                opencodeStatus?.installed
                  ? 'Enables OpenCode AI sessions'
                  : 'Optional — enables OpenCode AI sessions'
              }
            >
              {isOpenCodeLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : opencodeStatus?.installed ? (
                isOpencodePathSource ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm">
                      {opencodeStatus.version ?? 'Installed'}
                    </span>
                    {isOpencodeVersionsLoading ? (
                      <Loader2 className="size-4 animate-spin text-muted-foreground" />
                    ) : (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!opencodeHasUpdate}
                        onClick={() => {
                          const action = getPathUpdateAction(
                            opencodeStatus.path,
                            opencodePathDetection?.package_manager,
                            'opencode',
                            ['upgrade']
                          )
                          if (action) {
                            openCliLoginModal(
                              'opencode',
                              action[0],
                              action[1],
                              'update'
                            )
                          } else {
                            openCliUpdateModal('opencode')
                          }
                        }}
                      >
                        {opencodeHasUpdate
                          ? `Update to ${opencodeLatestStable?.version}`
                          : 'Up to date'}
                      </Button>
                    )}
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={() => openCliUpdateModal('opencode')}
                  >
                    {opencodeStatus.version ?? 'Installed'}
                  </Button>
                )
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={() => openCliUpdateModal('opencode')}
                >
                  Install
                </Button>
              )}
            </InlineField>
            <InlineField
              label="Source"
              description={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() =>
                        handleCopyPath(
                          preferences?.opencode_cli_source === 'path'
                            ? opencodePathDetection?.path
                            : opencodeStatus?.path
                        )
                      }
                      className="text-left hover:underline cursor-pointer"
                    >
                      {preferences?.opencode_cli_source === 'path'
                        ? (opencodePathDetection?.path ?? 'System PATH')
                        : (opencodeStatus?.path ?? 'Not installed')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy path</TooltipContent>
                </Tooltip>
              }
            >
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={preferences?.opencode_cli_source ?? 'jean'}
                  onValueChange={handleOpencodeSourceChange}
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jean">Jean-managed</SelectItem>
                    <SelectItem
                      value="path"
                      disabled={!opencodePathDetection?.found}
                    >
                      System PATH
                      {!opencodePathDetection?.found && ' (not found)'}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {preferences?.opencode_cli_source === 'jean' &&
                  opencodeStatus?.installed && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteCliTarget('opencode')}
                    >
                      Uninstall
                    </Button>
                  )}
              </div>
            </InlineField>
            {!opencodeStatus?.installed && !opencodePathDetection?.found && (
              <p className="text-xs text-muted-foreground px-1">
                Install with Jean, or install <code>opencode</code> yourself in
                your environment — we&apos;ll detect it on your PATH.
              </p>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && scope === 'cursor' && (
        <SettingsSection
          title="CLI source"
          anchorId="pref-cursor-section-cli"
          variant="card"
          actions={
            cursorStatus?.installed ? (
              checkingCursorAuth || isCursorAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : cursorAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button size="sm" onClick={handleCursorRelogin}>
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button size="sm" onClick={handleCursorLogin}>
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
              label={cursorStatus?.installed ? 'Version' : 'Status'}
              description={
                cursorStatus?.installed
                  ? 'Enables Cursor AI sessions'
                  : 'Optional — enables Cursor AI sessions'
              }
            >
              {isCursorLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : cursorStatus?.installed ? (
                <div className="flex items-center gap-2">
                  <span className="text-sm">
                    {cursorStatus.version ?? 'Installed'}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCursorUpdate}
                  >
                    Run self-update
                  </Button>
                </div>
              ) : (
                <Button
                  className="w-full sm:w-40"
                  onClick={handleCursorInstall}
                >
                  Install
                </Button>
              )}
            </InlineField>
            {cursorStatus?.installed &&
              !cursorAuth?.authenticated &&
              cursorAuthMessage && (
                <div className="text-xs text-muted-foreground">
                  {cursorAuthMessage}
                </div>
              )}
            <InlineField
              label="Source"
              description={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() =>
                        handleCopyPath(
                          cursorPathDetection?.path ?? cursorStatus?.path
                        )
                      }
                      className="text-left hover:underline cursor-pointer"
                    >
                      {cursorPathDetection?.path ??
                        cursorStatus?.path ??
                        'Not installed'}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy path</TooltipContent>
                </Tooltip>
              }
            >
              {/* Cursor has no Jean-managed binary — the installer runs
                  Cursor's own script and the result lives on PATH. The
                  Select is disabled but kept for visual parity with the
                  other CLI rows. */}
              <Select value="path" disabled>
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="path">System PATH</SelectItem>
                </SelectContent>
              </Select>
            </InlineField>
            {!cursorStatus?.installed && !cursorPathDetection?.found && (
              <p className="text-xs text-muted-foreground px-1">
                Install with Jean, or install <code>cursor-agent</code> yourself
                in your environment — we&apos;ll detect it on your PATH.
              </p>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && scope === 'pi' && (
        <SettingsSection
          title="CLI source"
          anchorId="pref-pi-section-cli"
          variant="card"
          actions={
            piStatus?.installed ? (
              checkingPiAuth || isPiAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : piAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button size="sm" onClick={handlePiRelogin}>
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button size="sm" onClick={handlePiLogin}>
                  Login
                </Button>
              )
            ) : (
              <Button size="sm" onClick={handlePiInstall}>
                Install
              </Button>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={piStatus?.installed ? 'Version' : 'Status'}
              description={
                piStatus?.installed
                  ? 'Enables PI AI sessions through the PI CLI.'
                  : 'PI can be Jean-managed or discovered from your system PATH.'
              }
            >
              {isPiLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : piStatus?.installed ? (
                <Button
                  variant="outline"
                  className="w-full sm:w-40 justify-between"
                  onClick={handlePiInstall}
                >
                  {piStatus.version ?? 'Installed'}
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Not found in PATH
                  </span>
                  <Button variant="outline" size="sm" onClick={handlePiInstall}>
                    Install now
                  </Button>
                </div>
              )}
            </InlineField>
            <InlineField
              label="Source"
              description={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() =>
                        handleCopyPath(
                          preferences?.pi_cli_source === 'path'
                            ? piPathDetection?.path
                            : piStatus?.path
                        )
                      }
                      className="text-left hover:underline cursor-pointer"
                    >
                      {preferences?.pi_cli_source === 'path'
                        ? (piPathDetection?.path ?? 'System PATH')
                        : (piStatus?.path ?? 'Not installed')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy path</TooltipContent>
                </Tooltip>
              }
            >
              <div className="flex items-center gap-2">
                <Select
                  value={preferences?.pi_cli_source ?? 'jean'}
                  onValueChange={handlePiSourceChange}
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jean">Jean-managed</SelectItem>
                    <SelectItem value="path" disabled={!piPathDetection?.found}>
                      System PATH
                      {!piPathDetection?.found && ' (not found)'}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {preferences?.pi_cli_source === 'jean' &&
                  piStatus?.installed && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteCliTarget('pi')}
                    >
                      Uninstall
                    </Button>
                  )}
              </div>
            </InlineField>
            {piStatus?.installed && !piAuth?.authenticated && piAuthMessage && (
              <div className="text-xs text-muted-foreground">
                {piAuthMessage}
              </div>
            )}
          </div>
        </SettingsSection>
      )}

      {hasBackend() && scope === 'commandcode' && (
        <SettingsSection
          title="CLI source"
          anchorId="pref-commandcode-section-cli"
          variant="card"
          actions={
            commandcodeStatus?.installed ? (
              checkingCommandCodeAuth || isCommandCodeAuthLoading ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  <Loader2 className="size-3 animate-spin" />
                  Checking...
                </span>
              ) : commandcodeAuth?.authenticated ? (
                <span className="text-sm text-muted-foreground flex items-center gap-2">
                  Logged in
                  <Button size="sm" onClick={handleCommandCodeRelogin}>
                    Relogin
                  </Button>
                </span>
              ) : (
                <Button size="sm" onClick={handleCommandCodeLogin}>
                  Login
                </Button>
              )
            ) : (
              <Button size="sm" onClick={handleCommandCodeInstall}>
                Install
              </Button>
            )
          }
        >
          <div className="space-y-4">
            <InlineField
              label={commandcodeStatus?.installed ? 'Version' : 'Status'}
              description={
                commandcodeStatus?.installed
                  ? 'Enables Command Code AI sessions through the cmd CLI.'
                  : 'Command Code is discovered from your system PATH.'
              }
            >
              {isCommandCodeLoading ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : commandcodeStatus?.installed ? (
                <Button
                  variant="outline"
                  className="w-full sm:w-40 justify-between"
                  onClick={handleCommandCodeInstall}
                >
                  {commandcodeStatus.version ?? 'Installed'}
                </Button>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">
                    Not found in PATH
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleCommandCodeInstall}
                  >
                    Install now
                  </Button>
                </div>
              )}
            </InlineField>
            <InlineField
              label="Source"
              description={
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() =>
                        handleCopyPath(
                          preferences?.commandcode_cli_source === 'path'
                            ? commandcodePathDetection?.path
                            : commandcodeStatus?.path
                        )
                      }
                      className="text-left hover:underline cursor-pointer"
                    >
                      {preferences?.commandcode_cli_source === 'path'
                        ? (commandcodePathDetection?.path ?? 'System PATH')
                        : (commandcodeStatus?.path ?? 'Not installed')}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>Click to copy path</TooltipContent>
                </Tooltip>
              }
            >
              <div className="flex items-center gap-2">
                <Select
                  value={preferences?.commandcode_cli_source ?? 'jean'}
                  onValueChange={handleCommandCodeSourceChange}
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="jean">Jean-managed</SelectItem>
                    <SelectItem
                      value="path"
                      disabled={!commandcodePathDetection?.found}
                    >
                      System PATH
                      {!commandcodePathDetection?.found && ' (not found)'}
                    </SelectItem>
                  </SelectContent>
                </Select>
                {preferences?.commandcode_cli_source === 'jean' &&
                  commandcodeStatus?.installed && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setDeleteCliTarget('commandcode')}
                    >
                      Uninstall
                    </Button>
                  )}
              </div>
            </InlineField>
            {commandcodeStatus?.installed &&
              !commandcodeAuth?.authenticated &&
              commandCodeAuthMessage && (
                <div className="text-xs text-muted-foreground">
                  {commandCodeAuthMessage}
                </div>
              )}
          </div>
        </SettingsSection>
      )}

      {isGeneralScope && isWindows && isNativeApp() && (
        <WslSettingsSection
          preferences={preferences}
          patchPreferences={patchPreferences}
        />
      )}

      {scope === 'claude' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-claude-section-settings"
          variant="card"
        >
          <div className="space-y-4">
            <InlineField
              label="Model"
              description="Claude model for AI assistance"
            >
              <Select
                value={preferences?.selected_model ?? 'claude-opus-4-8[1m]'}
                onValueChange={handleModelChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {remoteClaudeModelOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>

            {claudeReasoning?.type === 'thinking' && (
              <InlineField
                label="Thinking"
                description="Thinking level for the selected Claude model"
              >
                <Select
                  value={preferences?.thinking_level ?? claudeReasoning.default}
                  onValueChange={value =>
                    handleThinkingLevelChange(value as ThinkingLevel)
                  }
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {claudeReasoning.levels.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InlineField>
            )}

            {claudeReasoning?.type === 'effort' && (
              <InlineField
                label="Effort"
                description="Effort level for the selected Claude model"
              >
                <Select
                  value={
                    preferences?.default_effort_level ?? claudeReasoning.default
                  }
                  onValueChange={value =>
                    handleEffortLevelChange(value as EffortLevel)
                  }
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {claudeReasoning.levels.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InlineField>
            )}

            <InlineField
              label="Chrome browser integration"
              description="Enable browser automation via Chrome extension"
            >
              <Switch
                checked={preferences?.chrome_enabled ?? true}
                onCheckedChange={checked => {
                  if (preferences) {
                    patchPreferences.mutate({
                      chrome_enabled: checked,
                    })
                  }
                }}
              />
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {scope === 'codex' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-codex-section-settings"
          variant="card"
        >
          <div className="space-y-4">
            <InlineField
              label="Model"
              description="Codex model for AI assistance"
            >
              <Select
                value={preferences?.selected_codex_model ?? 'gpt-5.6-sol'}
                onValueChange={handleCodexModelChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {remoteCodexDefaultModelOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>

            <InlineField
              label="Reasoning effort"
              description="Codex reasoning effort"
            >
              <Select
                value={preferences?.default_codex_reasoning_effort ?? 'high'}
                onValueChange={handleCodexReasoningChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {selectedCodexReasoningOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>

            <InlineField
              label="Model verbosity"
              description="How much intermediate text Codex writes during chat (low is terse; high is more detailed)"
            >
              <Select
                value={preferences?.default_codex_model_verbosity ?? 'medium'}
                onValueChange={handleCodexModelVerbosityChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {codexModelVerbosityOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>

            <InlineField
              label="Goal execution mode"
              description="Mode used when starting a Codex /goal"
            >
              <Select
                value={preferences?.codex_goal_execution_mode ?? 'build'}
                onValueChange={handleCodexGoalExecutionModeChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="build">Build</SelectItem>
                  <SelectItem value="yolo">Yolo</SelectItem>
                </SelectContent>
              </Select>
            </InlineField>

            <InlineField
              label="Steer running turn"
              description="Prompts sent while Codex is working are injected into the current turn instead of queued"
            >
              <Switch
                checked={preferences?.codex_auto_steer_enabled ?? true}
                onCheckedChange={handleCodexAutoSteerToggle}
              />
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
          </div>
        </SettingsSection>
      )}

      {scope === 'opencode' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-opencode-section-settings"
          variant="card"
        >
          <div className="space-y-4">
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
                    {openCodeModelOptions.length > 1 && (
                      <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    <CommandInput placeholder="Search models..." />
                    <CommandList onWheel={e => e.stopPropagation()}>
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
            <InlineField
              label="Steer running turn"
              description="Text-only prompts sent while OpenCode is working are injected into the current turn instead of queued (attachments always queue)"
            >
              <Switch
                checked={preferences?.opencode_auto_steer_enabled ?? true}
                onCheckedChange={handleOpenCodeAutoSteerToggle}
              />
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {scope === 'cursor' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-cursor-section-settings"
          variant="card"
        >
          <div className="space-y-4">
            <InlineField
              label="Model"
              description="Cursor model for AI assistance"
            >
              <Popover
                open={cursorModelPopoverOpen}
                onOpenChange={setCursorModelPopoverOpen}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={cursorModelPopoverOpen}
                    aria-label="Select Cursor model"
                    className="w-80 max-w-full justify-between"
                  >
                    <span className="max-w-[16rem] truncate text-left">
                      {selectedCursorModelLabel}
                    </span>
                    {cursorModelOptions.length > 1 && (
                      <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    <CommandInput placeholder="Search models..." />
                    <CommandList onWheel={e => e.stopPropagation()}>
                      <CommandEmpty>No models found.</CommandEmpty>
                      <CommandGroup>
                        {cursorModelOptions.map(option => (
                          <CommandItem
                            key={option.value}
                            value={`${option.label} ${option.value}`}
                            onSelect={() => {
                              handleCursorModelChange(option.value)
                              setCursorModelPopoverOpen(false)
                            }}
                          >
                            <span className="max-w-[18rem] truncate">
                              {option.label}
                            </span>
                            <Check
                              className={cn(
                                'ml-auto h-4 w-4',
                                selectedCursorModel === option.value
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
          </div>
        </SettingsSection>
      )}

      {scope === 'pi' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-pi-section-settings"
          variant="card"
        >
          <div className="space-y-4">
            <InlineField
              label="Model"
              description={
                <>
                  Models come from the currently active PI provider via{' '}
                  <code>pi --list-models</code>. Use the Login/Relogin button
                  above to change provider.
                </>
              }
            >
              <Popover
                open={piModelPopoverOpen}
                onOpenChange={setPiModelPopoverOpen}
              >
                <PopoverTrigger asChild>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={piModelPopoverOpen}
                    aria-label="Select PI model"
                    className="w-80 max-w-full justify-between"
                  >
                    <span className="max-w-[16rem] truncate text-left">
                      {selectedPiModelLabel}
                    </span>
                    {piModelOptions.length > 1 && (
                      <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-[var(--radix-popover-trigger-width)] p-0"
                >
                  <Command>
                    <CommandInput placeholder="Search models..." />
                    <CommandList onWheel={e => e.stopPropagation()}>
                      <CommandEmpty>No models found.</CommandEmpty>
                      <CommandGroup>
                        {piModelOptions.map(option => (
                          <CommandItem
                            key={option.value}
                            value={`${option.label} ${option.value}`}
                            onSelect={() => {
                              handlePiModelChange(option.value)
                              setPiModelPopoverOpen(false)
                            }}
                          >
                            <span className="max-w-[18rem] truncate">
                              {option.label}
                            </span>
                            <Check
                              className={cn(
                                'ml-auto h-4 w-4',
                                selectedPiModel === option.value
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
            <InlineField
              label="Steer running turn"
              description="Text-only prompts sent while PI is working are injected into the current turn instead of queued (attachments always queue)"
            >
              <Switch
                checked={preferences?.pi_auto_steer_enabled ?? true}
                onCheckedChange={handlePiAutoSteerToggle}
              />
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {scope === 'commandcode' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-commandcode-section-settings"
          variant="card"
        >
          <div className="space-y-4">
            <InlineField
              label="Model"
              description="Command Code CLI model selection"
            >
              <Select
                value={selectedCommandCodeModel}
                onValueChange={handleCommandCodeModelChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {commandCodeModelOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {scope === 'grok' && (
        <>
          <SettingsSection
            title="CLI source"
            anchorId="pref-grok-section-cli"
            variant="card"
            actions={
              grokStatus?.installed ? (
                checkingGrokAuth || isGrokAuthLoading ? (
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="size-3 animate-spin" />
                    Checking...
                  </span>
                ) : grokAuth?.authenticated ? (
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    Logged in
                    <Button size="sm" onClick={handleGrokRelogin}>
                      Relogin
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" onClick={handleGrokLogin}>
                    Login
                  </Button>
                )
              ) : (
                <Button size="sm" onClick={handleGrokInstall}>
                  Install
                </Button>
              )
            }
          >
            <div className="space-y-4">
              <InlineField
                label={grokStatus?.installed ? 'Version' : 'Status'}
                description={
                  grokStatus?.installed
                    ? 'Enables Grok AI sessions through the Grok CLI.'
                    : 'Grok can be Jean-managed or discovered from your system PATH.'
                }
              >
                {isGrokLoading ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : grokStatus?.installed ? (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={handleGrokInstall}
                  >
                    {grokStatus.version ?? 'Installed'}
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      Not found in PATH
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleGrokInstall}
                    >
                      Install now
                    </Button>
                  </div>
                )}
              </InlineField>
              {grokAuthMessage && (
                <p className="text-xs text-muted-foreground">
                  {grokAuthMessage}
                </p>
              )}
              <InlineField
                label="Source"
                description={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          handleCopyPath(
                            preferences?.grok_cli_source === 'path'
                              ? grokPathDetection?.path
                              : grokStatus?.path
                          )
                        }
                        className="text-left hover:underline cursor-pointer"
                      >
                        {preferences?.grok_cli_source === 'path'
                          ? (grokPathDetection?.path ?? 'System PATH')
                          : (grokStatus?.path ?? 'Not installed')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                }
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.grok_cli_source ?? 'jean'}
                    onValueChange={handleGrokSourceChange}
                  >
                    <SelectTrigger className="w-full sm:w-80">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jean">Jean-managed</SelectItem>
                      <SelectItem
                        value="path"
                        disabled={!grokPathDetection?.found}
                      >
                        System PATH
                        {!grokPathDetection?.found && ' (not found)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {preferences?.grok_cli_source === 'jean' &&
                    grokStatus?.installed && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeleteCliTarget('grok')}
                      >
                        Uninstall
                      </Button>
                    )}
                </div>
              </InlineField>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Default model"
            anchorId="pref-grok-section-settings"
            variant="card"
          >
            <div className="space-y-4">
              <InlineField
                label="Model"
                description="Grok model for AI assistance"
              >
                <Select
                  value={selectedGrokModel}
                  onValueChange={value =>
                    handleGrokModelChange(value as GrokModel)
                  }
                >
                  <SelectTrigger className="w-80 max-w-full">
                    <SelectValue>{selectedGrokModelLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {grokModelOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InlineField>
              <InlineField
                label="Reasoning effort"
                description="Default Grok reasoning effort for new sessions"
              >
                <Select
                  value={preferences?.default_grok_reasoning_effort ?? 'high'}
                  onValueChange={handleGrokReasoningChange}
                >
                  <SelectTrigger className="w-80 max-w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {selectedGrokReasoningOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InlineField>
              <InlineField
                label="Steer running turn"
                description="Text-only prompts sent while Grok is working are injected into the current turn instead of queued (attachments always queue)"
              >
                <Switch
                  checked={preferences?.grok_auto_steer_enabled ?? true}
                  onCheckedChange={handleGrokAutoSteerToggle}
                />
              </InlineField>
            </div>
          </SettingsSection>
        </>
      )}

      {scope === 'kimi' && (
        <>
          <SettingsSection
            title="CLI source"
            anchorId="pref-kimi-section-cli"
            variant="card"
            actions={
              kimiStatus?.installed ? (
                checkingKimiAuth || isKimiAuthLoading ? (
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    <Loader2 className="size-3 animate-spin" />
                    Checking...
                  </span>
                ) : kimiAuth?.authenticated ? (
                  <span className="text-sm text-muted-foreground flex items-center gap-2">
                    Logged in
                    <Button size="sm" onClick={handleKimiRelogin}>
                      Relogin
                    </Button>
                  </span>
                ) : (
                  <Button size="sm" onClick={handleKimiLogin}>
                    Login
                  </Button>
                )
              ) : (
                <Button size="sm" onClick={handleKimiInstall}>
                  Install
                </Button>
              )
            }
          >
            <div className="space-y-4">
              <InlineField
                label={kimiStatus?.installed ? 'Version' : 'Status'}
                description={
                  kimiStatus?.installed
                    ? 'Enables Kimi Code AI sessions through the Kimi Code CLI.'
                    : 'Kimi Code can be Jean-managed or discovered from your system PATH.'
                }
              >
                {isKimiLoading ? (
                  <Loader2 className="size-4 animate-spin text-muted-foreground" />
                ) : kimiStatus?.installed ? (
                  <Button
                    variant="outline"
                    className="w-full sm:w-40 justify-between"
                    onClick={handleKimiInstall}
                  >
                    {kimiStatus.version ?? 'Installed'}
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-muted-foreground">
                      Not found in PATH
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleKimiInstall}
                    >
                      Install now
                    </Button>
                  </div>
                )}
              </InlineField>
              {kimiAuthMessage && (
                <p className="text-xs text-muted-foreground">
                  {kimiAuthMessage}
                </p>
              )}
              <InlineField
                label="Source"
                description={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() =>
                          handleCopyPath(
                            preferences?.kimi_cli_source === 'path'
                              ? kimiPathDetection?.path
                              : kimiStatus?.path
                          )
                        }
                        className="text-left hover:underline cursor-pointer"
                      >
                        {preferences?.kimi_cli_source === 'path'
                          ? (kimiPathDetection?.path ?? 'System PATH')
                          : (kimiStatus?.path ?? 'Not installed')}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>Click to copy path</TooltipContent>
                  </Tooltip>
                }
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.kimi_cli_source ?? 'jean'}
                    onValueChange={handleKimiSourceChange}
                  >
                    <SelectTrigger className="w-full sm:w-80">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="jean">Jean-managed</SelectItem>
                      <SelectItem
                        value="path"
                        disabled={!kimiPathDetection?.found}
                      >
                        System PATH
                        {!kimiPathDetection?.found && ' (not found)'}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  {preferences?.kimi_cli_source === 'jean' &&
                    kimiStatus?.installed && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setDeleteCliTarget('kimi')}
                      >
                        Uninstall
                      </Button>
                    )}
                </div>
              </InlineField>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Default model"
            anchorId="pref-kimi-section-settings"
            variant="card"
          >
            <div className="space-y-4">
              <InlineField
                label="Model"
                description="Kimi Code model for AI assistance"
              >
                <Select
                  value={selectedKimiModel}
                  onValueChange={value =>
                    handleKimiModelChange(value as KimiModel)
                  }
                >
                  <SelectTrigger className="w-80 max-w-full">
                    <SelectValue>{selectedKimiModelLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {kimiModelOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InlineField>
              <InlineField
                label="Steer running turn"
                description="Text-only prompts sent while Kimi Code is working are injected into the current turn instead of queued (attachments always queue)"
              >
                <Switch
                  checked={preferences?.kimi_auto_steer_enabled ?? false}
                  onCheckedChange={handleKimiAutoSteerToggle}
                />
              </InlineField>
            </div>
          </SettingsSection>
        </>
      )}

      {isGeneralScope && (
        <SettingsSection
          title="Defaults"
          anchorId="pref-general-section-defaults"
        >
          <div className="space-y-4">
            <InlineField
              label="Default backend"
              description="CLI to use for new sessions"
            >
              <Select
                value={effectiveBackend}
                onValueChange={handleBackendChange}
              >
                <SelectTrigger
                  className="w-full sm:w-80"
                  hideIcon={installedBackendOptions.length <= 1}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {installedBackendOptions.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      <BackendLabel backend={option.value} />
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>

            <InlineField
              label="Default mode"
              description="Permission mode for new sessions"
            >
              <Select
                value={preferences?.default_execution_mode ?? 'plan'}
                onValueChange={(value: 'plan' | 'build' | 'yolo') => {
                  patchPreferences.mutate({ default_execution_mode: value })
                }}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="plan">Plan</SelectItem>
                  <SelectItem value="build">Build</SelectItem>
                  <SelectItem value="yolo">Yolo</SelectItem>
                </SelectContent>
              </Select>
            </InlineField>

            <InlineField
              label="Compact chat view"
              description="Compact answers into one section for a cleaner chat, showing only the last prompt and answer by default."
            >
              <Switch
                checked={preferences?.compact_chat_view_enabled ?? false}
                onCheckedChange={checked => {
                  patchPreferences.mutate({
                    compact_chat_view_enabled: checked,
                  })
                }}
              />
            </InlineField>

            <InlineField
              label="Automatic recaps"
              description="Ask agents to end multi-step turns with a ## Recap section. Existing recaps remain viewable when this is off."
            >
              <Switch
                checked={preferences?.auto_recaps_enabled ?? true}
                onCheckedChange={checked => {
                  patchPreferences.mutate({
                    auto_recaps_enabled: checked,
                  })
                }}
              />
            </InlineField>

            <InlineField
              label="Parallel execution prompting"
              description="Add system prompt encouraging sub-agent parallelization for faster task execution"
            >
              <Switch
                checked={
                  preferences?.parallel_execution_prompt_enabled ?? false
                }
                onCheckedChange={checked => {
                  patchPreferences.mutate({
                    parallel_execution_prompt_enabled: checked,
                  })
                }}
              />
            </InlineField>

            <InlineField
              label="Build execution"
              description="Backend, model, thinking, and effort override when approving plans"
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <Select
                    value={preferences?.build_backend ?? 'default'}
                    onValueChange={handleBuildBackendChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {buildBackendOptions.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          <BackendLabel backend={option.value} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  {effectiveBuildBackend === 'opencode' ? (
                    <Popover
                      open={buildModelPopoverOpen}
                      onOpenChange={setBuildModelPopoverOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={buildModelPopoverOpen}
                          className="w-full justify-between"
                        >
                          <span className="truncate text-left">
                            {preferences?.build_model
                              ? (openCodeModelOptions.find(
                                  o => o.value === preferences.build_model
                                )?.label ??
                                formatOpenCodeModelLabelForSettings(
                                  preferences.build_model
                                ))
                              : 'Default model'}
                          </span>
                          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-80 p-0">
                        <Command>
                          <CommandInput placeholder="Search models..." />
                          <CommandList onWheel={e => e.stopPropagation()}>
                            <CommandEmpty>No models found.</CommandEmpty>
                            <CommandGroup>
                              <CommandItem
                                value="default"
                                onSelect={() => {
                                  handleBuildModelChange('default')
                                  setBuildModelPopoverOpen(false)
                                }}
                              >
                                Default model
                                <Check
                                  className={cn(
                                    'ml-auto h-4 w-4',
                                    !preferences?.build_model ||
                                      preferences.build_model === 'default'
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                              {openCodeModelOptions.map(option => (
                                <CommandItem
                                  key={option.value}
                                  value={`${option.label} ${option.value}`}
                                  onSelect={() => {
                                    handleBuildModelChange(option.value)
                                    setBuildModelPopoverOpen(false)
                                  }}
                                >
                                  <span className="truncate">
                                    {option.label}
                                  </span>
                                  <Check
                                    className={cn(
                                      'ml-auto h-4 w-4',
                                      preferences?.build_model === option.value
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
                  ) : effectiveBuildBackend === 'cursor' ? (
                    <Popover
                      open={buildModelPopoverOpen}
                      onOpenChange={setBuildModelPopoverOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={buildModelPopoverOpen}
                          className="w-full justify-between"
                        >
                          <span className="truncate text-left">
                            {preferences?.build_model
                              ? (cursorModelOptions.find(
                                  o => o.value === preferences.build_model
                                )?.label ??
                                formatCursorModelLabel(preferences.build_model))
                              : 'Default model'}
                          </span>
                          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-80 p-0">
                        <Command>
                          <CommandInput placeholder="Search models..." />
                          <CommandList onWheel={e => e.stopPropagation()}>
                            <CommandEmpty>No models found.</CommandEmpty>
                            <CommandGroup>
                              <CommandItem
                                value="default"
                                onSelect={() => {
                                  handleBuildModelChange('default')
                                  setBuildModelPopoverOpen(false)
                                }}
                              >
                                Default model
                                <Check
                                  className={cn(
                                    'ml-auto h-4 w-4',
                                    !preferences?.build_model ||
                                      preferences.build_model === 'default'
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                              {cursorModelOptions.map(option => (
                                <CommandItem
                                  key={option.value}
                                  value={`${option.label} ${option.value}`}
                                  onSelect={() => {
                                    handleBuildModelChange(option.value)
                                    setBuildModelPopoverOpen(false)
                                  }}
                                >
                                  <span className="truncate">
                                    {option.label}
                                  </span>
                                  <Check
                                    className={cn(
                                      'ml-auto h-4 w-4',
                                      preferences?.build_model === option.value
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
                  ) : (
                    <Select
                      value={preferences?.build_model ?? 'default'}
                      onValueChange={handleBuildModelChange}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default model</SelectItem>
                        {(effectiveBuildBackend === 'codex'
                          ? remoteCodexDefaultModelOptions
                          : effectiveBuildBackend === 'commandcode'
                            ? commandCodeModelOptions
                            : remoteClaudeModelOptions
                        ).map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {buildReasoning?.type === 'thinking' && (
                  <div>
                    <Select
                      value={preferences?.build_thinking_level ?? 'default'}
                      onValueChange={handleBuildThinkingLevelChange}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">
                          Default thinking
                        </SelectItem>
                        {buildReasoning.levels.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {buildReasoning?.type === 'effort' && (
                  <div>
                    <Select
                      value={preferences?.build_effort_level ?? 'default'}
                      onValueChange={handleBuildEffortLevelChange}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">
                          Default reasoning
                        </SelectItem>
                        {buildReasoning.levels.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </InlineField>

            <InlineField
              label="Yolo execution"
              description="Backend, model, thinking, and effort override when yolo-approving plans"
            >
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-4">
                <div>
                  <Select
                    value={preferences?.yolo_backend ?? 'default'}
                    onValueChange={handleYoloBackendChange}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="default">Default</SelectItem>
                      {backendOptions.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          <BackendLabel backend={option.value} />
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  {effectiveYoloBackend === 'opencode' ? (
                    <Popover
                      open={yoloModelPopoverOpen}
                      onOpenChange={setYoloModelPopoverOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={yoloModelPopoverOpen}
                          className="w-full justify-between"
                        >
                          <span className="truncate text-left">
                            {preferences?.yolo_model
                              ? (openCodeModelOptions.find(
                                  o => o.value === preferences.yolo_model
                                )?.label ??
                                formatOpenCodeModelLabelForSettings(
                                  preferences.yolo_model
                                ))
                              : 'Default model'}
                          </span>
                          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-80 p-0">
                        <Command>
                          <CommandInput placeholder="Search models..." />
                          <CommandList onWheel={e => e.stopPropagation()}>
                            <CommandEmpty>No models found.</CommandEmpty>
                            <CommandGroup>
                              <CommandItem
                                value="default"
                                onSelect={() => {
                                  handleYoloModelChange('default')
                                  setYoloModelPopoverOpen(false)
                                }}
                              >
                                Default model
                                <Check
                                  className={cn(
                                    'ml-auto h-4 w-4',
                                    !preferences?.yolo_model ||
                                      preferences.yolo_model === 'default'
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                              {openCodeModelOptions.map(option => (
                                <CommandItem
                                  key={option.value}
                                  value={`${option.label} ${option.value}`}
                                  onSelect={() => {
                                    handleYoloModelChange(option.value)
                                    setYoloModelPopoverOpen(false)
                                  }}
                                >
                                  <span className="truncate">
                                    {option.label}
                                  </span>
                                  <Check
                                    className={cn(
                                      'ml-auto h-4 w-4',
                                      preferences?.yolo_model === option.value
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
                  ) : effectiveYoloBackend === 'cursor' ? (
                    <Popover
                      open={yoloModelPopoverOpen}
                      onOpenChange={setYoloModelPopoverOpen}
                    >
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={yoloModelPopoverOpen}
                          className="w-full justify-between"
                        >
                          <span className="truncate text-left">
                            {preferences?.yolo_model
                              ? (cursorModelOptions.find(
                                  o => o.value === preferences.yolo_model
                                )?.label ??
                                formatCursorModelLabel(preferences.yolo_model))
                              : 'Default model'}
                          </span>
                          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="start" className="w-80 p-0">
                        <Command>
                          <CommandInput placeholder="Search models..." />
                          <CommandList onWheel={e => e.stopPropagation()}>
                            <CommandEmpty>No models found.</CommandEmpty>
                            <CommandGroup>
                              <CommandItem
                                value="default"
                                onSelect={() => {
                                  handleYoloModelChange('default')
                                  setYoloModelPopoverOpen(false)
                                }}
                              >
                                Default model
                                <Check
                                  className={cn(
                                    'ml-auto h-4 w-4',
                                    !preferences?.yolo_model ||
                                      preferences.yolo_model === 'default'
                                      ? 'opacity-100'
                                      : 'opacity-0'
                                  )}
                                />
                              </CommandItem>
                              {cursorModelOptions.map(option => (
                                <CommandItem
                                  key={option.value}
                                  value={`${option.label} ${option.value}`}
                                  onSelect={() => {
                                    handleYoloModelChange(option.value)
                                    setYoloModelPopoverOpen(false)
                                  }}
                                >
                                  <span className="truncate">
                                    {option.label}
                                  </span>
                                  <Check
                                    className={cn(
                                      'ml-auto h-4 w-4',
                                      preferences?.yolo_model === option.value
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
                  ) : (
                    <Select
                      value={preferences?.yolo_model ?? 'default'}
                      onValueChange={handleYoloModelChange}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default model</SelectItem>
                        {(effectiveYoloBackend === 'codex'
                          ? remoteCodexDefaultModelOptions
                          : effectiveYoloBackend === 'commandcode'
                            ? commandCodeModelOptions
                            : remoteClaudeModelOptions
                        ).map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {yoloReasoning?.type === 'thinking' && (
                  <div>
                    <Select
                      value={preferences?.yolo_thinking_level ?? 'default'}
                      onValueChange={handleYoloThinkingLevelChange}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">
                          Default thinking
                        </SelectItem>
                        {yoloReasoning.levels.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                {yoloReasoning?.type === 'effort' && (
                  <div>
                    <Select
                      value={preferences?.yolo_effort_level ?? 'default'}
                      onValueChange={handleYoloEffortLevelChange}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">
                          Default reasoning
                        </SelectItem>
                        {yoloReasoning.levels.map(option => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </div>
            </InlineField>

            <AiLanguageField preferences={preferences} />

            <InlineField
              label="Allow web tools in plan mode"
              description="WebFetch/WebSearch for Claude, --search for Codex"
            >
              <Switch
                checked={preferences?.allow_web_tools_in_plan_mode ?? true}
                onCheckedChange={checked => {
                  if (preferences) {
                    patchPreferences.mutate({
                      allow_web_tools_in_plan_mode: checked,
                    })
                  }
                }}
              />
            </InlineField>

            {isNativeApp() && (
              <InlineField
                label="Editor"
                description="App to open worktrees in"
              >
                <Select
                  value={preferences?.editor ?? 'zed'}
                  onValueChange={handleEditorChange}
                >
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getEditorOptions().map(option => (
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
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getTerminalOptions().map(option => (
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
                  <SelectTrigger className="w-full sm:w-80">
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
              label="New Session"
              description="Default action for CMD+T"
            >
              <Select
                value={preferences?.default_new_session_kind ?? 'chat'}
                onValueChange={handleNewSessionKindChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {newSessionKindOptions.map(option => (
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
                <SelectTrigger className="w-full sm:w-80">
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
                <SelectTrigger className="w-full sm:w-80">
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

            <InlineField
              label="Auto-update AI backends"
              description="Install supported AI backend CLI updates, including Command Code, in the background as soon as a new version is detected."
            >
              <Switch
                checked={preferences?.auto_update_ai_backends ?? true}
                onCheckedChange={checked => {
                  if (preferences) {
                    patchPreferences.mutate({
                      auto_update_ai_backends: checked,
                    })
                  }
                }}
              />
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {isGeneralScope && (
        <>
          <SettingsSection
            title="Notifications"
            anchorId="pref-general-section-notifications"
          >
            <div className="space-y-4">
              <InlineField
                label="Desktop notifications"
                description="Show a native system banner when a session needs your input or finishes, but only while Jean is in the background."
              >
                <Switch
                  checked={preferences?.desktop_notifications_enabled ?? true}
                  onCheckedChange={handleDesktopNotificationsEnabledChange}
                />
              </InlineField>

              <InlineField
                label="Web access sounds"
                description="Applies only when using Jean in browser or mobile web access. Turn off to keep phone music uninterrupted."
              >
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="web-access-sounds-enabled"
                    checked={webAccessSoundsEnabled}
                    onCheckedChange={handleWebAccessSoundsEnabledChange}
                  />
                  <Label
                    htmlFor="web-access-sounds-enabled"
                    className="cursor-pointer text-sm"
                  >
                    Play Jean sounds in web access
                  </Label>
                </div>
              </InlineField>

              <InlineField
                label="Waiting sound"
                description="Play when session needs your input"
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.waiting_sound ?? 'none'}
                    onValueChange={handleWaitingSoundChange}
                  >
                    <SelectTrigger className="w-full sm:w-80">
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
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={
                      !preferences?.waiting_sound ||
                      preferences.waiting_sound === 'none' ||
                      !soundsEnabledInCurrentView
                    }
                    onClick={() =>
                      playNotificationSound(
                        preferences?.waiting_sound ?? 'none',
                        { webAccessSoundsEnabled }
                      )
                    }
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                </div>
              </InlineField>

              <InlineField
                label="Review sound"
                description="Play when session finishes"
              >
                <div className="flex items-center gap-2">
                  <Select
                    value={preferences?.review_sound ?? 'none'}
                    onValueChange={handleReviewSoundChange}
                  >
                    <SelectTrigger className="w-full sm:w-80">
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
                  <Button
                    variant="outline"
                    size="icon"
                    disabled={
                      !preferences?.review_sound ||
                      preferences.review_sound === 'none' ||
                      !soundsEnabledInCurrentView
                    }
                    onClick={() =>
                      playNotificationSound(
                        preferences?.review_sound ?? 'none',
                        {
                          webAccessSoundsEnabled,
                        }
                      )
                    }
                  >
                    <Play className="h-4 w-4" />
                  </Button>
                </div>
              </InlineField>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Auto-generate"
            anchorId="pref-general-section-auto-generate"
          >
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

          <SettingsSection
            title="Worktrees"
            anchorId="pref-general-section-worktrees"
          >
            <div className="space-y-4">
              <InlineField
                label="Auto-pull base branch"
                description="Pull the latest changes before creating a new worktree"
              >
                <Switch
                  checked={preferences?.auto_pull_base_branch ?? true}
                  onCheckedChange={checked => {
                    if (preferences) {
                      patchPreferences.mutate({
                        auto_pull_base_branch: checked,
                      })
                    }
                  }}
                />
              </InlineField>

              <InlineField
                label="Auto-save context"
                description="Automatically save session context after each AI response"
              >
                <Switch
                  checked={preferences?.auto_save_context ?? false}
                  onCheckedChange={checked => {
                    if (preferences) {
                      patchPreferences.mutate({
                        auto_save_context: checked,
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
                  checked={preferences?.restore_last_session ?? true}
                  onCheckedChange={checked => {
                    if (preferences) {
                      patchPreferences.mutate({
                        restore_last_session: checked,
                      })
                    }
                  }}
                />
              </InlineField>

              <InlineField
                label="Expand tool calls by default"
                description="Automatically expand tool call details in chat instead of showing a collapsed summary"
              >
                <Switch
                  checked={preferences?.expand_tool_calls_by_default ?? false}
                  onCheckedChange={checked => {
                    if (preferences) {
                      patchPreferences.mutate({
                        expand_tool_calls_by_default: checked,
                      })
                    }
                  }}
                />
              </InlineField>
            </div>
          </SettingsSection>

          <SettingsSection
            title="Archive"
            anchorId="pref-general-section-archive"
          >
            <div className="space-y-4">
              <InlineField
                label="Confirm before closing"
                description="Show confirmation dialog when closing sessions or worktrees"
              >
                <Switch
                  checked={preferences?.confirm_session_close ?? true}
                  onCheckedChange={checked => {
                    if (preferences) {
                      patchPreferences.mutate({
                        confirm_session_close: checked,
                      })
                    }
                  }}
                />
              </InlineField>

              <InlineField
                label="Close original session on clear context"
                description="Automatically close the original session when using Clear Context and yolo"
              >
                <Switch
                  checked={preferences?.close_original_on_clear_context ?? true}
                  onCheckedChange={checked => {
                    if (preferences) {
                      patchPreferences.mutate({
                        close_original_on_clear_context: checked,
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
                      patchPreferences.mutate({
                        removal_behavior: value,
                      })
                    }
                  }}
                >
                  <SelectTrigger className="w-full sm:w-80">
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
                      patchPreferences.mutate({
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
                  <SelectTrigger className="w-full sm:w-80">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {archiveRetentionOptions.map(option => (
                      <SelectItem
                        key={option.value}
                        value={String(option.value)}
                      >
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

          {isNativeApp() && (
            <SettingsSection
              title="Troubleshooting"
              anchorId="pref-general-section-troubleshooting"
            >
              <div className="space-y-4">
                <InlineField
                  label="Application logs"
                  description="Open the log directory for troubleshooting"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={async () => {
                      try {
                        await invoke('open_log_directory')
                      } catch (error) {
                        toast.error(`Failed to open logs: ${error}`)
                      }
                    }}
                  >
                    Show Logs
                  </Button>
                </InlineField>
              </div>
            </SettingsSection>
          )}

          <SettingsSection
            title="Version"
            anchorId="pref-general-section-version"
          >
            <div className="space-y-4">
              <InlineField label="Jean" description="Application version">
                <span className="font-mono text-sm text-muted-foreground">
                  v{CLIENT_BUILD_INFO.appVersion}
                </span>
              </InlineField>

              {CLIENT_BUILD_INFO.gitSha && (
                <InlineField
                  label="Commit"
                  description="Source commit used for this build"
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                    <button
                      type="button"
                      onClick={() =>
                        openExternal(
                          `https://github.com/coollabsio/jean/commit/${CLIENT_BUILD_INFO.gitSha}`
                        )
                      }
                      className="font-mono hover:text-foreground hover:underline"
                    >
                      {CLIENT_BUILD_INFO.gitSha}
                    </button>
                    {CLIENT_BUILD_INFO.builtAt && (
                      <span>
                        · {new Date(CLIENT_BUILD_INFO.builtAt).toLocaleString()}
                      </span>
                    )}
                  </div>
                </InlineField>
              )}
            </div>
          </SettingsSection>
        </>
      )}

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
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {isDeleting ? 'Deleting...' : 'Delete All'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteCliTarget !== null}
        onOpenChange={open => {
          if (!open) setDeleteCliTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Delete Jean-managed{' '}
              {deleteCliTarget === 'claude'
                ? 'Claude CLI'
                : deleteCliTarget === 'codex'
                  ? 'Codex CLI'
                  : deleteCliTarget === 'opencode'
                    ? 'OpenCode CLI'
                    : deleteCliTarget === 'coderabbit'
                      ? 'CodeRabbit CLI'
                      : deleteCliTarget === 'commandcode'
                        ? 'Command Code CLI'
                        : deleteCliTarget === 'grok'
                          ? 'Grok CLI'
                          : deleteCliTarget === 'kimi'
                            ? 'Kimi Code CLI'
                            : deleteCliTarget === 'pi'
                              ? 'PI CLI'
                              : 'GitHub CLI'}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const pathFound =
                  deleteCliTarget === 'claude'
                    ? pathDetection?.found
                    : deleteCliTarget === 'codex'
                      ? codexPathDetection?.found
                      : deleteCliTarget === 'opencode'
                        ? opencodePathDetection?.found
                        : deleteCliTarget === 'gh'
                          ? ghPathDetection?.found
                          : deleteCliTarget === 'coderabbit'
                            ? coderabbitPathDetection?.found
                            : deleteCliTarget === 'commandcode'
                              ? commandcodePathDetection?.found
                              : deleteCliTarget === 'grok'
                                ? grokPathDetection?.found
                                : deleteCliTarget === 'kimi'
                                  ? kimiPathDetection?.found
                                  : deleteCliTarget === 'pi'
                                    ? piPathDetection?.found
                                    : false
                return pathFound
                  ? 'The Jean-managed binary will be removed and the source will switch to System PATH. You can reinstall it later from this page.'
                  : 'The Jean-managed binary will be removed. No System PATH version was detected, so this backend will be unavailable until you reinstall it.'
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeletingCli}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDeleteCli}
              disabled={isDeletingCli}
              className="bg-destructive text-white hover:bg-destructive/90"
            >
              {isDeletingCli ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

export const WslSettingsSection: FC<{
  preferences: AppPreferences | undefined
  patchPreferences: ReturnType<typeof usePatchPreferences>
}> = ({ preferences, patchPreferences }) => {
  const [distros, setDistros] = useState<string[]>([])
  const [loadingDistros, setLoadingDistros] = useState(false)
  const [toolStatus, setToolStatus] = useState<string>('')
  const [isChoosingWsl, setIsChoosingWsl] = useState(false)
  const queryClient = useQueryClient()
  const wslEnabled = preferences?.wsl_enabled ?? false
  const showWslDistroSelect = wslEnabled || isChoosingWsl

  // Toggling WSL mode changes where CLI detection, status, and auth checks
  // look for binaries — bust the cached results so subsequent reads fetch
  // against the new target (WSL distro vs Windows host).
  const invalidateCliCaches = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['claude-cli'] })
    void queryClient.invalidateQueries({ queryKey: ['codex-cli'] })
    void queryClient.invalidateQueries({ queryKey: ['opencode-cli'] })
    void queryClient.invalidateQueries({ queryKey: ['gh-cli'] })
    void queryClient.invalidateQueries({ queryKey: ['cursor-cli'] })
    void queryClient.invalidateQueries({ queryKey: ['coderabbit-cli'] })
    void queryClient.invalidateQueries({ queryKey: ['commandcode-cli'] })
  }, [queryClient])

  // Load available distros
  useEffect(() => {
    setLoadingDistros(true)
    invoke<string[]>('list_wsl_distros')
      .then(setDistros)
      .catch(() => setDistros([]))
      .finally(() => setLoadingDistros(false))
  }, [])

  // Check tools when distro changes
  useEffect(() => {
    if (!preferences?.wsl_enabled || !preferences?.wsl_distro) {
      setToolStatus('')
      return
    }
    invoke<boolean>('check_wsl_tool', {
      distro: preferences.wsl_distro,
      tool: 'git',
    })
      .then(hasGit => {
        setToolStatus(hasGit ? 'git found' : 'git not found in WSL')
      })
      .catch(() => setToolStatus(''))
  }, [preferences?.wsl_enabled, preferences?.wsl_distro])

  return (
    <SettingsSection title="WSL">
      <div className="space-y-4">
        <InlineField
          label="Use WSL"
          description="Route commands through Windows Subsystem for Linux"
        >
          <Switch
            checked={showWslDistroSelect}
            onCheckedChange={checked => {
              if (checked) {
                setIsChoosingWsl(true)
                return
              }
              setIsChoosingWsl(false)
              patchPreferences.mutate(
                {
                  wsl_enabled: false,
                  wsl_mode_chosen: true,
                },
                { onSuccess: invalidateCliCaches }
              )
            }}
          />
        </InlineField>

        {showWslDistroSelect && (
          <>
            <InlineField
              label="Distribution"
              description={toolStatus || 'Select your WSL distribution'}
            >
              {loadingDistros ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Loading...
                </div>
              ) : (
                <Select
                  value={wslEnabled ? preferences?.wsl_distro || '' : ''}
                  onValueChange={async value => {
                    if (!value || !distros.includes(value)) {
                      return
                    }
                    setToolStatus('Checking for git...')
                    try {
                      const hasGit = await invoke<boolean>('check_wsl_tool', {
                        distro: value,
                        tool: 'git',
                      })
                      if (!hasGit) {
                        setToolStatus(
                          'git not found. Install it inside WSL: sudo apt install git'
                        )
                        return
                      }
                    } catch {
                      setToolStatus('Failed to check WSL distro')
                      return
                    }
                    patchPreferences.mutate(
                      {
                        wsl_enabled: true,
                        wsl_distro: value,
                        wsl_mode_chosen: true,
                      },
                      {
                        onSuccess: () => {
                          setIsChoosingWsl(false)
                          invalidateCliCaches()
                        },
                      }
                    )
                  }}
                >
                  <SelectTrigger className="w-full sm:w-48">
                    <SelectValue placeholder="Select distro" />
                  </SelectTrigger>
                  <SelectContent>
                    {distros.map(d => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </InlineField>

            <div className="text-xs text-muted-foreground">
              CLI tools must be installed inside your WSL distribution.
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  )
}
