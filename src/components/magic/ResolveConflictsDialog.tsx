import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { useUIStore } from '@/store/ui-store'
import { useWorktree, useProjects } from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { useAvailableOpencodeModels } from '@/services/opencode-cli'
import { useAvailableGrokModels } from '@/services/grok-cli'
import { useAvailableKimiModels } from '@/services/kimi-cli'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import {
  type CliBackend,
  PREDEFINED_CLI_PROFILES,
  resolveMagicPromptBackend,
  resolveMagicPromptProvider,
} from '@/types/preferences'
import {
  CODEX_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  GROK_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { formatOpencodeModelLabel } from '@/components/chat/toolbar/toolbar-utils'
import { BackendLabel } from '@/components/ui/backend-label'
import {
  getCatalogModelOptions,
  useModelCatalog,
} from '@/services/model-catalog'

const RESOLVE_CONFLICTS_MODEL_KEY = 'resolve_conflicts_model'
const RESOLVE_CONFLICTS_PROVIDER_KEY = 'resolve_conflicts_provider'
const RESOLVE_CONFLICTS_BACKEND_KEY = 'resolve_conflicts_backend'

type ResolveSelectionMode = 'settings-default' | 'custom'

export interface ResolveConflictsOverride {
  backend: CliBackend
  model: string
}

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (override?: ResolveConflictsOverride) => void
}

function formatOpencodeLabel(value: string): string {
  const formatted = formatOpencodeModelLabel(value)
  return value.startsWith('opencode/')
    ? formatted.replace(/\s+\(OpenCode\)$/, '')
    : formatted
}

