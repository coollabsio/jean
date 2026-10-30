import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useSettingsTargetServerId } from '@/lib/settings-target'
import React, {
  useState,
  useCallback,
  useMemo,
  useEffect,
  useRef,
  type FC,
} from 'react'
import { invoke, signOutOfWebAccess } from '@/lib/transport'
import { loginArgsForBackend } from '@/lib/cli-auth'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import {
  Loader2,
  Check,
  ChevronsUpDown,
  LogOut,
  Play,
} from '@/components/icons/reicon'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Button } from '@/components/ui/button'
import { BackendLabel } from '@/components/ui/backend-label'
import { BetaBadge } from '@/components/ui/badge'
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
  useGlabCliStatus,
  useGlabCliAuth,
  useGlabPathDetection,
  useAvailableGlabVersions,
  glabCliQueryKeys,
} from '@/services/glab-cli'
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
import {
  useAvailableDevinModels,
  useDevinCliAuth,
  useDevinCliStatus,
  useDevinPathDetection,
  devinCliQueryKeys,
} from '@/services/devin-cli'
import type { ClaudeAuthStatus } from '@/types/claude-cli'
import type { GhAuthStatus } from '@/types/gh-cli'
import type { GlabAuthStatus } from '@/types/glab-cli'
import type { CodexAuthStatus } from '@/types/codex-cli'
import type { CodeRabbitAuthStatus } from '@/types/coderabbit-cli'
import type { OpenCodeAuthStatus } from '@/types/opencode-cli'
import type { CursorAuthStatus } from '@/types/cursor-cli'
import type { PiAuthStatus } from '@/types/pi-cli'
import type { CommandCodeAuthStatus } from '@/types/commandcode-cli'
import type { GrokAuthStatus } from '@/types/grok-cli'
import type { KimiAuthStatus } from '@/types/kimi-cli'
import type { DevinAuthStatus } from '@/types/devin-cli'
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
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  getCatalogDefaultModelOptions,
  getCatalogModelOptions,
  getCatalogModelReasoning,
  useModelCatalog,
} from '@/services/model-catalog'
import { withAdaptiveEffortOption } from '@/components/chat/toolbar/toolbar-options'
import type { AppPreferences } from '@/types/preferences'
import {
  codexReasoningOptions,
  codexModelVerbosityOptions,
  grokReasoningOptions,
  backendOptions,
  getTerminalOptions,
  getEditorOptions,
  notificationSoundOptions,
  type ClaudeModel,
  getClaudeModelOptionsForProvider,
  type CodexModel,
  type CodexGoalExecutionMode,
  type CodexReasoningEffort,
  type CodexModelVerbosity,
  type GrokReasoningEffort,
  type CursorModel,
  type PiModel,
  type GrokModel,
  type KimiModel,
  type DevinModel,
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
  DEVIN_MODEL_OPTIONS,
  KIMI_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import {
  formatCursorModelLabel,
  formatGrokModelOptionLabel,
  formatOpencodeModelLabel,
  formatPiModelLabel,
} from '@/components/chat/toolbar/toolbar-utils'
import { playNotificationSound } from '@/lib/sounds'
import { CLIENT_BUILD_INFO } from '@/lib/build-info'
import { getActiveRemoteConnection } from '@/lib/remote-connections'
import {
  fetchRemoteServerInfo,
  formatJeanVersionLabel,
} from '@/lib/remote-version'
import {
  getSupportedPermissionModes,
  type ThinkingLevel,
  type EffortLevel,
  type ExecutionMode,
} from '@/types/chat'
import {
  hasBackend,
  isNativeApp,
  webAccessServerLabel,
} from '@/lib/environment'
import { isWindows, openExternal } from '@/lib/platform'
import { isNewerVersion } from '@/lib/version-utils'
import { cn } from '@/lib/utils'
import { getPathUpdateAction } from '@/lib/cli-update'
import { SettingsSection } from '../SettingsSection'
import { InlineField } from '../InlineField'
import { CliAuthActions } from '../CliAuthActions'
import {
  CliChangeVersionButton,
  CliInstallFields,
  CliUpdateButton,
} from '../CliInstallFields'
import { AiLanguageField } from './AiLanguageField'
import { BrowserDefaultHostField } from './BrowserDefaultHostField'
import { resolveOverrideReasoning } from './override-reasoning'
import {
  resolveDefaultModelForBackend,
  resolvePiDefaultModel,
} from '@/lib/session-defaults'

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
  | 'devin'
  | 'github'
  | 'coderabbit'

const backendPaneScopes: readonly PreferencesPaneScope[] = [
  'claude',
  'codex',
  'opencode',
  'cursor',
  'pi',
  'commandcode',
  'grok',
  'kimi',
  'devin',
]

function formatOpenCodeModelLabelForSettings(value: string) {
  const formatted = formatOpencodeModelLabel(value)
  return value.startsWith('opencode/')
    ? formatted.replace(/\s+\(OpenCode\)$/, '')
    : formatted
}

export const GeneralPane: React.FC<{ scope?: PreferencesPaneScope }> = ({
  scope = 'general',
}) => {
  const isGeneralScope = scope === 'general'
  const serverId = useSettingsTargetServerId()
  const { installedBackends } = useInstalledBackends({
    enabled: isGeneralScope,
    serverId,
  })
  const queryClient = useQueryClient()
  const activeRemoteConnection = getActiveRemoteConnection()
  const { data: remoteServerInfo, isLoading: isRemoteServerInfoLoading } =
    useQuery({
      queryKey: ['remote-server-info', activeRemoteConnection?.id],
      queryFn: () => {
        if (!activeRemoteConnection) {
          throw new Error('No remote Jean server is connected.')
        }
        return fetchRemoteServerInfo(
          activeRemoteConnection.url,
          activeRemoteConnection.token
        )
      },
      enabled: isGeneralScope && activeRemoteConnection !== null,
      staleTime: 60_000,
    })
  const remoteServerVersion = remoteServerInfo?.appVersion
  const { data: preferences } = usePreferences()
  const { data: modelCatalog } = useModelCatalog()
  const codexReasoning = getCatalogModelReasoning(
    modelCatalog,
    'codex',
    preferences?.selected_codex_model ?? 'gpt-6.1-sol'
  )
  const selectedCodexModel = preferences?.selected_codex_model ?? 'gpt-6.1-sol'
  const selectedCodexReasoningOptions = withAdaptiveEffortOption(
    codexReasoning?.type === 'effort'
      ? codexReasoning.levels
      : codexReasoningOptions,
    selectedCodexModel
  )
  const grokReasoning = getCatalogModelReasoning(
    modelCatalog,
    'grok',
    preferences?.selected_grok_model ?? 'grok/grok-4.6'
  )
  const selectedGrokModel = preferences?.selected_grok_model ?? 'grok/grok-4.6'
  const selectedGrokReasoningOptions = withAdaptiveEffortOption(
    grokReasoning?.type === 'effort'
      ? grokReasoning.levels
      : grokReasoningOptions,
    selectedGrokModel
  )
  const selectedClaudeModel = preferences?.selected_model ?? 'claude-opus-5-5'
  const claudeReasoning = getCatalogModelReasoning(
    modelCatalog,
    'claude',
    selectedClaudeModel
  )
  const selectedClaudeReasoningOptions = claudeReasoning
    ? withAdaptiveEffortOption(claudeReasoning.levels, selectedClaudeModel)
    : []
  const patchPreferences = usePatchPreferences()
  const isWebAccessView = !isNativeApp()
  const webAccessSoundsEnabled = preferences?.web_access_sounds_enabled ?? true
  const soundsEnabledInCurrentView = !isWebAccessView || webAccessSoundsEnabled
  const [deleteCliTarget, setDeleteCliTarget] = useState<
    | 'claude'
    | 'codex'
    | 'opencode'
    | 'pi'
    | 'gh'
    | 'glab'
    | 'coderabbit'
    | 'commandcode'
    | 'grok'
    | 'kimi'
    | 'devin'
    | null
  >(null)
  const [isDeletingCli, setIsDeletingCli] = useState(false)

  const customCliProfiles = useMemo(
    () => preferences?.custom_cli_profiles ?? [],
    [preferences?.custom_cli_profiles]
  )
  const defaultClaudeProvider = preferences?.default_provider ?? null
  const remoteClaudeModelOptions = useMemo(() => {
    // When a custom CLI provider is the global default, surface the
    // provider-routed opus/sonnet/haiku aliases so Settings → Claude can set
    // a matching default model (issue #418).
    const options = defaultClaudeProvider
      ? getClaudeModelOptionsForProvider(
          defaultClaudeProvider,
          customCliProfiles
        )
      : getCatalogModelOptions(modelCatalog, 'claude')
    const selected = preferences?.selected_model
    if (selected && !options.some(option => option.value === selected)) {
      return [...options, { value: selected as ClaudeModel, label: selected }]
    }
    return options
  }, [
    modelCatalog,
    defaultClaudeProvider,
    customCliProfiles,
    preferences?.selected_model,
  ])
  const remoteCodexDefaultModelOptions = useMemo(
    () => getCatalogDefaultModelOptions(modelCatalog, 'codex'),
    [modelCatalog]
  )

  // PATH detection
  const { data: pathDetection } = useClaudePathDetection()
  const { data: codexPathDetection } = useCodexPathDetection()
  const { data: opencodePathDetection } = useOpenCodePathDetection()
  const { data: ghPathDetection } = useGhPathDetection()
  const { data: glabPathDetection } = useGlabPathDetection()
  const { data: coderabbitPathDetection } = useCodeRabbitPathDetection()
  const { data: cursorPathDetection } = useCursorPathDetection()
  const { data: piPathDetection } = usePiPathDetection()
  const { data: commandcodePathDetection } = useCommandCodePathDetection()
  const { data: grokPathDetection } = useGrokPathDetection()
  const { data: kimiPathDetection } = useKimiPathDetection()
  const { data: devinPathDetection } = useDevinPathDetection()

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
  const { data: glabStatus, isLoading: isGlabLoading } = useGlabCliStatus()
  const { data: cursorStatus, isLoading: isCursorLoading } =
    useCursorCliStatus()
  const { data: piStatus, isLoading: isPiLoading } = usePiCliStatus()
  const { data: commandcodeStatus, isLoading: isCommandCodeLoading } =
    useCommandCodeCliStatus()
  const { data: grokStatus, isLoading: isGrokLoading } = useGrokCliStatus()
  const { data: kimiStatus, isLoading: isKimiLoading } = useKimiCliStatus()
  const { data: devinStatus, isLoading: isDevinLoading } = useDevinCliStatus()
  const isGhPathSource = preferences?.gh_cli_source === 'path'
  const { data: ghVersions, isLoading: isGhVersionsLoading } =
    useAvailableGhVersions({ enabled: isGhPathSource && !!ghStatus?.installed })
  const ghLatestStable = ghVersions?.find(v => !v.prerelease)
  const ghHasUpdate =
    !!ghStatus?.version &&
    !!ghLatestStable &&
    isNewerVersion(ghLatestStable.version, ghStatus.version)
  const isGlabPathSource = preferences?.glab_cli_source === 'path'
  const { data: glabVersions, isLoading: isGlabVersionsLoading } =
    useAvailableGlabVersions({
      enabled: isGlabPathSource && !!glabStatus?.installed,
    })
  const glabLatestStable = glabVersions?.find(v => !v.prerelease)
  const glabHasUpdate =
    !!glabStatus?.version &&
    !!glabLatestStable &&
    isNewerVersion(glabLatestStable.version, glabStatus.version)
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
  const { data: glabAuth, isLoading: isGlabAuthLoading } = useGlabCliAuth({
    enabled: !!glabStatus?.installed,
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
  const { data: devinAuth, isLoading: isDevinAuthLoading } = useDevinCliAuth({
    enabled: !!devinStatus?.installed,
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
  const { data: availableDevinModels } = useAvailableDevinModels({
    enabled: !!devinStatus?.installed,
  })

  // Re-check CLI status when the source preference changes (handles initial load
  // with source already set to "path" and any timing issues with onSuccess invalidation)
  const prevSources = useRef({
    claude: preferences?.claude_cli_source,
    gh: preferences?.gh_cli_source,
    glab: preferences?.glab_cli_source,
    codex: preferences?.codex_cli_source,
    opencode: preferences?.opencode_cli_source,
    pi: preferences?.pi_cli_source,
    grok: preferences?.grok_cli_source,
    kimi: preferences?.kimi_cli_source,
    devin: preferences?.devin_cli_source,
    coderabbit: preferences?.coderabbit_cli_source,
    commandcode: preferences?.commandcode_cli_source,
  })
  useEffect(() => {
    const cur = {
      claude: preferences?.claude_cli_source,
      gh: preferences?.gh_cli_source,
      glab: preferences?.glab_cli_source,
      codex: preferences?.codex_cli_source,
      opencode: preferences?.opencode_cli_source,
      pi: preferences?.pi_cli_source,
      grok: preferences?.grok_cli_source,
      kimi: preferences?.kimi_cli_source,
      devin: preferences?.devin_cli_source,
      coderabbit: preferences?.coderabbit_cli_source,
      commandcode: preferences?.commandcode_cli_source,
    }
    if (cur.claude !== prevSources.current.claude) {
      queryClient.invalidateQueries({ queryKey: claudeCliQueryKeys.status() })
    }
    if (cur.gh !== prevSources.current.gh) {
      queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.status() })
    }
    if (cur.glab !== prevSources.current.glab) {
      queryClient.invalidateQueries({ queryKey: glabCliQueryKeys.status() })
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
    if (cur.devin !== prevSources.current.devin) {
      queryClient.invalidateQueries({ queryKey: devinCliQueryKeys.status() })
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
    preferences?.glab_cli_source,
    preferences?.codex_cli_source,
    preferences?.opencode_cli_source,
    preferences?.pi_cli_source,
    preferences?.grok_cli_source,
    preferences?.kimi_cli_source,
    preferences?.devin_cli_source,
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
  const [checkingGlabAuth, setCheckingGlabAuth] = useState(false)
  const [checkingCodexAuth, setCheckingCodexAuth] = useState(false)
  const [checkingCodeRabbitAuth, setCheckingCodeRabbitAuth] = useState(false)
  const [checkingOpenCodeAuth, setCheckingOpenCodeAuth] = useState(false)
  const [checkingCursorAuth, setCheckingCursorAuth] = useState(false)
  const [checkingPiAuth, setCheckingPiAuth] = useState(false)
  const [checkingCommandCodeAuth, setCheckingCommandCodeAuth] = useState(false)
  const [checkingGrokAuth, setCheckingGrokAuth] = useState(false)
  const [checkingKimiAuth, setCheckingKimiAuth] = useState(false)
  const [checkingDevinAuth, setCheckingDevinAuth] = useState(false)
  const [openCodeModelPopoverOpen, setOpenCodeModelPopoverOpen] =
    useState(false)
  const [cursorModelPopoverOpen, setCursorModelPopoverOpen] = useState(false)
  const [piModelPopoverOpen, setPiModelPopoverOpen] = useState(false)
  const [buildModelPopoverOpen, setBuildModelPopoverOpen] = useState(false)
  const [yoloModelPopoverOpen, setYoloModelPopoverOpen] = useState(false)

  // Use global ui-store for CLI modals
  const openCliUpdateModal = useUIStore(state => state.openCliUpdateModal)
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)

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

  const handleDevinSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { devin_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: devinCliQueryKeys.all })
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
      glab: { name: 'GitLab CLI', cmd: 'uninstall_glab_cli' as const },
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
      devin: { name: 'Devin CLI', cmd: 'uninstall_devin_cli' as const },
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
                        : target === 'devin'
                          ? 'devin_cli_source'
                          : target === 'glab'
                            ? 'glab_cli_source'
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
                        : target === 'devin'
                          ? devinCliQueryKeys.all
                          : target === 'glab'
                            ? glabCliQueryKeys.all
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
                        : target === 'devin'
                          ? devinPathDetection?.found
                          : target === 'glab'
                            ? glabPathDetection?.found
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

  const handleGlabSourceChange = (value: 'jean' | 'path') => {
    if (preferences) {
      patchPreferences.mutate(
        { glab_cli_source: value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({ queryKey: glabCliQueryKeys.all })
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

  // Default backend: show all installed CLIs (issue #627/#649). Auth is enforced
  // at send time / backend settings — hiding unauthenticated backends made Claude
  // (and others) disappear from Defaults when auth probes were false-negative.
  const stored = preferences?.default_backend ?? 'claude'
  const installedBackendOptions = useMemo(
    () =>
      // react-doctor-disable-next-line react-doctor/js-set-map-lookups -- fixed handful of backends
      backendOptions.filter(option => installedBackends.includes(option.value)),
    [installedBackends]
  )
  const effectiveBackend = installedBackends.includes(stored)
    ? stored
    : (installedBackendOptions[0]?.value ?? stored)

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

  const handleDevinModelChange = (value: DevinModel) => {
    if (preferences) {
      patchPreferences.mutate({ selected_devin_model: value })
    }
  }

  const selectedOpenCodeModel =
    preferences?.selected_opencode_model ?? 'opencode/gpt-6.1-sol'
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
  const grokModelOptions: { value: GrokModel; label: string }[] = (
    availableGrokModels?.length
      ? availableGrokModels.map(model => ({
          value: `grok/${model.id}` as GrokModel,
          label: formatGrokModelOptionLabel(`grok/${model.id}`, model.label),
        }))
      : (GROK_MODEL_OPTIONS as { value: GrokModel; label: string }[])
  ).map(option => ({
    value: option.value,
    label: formatGrokModelOptionLabel(option.value, option.label),
  }))
  const selectedGrokModelLabel =
    grokModelOptions.find(option => option.value === selectedGrokModel)
      ?.label ?? formatGrokModelOptionLabel(selectedGrokModel)
  const selectedKimiModel = preferences?.selected_kimi_model ?? 'kimi/default'
  const kimiModelOptions: { value: KimiModel; label: string }[] = [
    ...(KIMI_MODEL_OPTIONS as { value: KimiModel; label: string }[]),
    ...(availableKimiModels ?? []).flatMap(model =>
      model.id === 'default'
        ? []
        : [
            {
              value: `kimi/${model.id}` as KimiModel,
              label: model.isDefault ? `${model.label} (default)` : model.label,
            },
          ]
    ),
  ]
  const selectedKimiModelLabel =
    kimiModelOptions.find(option => option.value === selectedKimiModel)
      ?.label ?? selectedKimiModel.replace(/^kimi\//, '')
  const selectedDevinModel =
    preferences?.selected_devin_model ?? 'devin/default'
  const devinModelOptions: { value: DevinModel; label: string }[] = [
    ...(DEVIN_MODEL_OPTIONS as { value: DevinModel; label: string }[]),
    ...(availableDevinModels ?? [])
      .filter(model => model.id !== 'default')
      .map(model => ({
        value: `devin/${model.id}` as DevinModel,
        label: model.isDefault ? `${model.label} (default)` : model.label,
      })),
  ]
  const selectedDevinModelLabel =
    devinModelOptions.find(option => option.value === selectedDevinModel)
      ?.label ?? selectedDevinModel.replace(/^devin\//, '')
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
  const buildReasoningRaw = resolveOverrideReasoning(
    modelCatalog,
    effectiveBuildBackend,
    buildModel
  )
  const buildReasoning = buildReasoningRaw
    ? {
        ...buildReasoningRaw,
        levels: withAdaptiveEffortOption(buildReasoningRaw.levels, buildModel),
      }
    : null
  const yoloReasoningRaw = resolveOverrideReasoning(
    modelCatalog,
    effectiveYoloBackend,
    yoloModel
  )
  const yoloReasoning = yoloReasoningRaw
    ? {
        ...yoloReasoningRaw,
        levels: withAdaptiveEffortOption(yoloReasoningRaw.levels, yoloModel),
      }
    : null
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
  const devinAuthMessage = devinAuth?.timedOut
    ? 'Auth check timed out. Try again or run `devin auth login` manually.'
    : devinAuth?.error

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

  const handleClaudeAutoSteerToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        claude_auto_steer_enabled: enabled,
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

  const handlePiAgentOwnsPolicyToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        pi_agent_owns_policy: enabled,
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

  const handleDevinAutoSteerToggle = (enabled: boolean) => {
    if (preferences) {
      patchPreferences.mutate({
        devin_auto_steer_enabled: enabled,
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
        queryKey: [...claudeCliQueryKeys.auth(), serverId],
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
    serverId,
  ])

  const handleGhLogin = useCallback(async () => {
    if (!ghStatus?.path) return

    // First check if already authenticated
    setCheckingGhAuth(true)
    try {
      // Invalidate cache and refetch to get fresh status
      await queryClient.invalidateQueries({ queryKey: ghCliQueryKeys.auth() })
      const result = await queryClient.fetchQuery<GhAuthStatus>({
        queryKey: [...ghCliQueryKeys.auth(), serverId],
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
  }, [ghStatus?.path, openCliLoginModal, queryClient, serverId])

  const handleGlabLogin = useCallback(async () => {
    if (!glabStatus?.path) return

    // First check if already authenticated
    setCheckingGlabAuth(true)
    try {
      // Invalidate cache and refetch to get fresh status
      await queryClient.invalidateQueries({ queryKey: glabCliQueryKeys.auth() })
      const result = await queryClient.fetchQuery<GlabAuthStatus>({
        queryKey: [...glabCliQueryKeys.auth(), serverId],
      })

      if (result?.authenticated) {
        toast.success('GitLab CLI is already authenticated')
        return
      }
    } finally {
      setCheckingGlabAuth(false)
    }

    // Not authenticated, open login modal
    openCliLoginModal('glab', glabStatus.path, ['auth', 'login'])
  }, [glabStatus?.path, openCliLoginModal, queryClient, serverId])

  const handleCodexLogin = useCallback(async () => {
    if (!codexStatus?.path) return

    setCheckingCodexAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: codexCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<CodexAuthStatus>({
        queryKey: [...codexCliQueryKeys.auth(), serverId],
      })

      if (result?.authenticated) {
        toast.success('Codex CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCodexAuth(false)
    }

    // Not authenticated, open login modal (device-code auth for terminal/headless)
    openCliLoginModal('codex', codexStatus.path, loginArgsForBackend('codex'))
  }, [codexStatus?.path, openCliLoginModal, queryClient, serverId])

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
        queryKey: [...opencodeCliQueryKeys.auth(), serverId],
      })

      if (result?.authenticated) {
        toast.success('OpenCode CLI is already authenticated')
        return
      }
    } finally {
      setCheckingOpenCodeAuth(false)
    }

    openCliLoginModal('opencode', opencodeStatus.path, ['auth', 'login'])
  }, [opencodeStatus?.path, openCliLoginModal, queryClient, serverId])

  const handleClaudeRelogin = useCallback(() => {
    if (!cliStatus?.path) return
    const args = cliStatus.supports_auth_command ? ['auth', 'login'] : ['login']
    openCliLoginModal('claude', cliStatus.path, args)
  }, [cliStatus?.path, cliStatus?.supports_auth_command, openCliLoginModal])

  const handleGhRelogin = useCallback(() => {
    if (!ghStatus?.path) return
    openCliLoginModal('gh', ghStatus.path, ['auth', 'login'])
  }, [ghStatus?.path, openCliLoginModal])

  const handleGlabRelogin = useCallback(() => {
    if (!glabStatus?.path) return
    openCliLoginModal('glab', glabStatus.path, ['auth', 'login'])
  }, [glabStatus?.path, openCliLoginModal])

  const handleCodexRelogin = useCallback(() => {
    if (!codexStatus?.path) return
    openCliLoginModal('codex', codexStatus.path, loginArgsForBackend('codex'))
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
        queryKey: [...cursorCliQueryKeys.auth(), serverId],
      })

      if (result?.authenticated) {
        toast.success('Cursor CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCursorAuth(false)
    }

    openCliLoginModal('cursor', cursorStatus.path, ['login'])
  }, [cursorStatus?.path, openCliLoginModal, queryClient, serverId])

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
        queryKey: [...piCliQueryKeys.auth(), serverId],
      })
      if (result?.authenticated) {
        toast.success('PI CLI is already authenticated')
        return
      }
    } finally {
      setCheckingPiAuth(false)
    }
    openCliLoginModal('pi', piStatus.path, [])
  }, [piStatus?.path, openCliLoginModal, queryClient, serverId])

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
        queryKey: [...commandcodeCliQueryKeys.auth(), serverId],
      })
      if (result?.authenticated) {
        toast.success('Command Code CLI is already authenticated')
        return
      }
    } finally {
      setCheckingCommandCodeAuth(false)
    }
    openCliLoginModal('commandcode', commandcodeStatus.path, ['login'])
  }, [commandcodeStatus?.path, openCliLoginModal, queryClient, serverId])

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
        queryKey: [...grokCliQueryKeys.auth(), serverId],
      })
      if (result?.authenticated) {
        toast.success('Grok CLI is already authenticated')
        return
      }
    } finally {
      setCheckingGrokAuth(false)
    }
    openCliLoginModal('grok', grokStatus.path, ['login'])
  }, [grokStatus?.path, openCliLoginModal, queryClient, serverId])

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
        queryKey: [...kimiCliQueryKeys.auth(), serverId],
      })
      if (result?.authenticated) {
        toast.success('Kimi Code CLI is already authenticated')
        return
      }
    } finally {
      setCheckingKimiAuth(false)
    }
    openCliLoginModal('kimi', kimiStatus.path, ['login'])
  }, [kimiStatus?.path, openCliLoginModal, queryClient, serverId])

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

  const handleDevinLogin = useCallback(async () => {
    if (!devinStatus?.path) return
    setCheckingDevinAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: devinCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<DevinAuthStatus>({
        queryKey: devinCliQueryKeys.auth(),
      })
      if (result?.authenticated) {
        toast.success('Devin CLI is already authenticated')
        return
      }
    } finally {
      setCheckingDevinAuth(false)
    }
    openCliLoginModal('devin', devinStatus.path, ['auth', 'login'])
  }, [devinStatus?.path, openCliLoginModal, queryClient])

  const handleDevinRelogin = useCallback(() => {
    if (!devinStatus?.path) return
    openCliLoginModal('devin', devinStatus.path, ['auth', 'login'])
  }, [devinStatus?.path, openCliLoginModal])

  const handleDevinInstall = useCallback(() => {
    if (preferences?.devin_cli_source !== 'jean') {
      patchPreferences.mutate({ devin_cli_source: 'jean' })
    }
    openCliUpdateModal('devin')
  }, [openCliUpdateModal, patchPreferences, preferences?.devin_cli_source])

  return (
    <div
      className={cn('space-y-6', backendPaneScopes.includes(scope) && 'w-full')}
    >
      {hasBackend() && scope === 'claude' && (
        <SettingsSection
          title="CLI"
          anchorId="pref-claude-section-cli"
          actions={
            <CliAuthActions
              installed={!!cliStatus?.installed}
              checking={checkingClaudeAuth || isClaudeAuthLoading}
              authenticated={!!claudeAuth?.authenticated}
              onSignIn={handleClaudeLogin}
              onSignInAgain={handleClaudeRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="Claude CLI"
            binary="claude"
            source={preferences?.claude_cli_source ?? 'jean'}
            onSourceChange={handleClaudeSourceChange}
            pathDetection={pathDetection}
            activePath={
              preferences?.claude_cli_source === 'path'
                ? pathDetection?.path
                : cliStatus?.path
            }
            loading={isCliLoading}
            installed={!!cliStatus?.installed}
            version={cliStatus?.version}
            onInstall={() => openCliUpdateModal('claude')}
            onUninstall={() => setDeleteCliTarget('claude')}
            actions={
              isPathSource ? (
                <CliUpdateButton
                  checking={isClaudeVersionsLoading}
                  hasUpdate={claudeHasUpdate}
                  latestVersion={claudeLatestStable?.version}
                  onUpdate={() => {
                    const action = getPathUpdateAction(
                      cliStatus?.path,
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
                />
              ) : (
                <CliChangeVersionButton
                  onClick={() => openCliUpdateModal('claude')}
                />
              )
            }
          />
        </SettingsSection>
      )}

      {hasBackend() && scope === 'github' && (
        <SettingsSection
          title="GitHub CLI"
          anchorId="pref-github-section-cli"
          actions={
            <CliAuthActions
              installed={!!ghStatus?.installed}
              checking={checkingGhAuth || isGhAuthLoading}
              authenticated={!!ghAuth?.authenticated}
              onSignIn={handleGhLogin}
              onSignInAgain={handleGhRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="GitHub CLI"
            binary="gh"
            source={preferences?.gh_cli_source ?? 'jean'}
            onSourceChange={handleGhSourceChange}
            pathDetection={ghPathDetection}
            activePath={
              preferences?.gh_cli_source === 'path'
                ? ghPathDetection?.path
                : ghStatus?.path
            }
            loading={isGhLoading}
            installed={!!ghStatus?.installed}
            version={ghStatus?.version}
            onInstall={() => openCliUpdateModal('gh')}
            onUninstall={() => setDeleteCliTarget('gh')}
            actions={
              isGhPathSource ? (
                <CliUpdateButton
                  checking={isGhVersionsLoading}
                  hasUpdate={ghHasUpdate}
                  latestVersion={ghLatestStable?.version}
                  onUpdate={() => {
                    const action = getPathUpdateAction(
                      ghStatus?.path,
                      ghPathDetection?.package_manager,
                      'gh',
                      null
                    )
                    if (action) {
                      openCliLoginModal('gh', action[0], action[1], 'update')
                    } else {
                      openCliUpdateModal('gh')
                    }
                  }}
                />
              ) : (
                <CliChangeVersionButton
                  onClick={() => openCliUpdateModal('gh')}
                />
              )
            }
          />
        </SettingsSection>
      )}

      {hasBackend() && scope === 'github' && (
        <SettingsSection
          title={
            <span className="inline-flex items-center gap-1.5">
              GitLab CLI
              <BetaBadge />
            </span>
          }
          anchorId="pref-gitlab-section-cli"
          actions={
            <CliAuthActions
              installed={!!glabStatus?.installed}
              checking={checkingGlabAuth || isGlabAuthLoading}
              authenticated={!!glabAuth?.authenticated}
              onSignIn={handleGlabLogin}
              onSignInAgain={handleGlabRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="GitLab CLI"
            binary="glab"
            source={preferences?.glab_cli_source ?? 'jean'}
            onSourceChange={handleGlabSourceChange}
            pathDetection={glabPathDetection}
            activePath={
              preferences?.glab_cli_source === 'path'
                ? glabPathDetection?.path
                : glabStatus?.path
            }
            loading={isGlabLoading}
            installed={!!glabStatus?.installed}
            version={glabStatus?.version}
            description={
              glabStatus?.installed
                ? 'Enables GitLab issues and merge requests'
                : 'Optional — enables GitLab issues and merge requests'
            }
            onInstall={() => openCliUpdateModal('glab')}
            onUninstall={() => setDeleteCliTarget('glab')}
            actions={
              isGlabPathSource ? (
                <CliUpdateButton
                  checking={isGlabVersionsLoading}
                  hasUpdate={glabHasUpdate}
                  latestVersion={glabLatestStable?.version}
                  onUpdate={() => {
                    const action = getPathUpdateAction(
                      glabStatus?.path,
                      glabPathDetection?.package_manager,
                      'glab',
                      null
                    )
                    if (action) {
                      openCliLoginModal('glab', action[0], action[1], 'update')
                    } else {
                      openCliUpdateModal('glab')
                    }
                  }}
                />
              ) : (
                <CliChangeVersionButton
                  onClick={() => openCliUpdateModal('glab')}
                />
              )
            }
          />
        </SettingsSection>
      )}

      {hasBackend() && scope === 'coderabbit' && (
        <SettingsSection
          title="CodeRabbit CLI"
          anchorId="pref-coderabbit-section-cli"
          actions={
            <CliAuthActions
              installed={!!coderabbitStatus?.installed}
              checking={checkingCodeRabbitAuth || isCodeRabbitAuthLoading}
              authenticated={!!coderabbitAuth?.authenticated}
              onSignIn={handleCodeRabbitLogin}
              onSignInAgain={handleCodeRabbitRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="CodeRabbit CLI"
            binary="coderabbit"
            source={preferences?.coderabbit_cli_source ?? 'jean'}
            onSourceChange={handleCodeRabbitSourceChange}
            pathDetection={coderabbitPathDetection}
            activePath={
              preferences?.coderabbit_cli_source === 'path'
                ? coderabbitPathDetection?.path
                : coderabbitStatus?.path
            }
            loading={isCodeRabbitLoading}
            installed={!!coderabbitStatus?.installed}
            version={coderabbitStatus?.version}
            onInstall={() => installCodeRabbitCli.mutate(undefined)}
            installing={installCodeRabbitCli.isPending}
            onUninstall={() => setDeleteCliTarget('coderabbit')}
            actions={
              <CliUpdateButton
                checking={isCodeRabbitVersionsLoading}
                hasUpdate={coderabbitHasUpdate}
                latestVersion={coderabbitLatestStable?.version}
                pending={updateCodeRabbitCli.isPending}
                onUpdate={() => {
                  if (isCodeRabbitPathSource && coderabbitStatus) {
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
              />
            }
          />
        </SettingsSection>
      )}

      {hasBackend() && scope === 'codex' && (
        <SettingsSection
          title="CLI"
          anchorId="pref-codex-section-cli"
          actions={
            <CliAuthActions
              installed={!!codexStatus?.installed}
              checking={checkingCodexAuth || isCodexAuthLoading}
              authenticated={!!codexAuth?.authenticated}
              onSignIn={handleCodexLogin}
              onSignInAgain={handleCodexRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="Codex CLI"
            binary="codex"
            source={preferences?.codex_cli_source ?? 'jean'}
            onSourceChange={handleCodexSourceChange}
            pathDetection={codexPathDetection}
            activePath={
              preferences?.codex_cli_source === 'path'
                ? codexPathDetection?.path
                : codexStatus?.path
            }
            loading={isCodexLoading}
            installed={!!codexStatus?.installed}
            version={codexStatus?.version}
            onInstall={() => openCliUpdateModal('codex')}
            onUninstall={() => setDeleteCliTarget('codex')}
            actions={
              isCodexPathSource ? (
                <CliUpdateButton
                  checking={isCodexVersionsLoading}
                  hasUpdate={codexHasUpdate}
                  latestVersion={codexLatestStable?.version}
                  onUpdate={() => {
                    const action = getPathUpdateAction(
                      codexStatus?.path,
                      codexPathDetection?.package_manager,
                      'codex',
                      null,
                      '@openai/codex',
                      codexLatestStable?.version
                    )
                    if (action) {
                      openCliLoginModal('codex', action[0], action[1], 'update')
                    } else {
                      openCliUpdateModal('codex')
                    }
                  }}
                />
              ) : (
                <CliChangeVersionButton
                  onClick={() => openCliUpdateModal('codex')}
                />
              )
            }
          />
          {codexStatus?.installed && codexStatus.sandbox_ready === false && (
            <p className="text-xs text-warning">
              {codexStatus.sandbox_message ??
                'Codex sandbox requires bubblewrap. Install it with: sudo apt install bubblewrap'}
            </p>
          )}
        </SettingsSection>
      )}

      {hasBackend() && scope === 'opencode' && (
        <SettingsSection
          title="CLI"
          anchorId="pref-opencode-section-cli"
          actions={
            <CliAuthActions
              installed={!!opencodeStatus?.installed}
              checking={checkingOpenCodeAuth || isOpenCodeAuthLoading}
              authenticated={!!opencodeAuth?.authenticated}
              onSignIn={handleOpenCodeLogin}
              onSignInAgain={handleOpenCodeRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="OpenCode CLI"
            binary="opencode"
            source={preferences?.opencode_cli_source ?? 'jean'}
            onSourceChange={handleOpencodeSourceChange}
            pathDetection={opencodePathDetection}
            activePath={
              preferences?.opencode_cli_source === 'path'
                ? opencodePathDetection?.path
                : opencodeStatus?.path
            }
            loading={isOpenCodeLoading}
            installed={!!opencodeStatus?.installed}
            version={opencodeStatus?.version}
            onInstall={() => openCliUpdateModal('opencode')}
            onUninstall={() => setDeleteCliTarget('opencode')}
            actions={
              isOpencodePathSource ? (
                <CliUpdateButton
                  checking={isOpencodeVersionsLoading}
                  hasUpdate={opencodeHasUpdate}
                  latestVersion={opencodeLatestStable?.version}
                  onUpdate={() => {
                    const action = getPathUpdateAction(
                      opencodeStatus?.path,
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
                />
              ) : (
                <CliChangeVersionButton
                  onClick={() => openCliUpdateModal('opencode')}
                />
              )
            }
          />
        </SettingsSection>
      )}

      {hasBackend() && scope === 'cursor' && (
        <SettingsSection
          title="CLI"
          anchorId="pref-cursor-section-cli"
          actions={
            <CliAuthActions
              installed={!!cursorStatus?.installed}
              checking={checkingCursorAuth || isCursorAuthLoading}
              authenticated={!!cursorAuth?.authenticated}
              onSignIn={handleCursorLogin}
              onSignInAgain={handleCursorRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="Cursor CLI"
            binary="cursor-agent"
            pathDetection={cursorPathDetection}
            activePath={cursorPathDetection?.path ?? cursorStatus?.path}
            loading={isCursorLoading}
            installed={!!cursorStatus?.installed}
            version={cursorStatus?.version}
            onInstall={handleCursorInstall}
            actions={
              <Button variant="outline" size="sm" onClick={handleCursorUpdate}>
                Run self-update
              </Button>
            }
          />
          {cursorStatus?.installed &&
            !cursorAuth?.authenticated &&
            cursorAuthMessage && (
              <p className="text-xs text-muted-foreground">
                {cursorAuthMessage}
              </p>
            )}
        </SettingsSection>
      )}

      {hasBackend() && scope === 'pi' && (
        <SettingsSection
          title="CLI"
          anchorId="pref-pi-section-cli"
          actions={
            <CliAuthActions
              installed={!!piStatus?.installed}
              checking={checkingPiAuth || isPiAuthLoading}
              authenticated={!!piAuth?.authenticated}
              onSignIn={handlePiLogin}
              onSignInAgain={handlePiRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="PI CLI"
            source={preferences?.pi_cli_source ?? 'jean'}
            onSourceChange={handlePiSourceChange}
            pathDetection={piPathDetection}
            activePath={
              preferences?.pi_cli_source === 'path'
                ? piPathDetection?.path
                : piStatus?.path
            }
            loading={isPiLoading}
            installed={!!piStatus?.installed}
            version={piStatus?.version}
            onInstall={handlePiInstall}
            onUninstall={() => setDeleteCliTarget('pi')}
            actions={<CliChangeVersionButton onClick={handlePiInstall} />}
          />
          {piStatus?.installed && !piAuth?.authenticated && piAuthMessage && (
            <p className="text-xs text-muted-foreground">{piAuthMessage}</p>
          )}
        </SettingsSection>
      )}

      {hasBackend() && scope === 'commandcode' && (
        <SettingsSection
          title="CLI"
          anchorId="pref-commandcode-section-cli"
          actions={
            <CliAuthActions
              installed={!!commandcodeStatus?.installed}
              checking={checkingCommandCodeAuth || isCommandCodeAuthLoading}
              authenticated={!!commandcodeAuth?.authenticated}
              onSignIn={handleCommandCodeLogin}
              onSignInAgain={handleCommandCodeRelogin}
            />
          }
        >
          <CliInstallFields
            backendName="Command Code CLI"
            source={preferences?.commandcode_cli_source ?? 'jean'}
            onSourceChange={handleCommandCodeSourceChange}
            pathDetection={commandcodePathDetection}
            activePath={
              preferences?.commandcode_cli_source === 'path'
                ? commandcodePathDetection?.path
                : commandcodeStatus?.path
            }
            loading={isCommandCodeLoading}
            installed={!!commandcodeStatus?.installed}
            version={commandcodeStatus?.version}
            onInstall={handleCommandCodeInstall}
            onUninstall={() => setDeleteCliTarget('commandcode')}
            actions={
              <CliChangeVersionButton onClick={handleCommandCodeInstall} />
            }
          />
          {commandcodeStatus?.installed &&
            !commandcodeAuth?.authenticated &&
            commandCodeAuthMessage && (
              <p className="text-xs text-muted-foreground">
                {commandCodeAuthMessage}
              </p>
            )}
        </SettingsSection>
      )}

      {scope === 'claude' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-claude-section-settings"
        >
          <div className="space-y-4">
            <InlineField
              label="Model"
              description={
                defaultClaudeProvider
                  ? `Routed via ${defaultClaudeProvider}`
                  : undefined
              }
            >
              <Select
                value={preferences?.selected_model ?? 'claude-opus-5-5'}
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
              <InlineField label="Thinking">
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
                    {selectedClaudeReasoningOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InlineField>
            )}

            {claudeReasoning?.type === 'effort' && (
              <InlineField label="Effort">
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
                    {selectedClaudeReasoningOptions.map(option => (
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
              description="Browser automation through the Chrome extension"
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
            <InlineField
              label="Steer running turn"
              description="Send new prompts into the running turn"
              help="Lands at the next tool call instead of queueing. macOS/Linux only; applies to new runs."
            >
              <Switch
                checked={preferences?.claude_auto_steer_enabled ?? false}
                onCheckedChange={handleClaudeAutoSteerToggle}
              />
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {scope === 'codex' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-codex-section-settings"
        >
          <div className="space-y-4">
            <InlineField label="Model">
              <Select
                value={preferences?.selected_codex_model ?? 'gpt-6.1-sol'}
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

            <InlineField label="Reasoning effort">
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
              description="How much text Codex writes while it works"
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
              description="Mode for Codex and Claude /goal runs"
            >
              <Select
                value={preferences?.codex_goal_execution_mode ?? 'build'}
                onValueChange={handleCodexGoalExecutionModeChange}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="build">
                    Auto-accept edits / legacy Build
                  </SelectItem>
                  <SelectItem value="yolo">Full access</SelectItem>
                </SelectContent>
              </Select>
            </InlineField>

            <InlineField
              label="Steer running turn"
              description="Inject new prompts into the running turn instead of queueing"
            >
              <Switch
                checked={preferences?.codex_auto_steer_enabled ?? false}
                onCheckedChange={handleCodexAutoSteerToggle}
              />
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {scope === 'opencode' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-opencode-section-settings"
        >
          <div className="space-y-4">
            <InlineField label="Model">
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
              description="Inject new prompts into the running turn instead of queueing"
            >
              <Switch
                checked={preferences?.opencode_auto_steer_enabled ?? false}
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
        >
          <div className="space-y-4">
            <InlineField label="Model">
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
        >
          <div className="space-y-4">
            <InlineField
              label="Model"
              description={
                <>From the active PI provider. Use Relogin to change it.</>
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
              description="Inject new prompts into the running turn instead of queueing"
            >
              <Switch
                checked={preferences?.pi_auto_steer_enabled ?? false}
                onCheckedChange={handlePiAutoSteerToggle}
              />
            </InlineField>
            <InlineField
              label="PI owns agent policy"
              description="Keep PI's own tools, extensions, and instructions"
              help="Jean only sends prompts and renders events. It does not inject a tool allowlist or system prompt."
            >
              <Switch
                checked={preferences?.pi_agent_owns_policy ?? false}
                onCheckedChange={handlePiAgentOwnsPolicyToggle}
              />
            </InlineField>
          </div>
        </SettingsSection>
      )}

      {scope === 'commandcode' && (
        <SettingsSection
          title="Default model"
          anchorId="pref-commandcode-section-settings"
        >
          <div className="space-y-4">
            <InlineField label="Model">
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
            title="CLI"
            anchorId="pref-grok-section-cli"
            actions={
              <CliAuthActions
                installed={!!grokStatus?.installed}
                checking={checkingGrokAuth || isGrokAuthLoading}
                authenticated={!!grokAuth?.authenticated}
                onSignIn={handleGrokLogin}
                onSignInAgain={handleGrokRelogin}
              />
            }
          >
            <CliInstallFields
              backendName="Grok CLI"
              source={preferences?.grok_cli_source ?? 'jean'}
              onSourceChange={handleGrokSourceChange}
              pathDetection={grokPathDetection}
              activePath={
                preferences?.grok_cli_source === 'path'
                  ? grokPathDetection?.path
                  : grokStatus?.path
              }
              loading={isGrokLoading}
              installed={!!grokStatus?.installed}
              version={grokStatus?.version}
              onInstall={handleGrokInstall}
              onUninstall={() => setDeleteCliTarget('grok')}
              actions={<CliChangeVersionButton onClick={handleGrokInstall} />}
            />
            {grokAuthMessage && (
              <p className="text-xs text-muted-foreground">{grokAuthMessage}</p>
            )}
          </SettingsSection>

          <SettingsSection
            title="Default model"
            anchorId="pref-grok-section-settings"
          >
            <div className="space-y-4">
              <InlineField label="Model">
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
              <InlineField label="Reasoning effort">
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
                description="Inject new prompts into the running turn instead of queueing"
              >
                <Switch
                  checked={preferences?.grok_auto_steer_enabled ?? false}
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
            title="CLI"
            anchorId="pref-kimi-section-cli"
            actions={
              <CliAuthActions
                installed={!!kimiStatus?.installed}
                checking={checkingKimiAuth || isKimiAuthLoading}
                authenticated={!!kimiAuth?.authenticated}
                onSignIn={handleKimiLogin}
                onSignInAgain={handleKimiRelogin}
              />
            }
          >
            <CliInstallFields
              backendName="Kimi Code CLI"
              source={preferences?.kimi_cli_source ?? 'jean'}
              onSourceChange={handleKimiSourceChange}
              pathDetection={kimiPathDetection}
              activePath={
                preferences?.kimi_cli_source === 'path'
                  ? kimiPathDetection?.path
                  : kimiStatus?.path
              }
              loading={isKimiLoading}
              installed={!!kimiStatus?.installed}
              version={kimiStatus?.version}
              onInstall={handleKimiInstall}
              onUninstall={() => setDeleteCliTarget('kimi')}
              actions={<CliChangeVersionButton onClick={handleKimiInstall} />}
            />
            {kimiAuthMessage && (
              <p className="text-xs text-muted-foreground">{kimiAuthMessage}</p>
            )}
          </SettingsSection>

          <SettingsSection
            title="Default model"
            anchorId="pref-kimi-section-settings"
          >
            <div className="space-y-4">
              <InlineField label="Model">
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
                description="Inject new prompts into the running turn instead of queueing"
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

      {scope === 'devin' && (
        <>
          <SettingsSection
            title="CLI"
            anchorId="pref-devin-section-cli"
            actions={
              <CliAuthActions
                installed={!!devinStatus?.installed}
                checking={checkingDevinAuth || isDevinAuthLoading}
                authenticated={!!devinAuth?.authenticated}
                onSignIn={handleDevinLogin}
                onSignInAgain={handleDevinRelogin}
              />
            }
          >
            <CliInstallFields
              backendName="Devin CLI"
              source={preferences?.devin_cli_source ?? 'jean'}
              onSourceChange={handleDevinSourceChange}
              pathDetection={devinPathDetection}
              activePath={
                preferences?.devin_cli_source === 'jean'
                  ? devinStatus?.path
                  : devinPathDetection?.path
              }
              loading={isDevinLoading}
              installed={!!devinStatus?.installed}
              version={devinStatus?.version}
              description={
                devinStatus?.installed
                  ? 'Enables Devin AI sessions through the Devin CLI ACP server.'
                  : 'Install the official Devin CLI, then log in with your Devin account.'
              }
              onInstall={handleDevinInstall}
              onUninstall={() => setDeleteCliTarget('devin')}
              actions={<CliChangeVersionButton onClick={handleDevinInstall} />}
            />
            {devinAuthMessage && (
              <p className="text-xs text-muted-foreground">
                {devinAuthMessage}
              </p>
            )}
          </SettingsSection>

          <SettingsSection
            title="Default model"
            anchorId="pref-devin-section-settings"
          >
            <div className="space-y-4">
              <InlineField
                label="Model"
                description="Devin CLI model for AI assistance"
              >
                <Select
                  value={selectedDevinModel}
                  onValueChange={value =>
                    handleDevinModelChange(value as DevinModel)
                  }
                >
                  <SelectTrigger className="w-80 max-w-full">
                    <SelectValue>{selectedDevinModelLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {devinModelOptions.map(option => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </InlineField>
              <InlineField
                label="Steer running turn"
                description="Not supported yet; prompts queue while Devin works"
              >
                <Switch
                  checked={preferences?.devin_auto_steer_enabled ?? false}
                  onCheckedChange={handleDevinAutoSteerToggle}
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
              label="Default permissions"
              description="Permission policy for new sessions"
              help="Plan mode is opt-in on each session, not a default."
            >
              <Select
                value={preferences?.default_execution_mode ?? 'yolo'}
                onValueChange={(value: ExecutionMode) => {
                  patchPreferences.mutate({ default_execution_mode: value })
                }}
              >
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {preferences?.default_execution_mode === 'build' &&
                    !getSupportedPermissionModes(
                      preferences?.default_backend ?? 'claude'
                    ).includes('build') && (
                      <SelectItem value="build">Legacy Build</SelectItem>
                    )}
                  {getSupportedPermissionModes(
                    preferences?.default_backend ?? 'claude'
                  ).map(mode => (
                    <SelectItem key={mode} value={mode}>
                      {
                        {
                          supervised: 'Supervised',
                          build: 'Auto-accept edits',
                          auto: 'Auto',
                          yolo: 'Full access',
                        }[mode]
                      }
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </InlineField>

            <AiLanguageField preferences={preferences} />

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
              {isNativeApp() && (
                <InlineField
                  label="Desktop notifications"
                  description="Banner when a session needs you or finishes"
                  help="Shown only while Jean is in the background."
                >
                  <Switch
                    checked={preferences?.desktop_notifications_enabled ?? true}
                    onCheckedChange={handleDesktopNotificationsEnabledChange}
                  />
                </InlineField>
              )}

              <InlineField
                label="Web access sounds"
                description="Browser and mobile web access only"
                help="Turn off to keep phone music playing."
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

          <SettingsSection title="Chat" anchorId="pref-general-section-chat">
            <div className="space-y-4">
              <InlineField
                label="Show full file paths"
                description="Show relative paths in file mention badges"
              >
                <Switch
                  checked={preferences?.show_full_file_path ?? false}
                  onCheckedChange={checked => {
                    if (preferences) {
                      patchPreferences.mutate({
                        show_full_file_path: checked,
                      })
                    }
                  }}
                />
              </InlineField>
              <InlineField
                label="Spellcheck"
                description="Enable spellcheck in the chat input"
              >
                <Switch
                  checked={preferences?.spellcheck_enabled ?? true}
                  onCheckedChange={checked => {
                    if (preferences) {
                      patchPreferences.mutate({
                        spellcheck_enabled: checked,
                      })
                    }
                  }}
                />
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
            </div>
          </SettingsSection>

          <SettingsSection
            title="Browser"
            anchorId="pref-general-section-browser"
          >
            <div className="space-y-4">
              <BrowserDefaultHostField preferences={preferences} />
            </div>
          </SettingsSection>

          {isWebAccessView && (
            <SettingsSection
              title="This browser"
              description="You are signed in to this Jean server with an access token kept in this browser."
              anchorId="pref-general-section-session"
            >
              <InlineField
                label={webAccessServerLabel()}
                description="Forgets the token on this device only"
                help="The server keeps running and your other devices stay signed in."
              >
                <Button
                  variant="outline"
                  size="sm"
                  onClick={signOutOfWebAccess}
                >
                  <LogOut className="size-3.5" />
                  Sign out
                </Button>
              </InlineField>
            </SettingsSection>
          )}

          <SettingsSection
            title="Advanced"
            anchorId="pref-general-section-advanced"
            collapsible
            defaultOpen={false}
          >
            <InlineField
              label="Keep AI servers warm"
              description="Keep Codex and OpenCode running for 10 minutes"
              help="Follow-up prompts start faster."
            >
              <Switch
                checked={preferences?.keep_ai_servers_warm ?? true}
                onCheckedChange={checked => {
                  patchPreferences.mutate({ keep_ai_servers_warm: checked })
                }}
              />
            </InlineField>

            <InlineField
              label="Plan approval"
              description="Overrides when approving a plan"
              help="Backend, model, thinking, and effort used when you approve a plan with the selected permissions."
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
                            : effectiveBuildBackend === 'devin'
                              ? devinModelOptions
                              : effectiveBuildBackend === 'grok'
                                ? grokModelOptions
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
              label="Full-access plan approval"
              description="Overrides when approving with Full access"
              help="Backend, model, thinking, and effort used when you approve a plan with Full access."
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
                            : effectiveYoloBackend === 'devin'
                              ? devinModelOptions
                              : effectiveYoloBackend === 'grok'
                                ? grokModelOptions
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

            <InlineField
              label="Auto-update AI backends"
              description="Install CLI updates in the background"
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

            {isWindows && isNativeApp() && (
              <WslSettingsFields
                preferences={preferences}
                patchPreferences={patchPreferences}
              />
            )}

            <InlineField
              id="pref-general-debug-mode"
              label="Debug mode"
              description="Show the session debug panel"
            >
              <Switch
                checked={preferences?.debug_mode_enabled ?? false}
                onCheckedChange={checked => {
                  patchPreferences.mutate({ debug_mode_enabled: checked })
                }}
              />
            </InlineField>

            {isNativeApp() && (
              <InlineField
                id="pref-general-section-troubleshooting"
                label="Application logs"
                description="Open the log directory"
              >
                <Button
                  variant="outline"
                  size="sm"
                  className="w-fit"
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
            )}
          </SettingsSection>

          <SettingsSection
            title="Experimental"
            anchorId="pref-general-section-experimental"
            collapsible
            defaultOpen={false}
          >
            <InlineField
              id="pref-general-agents"
              label="Agents"
              description="Show the Agents tab with Jean, the coordinator agent"
            >
              <Switch
                checked={preferences?.agents_enabled ?? false}
                onCheckedChange={checked => {
                  patchPreferences.mutate({ agents_enabled: checked })
                  // Leave the Agents page when the feature is turned off
                  if (!checked)
                    useUIStore.getState().setRailSection('workspace')
                }}
              />
            </InlineField>

            <InlineField
              id="pref-general-single-session-view"
              label="Single session view"
              description="Hide the session tabs. The worktree list and Recent show every session, also empty ones"
            >
              <Switch
                checked={preferences?.single_session_view_enabled ?? false}
                onCheckedChange={checked => {
                  patchPreferences.mutate({
                    single_session_view_enabled: checked,
                  })
                }}
              />
            </InlineField>
          </SettingsSection>

          <div
            id="pref-general-section-version"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-muted-foreground"
          >
            <span>
              {activeRemoteConnection ? 'Jean Client' : 'Jean'} v
              {CLIENT_BUILD_INFO.appVersion}
            </span>
            {activeRemoteConnection && (
              <span>
                · Jean Server{' '}
                {isRemoteServerInfoLoading
                  ? 'Loading…'
                  : formatJeanVersionLabel(remoteServerVersion)}
              </span>
            )}
            {CLIENT_BUILD_INFO.gitSha && (
              <span>
                ·{' '}
                <button
                  type="button"
                  title="Source commit used for this build"
                  onClick={() =>
                    openExternal(
                      `https://github.com/coollabsio/jean/commit/${CLIENT_BUILD_INFO.gitSha}`
                    )
                  }
                  className="hover:text-foreground hover:underline"
                >
                  {CLIENT_BUILD_INFO.gitSha}
                </button>
              </span>
            )}
            {CLIENT_BUILD_INFO.builtAt && (
              <span>
                · {new Date(CLIENT_BUILD_INFO.builtAt).toLocaleString()}
              </span>
            )}
          </div>
        </>
      )}

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
                            : deleteCliTarget === 'devin'
                              ? 'Devin CLI'
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
                                  : deleteCliTarget === 'devin'
                                    ? devinPathDetection?.found
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
              variant="destructive"
            >
              {isDeletingCli ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

const WslSettingsFields: FC<{
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
    <>
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
    </>
  )
}