export function ResolveConflictsDialog({
  open,
  onOpenChange,
  onConfirm,
}: Props) {
  const selectedWorktreeIdFromProjects = useProjectsStore(
    state => state.selectedWorktreeId
  )
  const activeWorktreeId = useChatStore(state => state.activeWorktreeId)
  const sessionChatModalWorktreeId = useUIStore(
    state => state.sessionChatModalWorktreeId
  )
  const selectedWorktreeId =
    selectedWorktreeIdFromProjects ??
    activeWorktreeId ??
    sessionChatModalWorktreeId
  const { data: worktree } = useWorktree(selectedWorktreeId)
  const { data: preferences } = usePreferences()
  const { data: projects } = useProjects()
  const project = worktree
    ? projects?.find(p => p.id === worktree.project_id)
    : null
  const { installedBackends } = useInstalledBackends()
  const { data: availableOpencodeModels } = useAvailableOpencodeModels({
    enabled: installedBackends.includes('opencode'),
  })
  const { data: availableGrokModels } = useAvailableGrokModels({
    enabled: installedBackends.includes('grok'),
  })
  const { data: availableKimiModels } = useAvailableKimiModels({
    enabled: installedBackends.includes('kimi'),
  })
  const { data: modelCatalog } = useModelCatalog()

  const [resolveSelectionMode, setResolveSelectionMode] =
    useState<ResolveSelectionMode>('settings-default')
  const [customResolveBackend, setCustomResolveBackend] =
    useState<CliBackend>('claude')
  const [customResolveModel, setCustomResolveModel] = useState<string>('sonnet')

  const opencodeModelOptions = useMemo(() => {
    const models = availableOpencodeModels?.length
      ? availableOpencodeModels
      : OPENCODE_MODEL_OPTIONS.map(option => option.value)
    return models.map(value => ({
      value,
      label: formatOpencodeLabel(value),
    }))
  }, [availableOpencodeModels])

  const grokModelOptions = useMemo(() => {
    const models = availableGrokModels?.length
      ? availableGrokModels.map(model => ({
          value: `grok/${model.id}`,
          label: model.label || model.id,
        }))
      : GROK_MODEL_OPTIONS
    return models
  }, [availableGrokModels])
  const kimiModelOptions = useMemo(() => {
    if (!availableKimiModels?.length) {
      return [{ value: 'kimi/default', label: 'Configured default' }]
    }
    return availableKimiModels.map(model => ({
      value: `kimi/${model.id}`,
      label: model.label,
    }))
  }, [availableKimiModels])

  const claudeModelOptions = useMemo(
    () =>
      getCatalogModelOptions(modelCatalog, 'claude').map(option => ({
        ...option,
        label: option.label.replace(/^Claude\s+/, ''),
      })),
    [modelCatalog]
  )

  const resolveDefaults = useMemo(() => {
    const defaultBackend =
      project?.default_backend ?? preferences?.default_backend ?? 'claude'
    const backend =
      resolveMagicPromptBackend(
        preferences?.magic_prompt_backends,
        RESOLVE_CONFLICTS_BACKEND_KEY,
        defaultBackend
      ) ?? 'claude'
    const model =
      preferences?.magic_prompt_models?.[RESOLVE_CONFLICTS_MODEL_KEY] ??
      (backend === 'codex'
        ? (preferences?.selected_codex_model ?? 'gpt-5.6-sol')
        : backend === 'opencode'
          ? (preferences?.selected_opencode_model ?? 'opencode/gpt-5.6-sol')
          : backend === 'cursor'
            ? (preferences?.selected_cursor_model ?? 'cursor/auto')
            : backend === 'commandcode'
              ? (preferences?.selected_commandcode_model ??
                'commandcode/default')
              : backend === 'kimi'
                ? (preferences?.selected_kimi_model ?? 'kimi/default')
                : backend === 'grok'
                  ? (preferences?.selected_grok_model ??
                    'grok/grok-4.5')
                  : (preferences?.selected_model ?? 'sonnet'))
    const provider = resolveMagicPromptProvider(
      preferences?.magic_prompt_providers,
      RESOLVE_CONFLICTS_PROVIDER_KEY,
      preferences?.default_provider
    )
    return { backend, model, provider }
  }, [preferences, project?.default_backend])

  const getClaudeModelOptionsForProvider = useCallback(
    (provider: string | null) => {
      const profile = [
        ...PREDEFINED_CLI_PROFILES,
        ...(preferences?.custom_cli_profiles ?? []),
      ].find(item => item.name === provider)
      let opusModel: string | undefined
      let sonnetModel: string | undefined
      let haikuModel: string | undefined
      if (profile?.settings_json) {
        try {
          const settings = JSON.parse(profile.settings_json)
          const env = settings?.env
          if (env) {
            opusModel = env.ANTHROPIC_DEFAULT_OPUS_MODEL || env.ANTHROPIC_MODEL
            sonnetModel =
              env.ANTHROPIC_DEFAULT_SONNET_MODEL || env.ANTHROPIC_MODEL
            haikuModel =
              env.ANTHROPIC_DEFAULT_HAIKU_MODEL || env.ANTHROPIC_MODEL
          }
        } catch {
          // ignore invalid custom profile json
        }
      }

      const suffix = (model?: string) => (model ? ` (${model})` : '')
      return provider
        ? [
            { value: 'opus', label: `Opus${suffix(opusModel)}` },
            { value: 'sonnet', label: `Sonnet${suffix(sonnetModel)}` },
            { value: 'haiku', label: `Haiku${suffix(haikuModel)}` },
          ]
        : claudeModelOptions
    },
    [claudeModelOptions, preferences?.custom_cli_profiles]
  )

  const resolveClaudeProvider =
    resolveDefaults.provider && resolveDefaults.provider !== '__anthropic__'
      ? resolveDefaults.provider
      : null

  const resolveClaudeModelOptions = useMemo(
    () => getClaudeModelOptionsForProvider(resolveClaudeProvider),
    [getClaudeModelOptionsForProvider, resolveClaudeProvider]
  )

  const getResolveModelOptions = useCallback(
    (backend: CliBackend) => {
      switch (backend) {
        case 'codex':
          return CODEX_MODEL_OPTIONS
        case 'opencode':
          return opencodeModelOptions
        case 'grok':
          return grokModelOptions
        case 'kimi':
          return kimiModelOptions
        default:
          return resolveClaudeModelOptions
      }
    },
    [
      grokModelOptions,
      kimiModelOptions,
      opencodeModelOptions,
      resolveClaudeModelOptions,
    ]
  )

  const customResolveModelOptions = useMemo(
    () => getResolveModelOptions(customResolveBackend),
    [customResolveBackend, getResolveModelOptions]
  )

  const effectiveCustomResolveModel = useMemo(() => {
    return (
      customResolveModelOptions.find(
        option => option.value === customResolveModel
      )?.value ??
      customResolveModelOptions[0]?.value ??
      ''
    )
  }, [customResolveModel, customResolveModelOptions])

  const formatBackendLabel = useCallback((backend: CliBackend) => {
    switch (backend) {
      case 'codex':
        return 'Codex'
      case 'opencode':
        return 'OpenCode'
      case 'cursor':
        return 'Cursor'
      case 'grok':
        return 'Grok'
      case 'kimi':
        return 'Kimi Code'
      default:
        return 'Claude'
    }
  }, [])

  const resolveSettingsDefaultSummary = `${formatBackendLabel(
    resolveDefaults.backend
  )} · ${(() => {
    const options = getResolveModelOptions(resolveDefaults.backend)
    return (
      options.find(option => option.value === resolveDefaults.model)?.label ??
      resolveDefaults.model
    )
  })()}`
  const resolveCustomSelectionSummary = `${formatBackendLabel(
    customResolveBackend
  )} · ${(() => {
    const options = getResolveModelOptions(customResolveBackend)
    return (
      options.find(option => option.value === effectiveCustomResolveModel)
        ?.label ?? effectiveCustomResolveModel
    )
  })()}`

  const handleCustomResolveBackendChange = useCallback(
    (backend: string) => {
      const nextBackend = backend as CliBackend
      setCustomResolveBackend(nextBackend)
      const nextOptions = getResolveModelOptions(nextBackend)
      setCustomResolveModel(nextOptions[0]?.value ?? '')
    },
    [getResolveModelOptions]
  )

  useEffect(() => {
    if (!open) {
      setResolveSelectionMode('settings-default')
    }
  }, [open])

  useEffect(() => {
    const nextBackend = installedBackends.includes(resolveDefaults.backend)
      ? resolveDefaults.backend
      : (installedBackends[0] ?? 'claude')
    const nextOptions = getResolveModelOptions(nextBackend)
    const nextModel =
      nextOptions.find(option => option.value === resolveDefaults.model)
        ?.value ??
      nextOptions[0]?.value ??
      resolveDefaults.model
    setCustomResolveBackend(nextBackend)
    setCustomResolveModel(nextModel)
  }, [getResolveModelOptions, installedBackends, resolveDefaults])

  useEffect(() => {
    if (!customResolveModelOptions.length) return
    if (
      !customResolveModelOptions.some(
        option => option.value === customResolveModel
      )
    ) {
      const firstOption = customResolveModelOptions[0]
      if (firstOption) {
        setCustomResolveModel(firstOption.value)
      }
    }
  }, [customResolveModel, customResolveModelOptions])

  const handleConfirm = useCallback(() => {
    const override =
      resolveSelectionMode === 'custom'
        ? {
            backend: customResolveBackend,
            model: effectiveCustomResolveModel,
          }
        : undefined
    onConfirm(override)
    onOpenChange(false)
  }, [
    resolveSelectionMode,
    customResolveBackend,
    effectiveCustomResolveModel,
    onConfirm,
    onOpenChange,
  ])

  const handleResolveKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        handleConfirm()
      }
    },
    [handleConfirm]
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        tabIndex={-1}
        className="sm:max-w-[520px] outline-none"
        onKeyDown={handleResolveKeyDown}
      >
        <DialogHeader>
          <DialogTitle>Resolve conflicts</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <RadioGroup
            value={resolveSelectionMode}
            onValueChange={value =>
              setResolveSelectionMode(value as ResolveSelectionMode)
            }
            className="space-y-3"
          >
            <div
              className={cn(
                'flex items-start gap-3 rounded-lg border p-3 transition-colors',
                resolveSelectionMode === 'settings-default'
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border'
              )}
            >
              <RadioGroupItem
                value="settings-default"
                id="resolve-settings-default"
                className="mt-0.5"
              />
              <Label
                htmlFor="resolve-settings-default"
                className="flex-1 cursor-pointer"
              >
                <div className="text-sm font-medium">
                  Use Magic Prompt settings
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {resolveSettingsDefaultSummary}
                </div>
              </Label>
            </div>

            <div
              className={cn(
                'space-y-3 rounded-lg border p-3 transition-colors',
                resolveSelectionMode === 'custom'
                  ? 'border-primary/40 bg-primary/5'
                  : 'border-border'
              )}
            >
              <div className="flex items-start gap-3">
                <RadioGroupItem
                  value="custom"
                  id="resolve-custom"
                  className="mt-0.5"
                />
                <Label
                  htmlFor="resolve-custom"
                  className="flex-1 cursor-pointer"
                >
                  <div className="text-sm font-medium">
                    Choose backend + model
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {resolveCustomSelectionSummary}
                  </div>
                </Label>
              </div>

              <div className="grid grid-cols-2 gap-3 pl-7">
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">
                    Backend
                  </Label>
                  <Select
                    value={customResolveBackend}
                    onValueChange={handleCustomResolveBackendChange}
                  >
                    <SelectTrigger
                      size="sm"
                      hideIcon={
                        installedBackends.filter(backend =>
                          [
                            'claude',
                            'codex',
                            'opencode',
                            'grok',
                            'kimi',
                          ].includes(backend)
                        ).length <= 1
                      }
                      onClick={() => setResolveSelectionMode('custom')}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {installedBackends.includes('claude') && (
                        <SelectItem value="claude">Claude</SelectItem>
                      )}
                      {installedBackends.includes('codex') && (
                        <SelectItem value="codex">Codex</SelectItem>
                      )}
                      {installedBackends.includes('opencode') && (
                        <SelectItem value="opencode">OpenCode</SelectItem>
                      )}
                      {installedBackends.includes('grok') && (
                        <SelectItem value="grok">
                          <BackendLabel backend="grok" />
                        </SelectItem>
                      )}
                      {installedBackends.includes('kimi') && (
                        <SelectItem value="kimi">
                          <BackendLabel backend="kimi" />
                        </SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Model</Label>
                  <Select
                    value={effectiveCustomResolveModel}
                    onValueChange={value => {
                      setResolveSelectionMode('custom')
                      setCustomResolveModel(value)
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      hideIcon={customResolveModelOptions.length <= 1}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {customResolveModelOptions.map(option => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>
          </RadioGroup>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleConfirm}>Resolve conflicts</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
