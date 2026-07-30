import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useProjects, useUpdateProjectSettings } from '@/services/projects'
import type { ProjectAutoFixSettings } from '@/types/projects'
import {
  codexDefaultModelOptions,
  getClaudeModelOptionsForProvider,
  type CliBackend,
  type CustomCliProfile,
  modelOptions,
} from '@/types/preferences'
import { BackendLabel } from '@/components/ui/backend-label'
import { cn } from '@/lib/utils'
import { BackendModelPickerContent } from '@/components/chat/toolbar/BackendModelPickerContent'
import {
  COMMANDCODE_MODEL_OPTIONS,
  CURSOR_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
  PI_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import { useGitHubLabels } from '@/services/github'
import type { GitHubLabel } from '@/types/github'
import { usePreferences } from '@/services/preferences'

export const MR_ROBOT_SETTINGS_BADGE = 'Beta'
const BACKEND_DEFAULT_MODEL_VALUE = '__backend_default__'
const ANTHROPIC_PROVIDER_VALUE = '__anthropic__'

/** Structural defaults. Backend values are resolved via installed CLIs. */
const DEFAULT_AUTO_FIX_SETTINGS: ProjectAutoFixSettings = {
  enabled: false,
  interval_minutes: 30,
  issue_limit: 1,
  max_parallel_worktrees: 1,
  included_labels: [],
  excluded_labels: [],
  planning_backend: 'claude',
  planning_model: null,
  planning_provider: null,
  auto_yolo_enabled: false,
  yolo_backend: 'claude',
  yolo_model: null,
  yolo_provider: null,
  active_hours_enabled: false,
  active_hours_start: 20,
  active_hours_end: 8,
}

/** First installed CLI backend, or Claude only as a last-resort fallback. */
export function firstAvailableBackend(
  installedBackends: CliBackend[]
): CliBackend {
  return installedBackends[0] ?? 'claude'
}

/**
 * Keep a configured backend when it is still installed; otherwise fall back to
 * the first available backend (same order as useInstalledBackends).
 */
export function resolveAutoFixBackend(
  backend: string | null | undefined,
  installedBackends: CliBackend[]
): string {
  const trimmed = backend?.trim()
  if (
    trimmed &&
    (installedBackends.length === 0 ||
      installedBackends.includes(trimmed as CliBackend))
  ) {
    return trimmed
  }
  return firstAvailableBackend(installedBackends)
}

export function buildAutoFixSettings(
  saved: Partial<ProjectAutoFixSettings> | null | undefined,
  installedBackends: CliBackend[]
): ProjectAutoFixSettings {
  const defaultBackend = firstAvailableBackend(installedBackends)
  if (!saved) {
    return {
      ...DEFAULT_AUTO_FIX_SETTINGS,
      planning_backend: defaultBackend,
      yolo_backend: defaultBackend,
    }
  }
  return {
    ...DEFAULT_AUTO_FIX_SETTINGS,
    ...saved,
    planning_backend: resolveAutoFixBackend(
      saved.planning_backend,
      installedBackends
    ),
    yolo_backend: resolveAutoFixBackend(saved.yolo_backend, installedBackends),
  }
}

function parseLabelList(value: string): string[] {
  const seen = new Set<string>()
  const labels: string[] = []
  for (const label of value.split(',')) {
    const trimmed = label.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) continue
    seen.add(key)
    labels.push(trimmed)
  }
  return labels
}

/** Normalize provider: empty/Anthropic sentinels become null; only keep for Claude. */
export function normalizeAutoFixProvider(
  backend: string,
  provider: string | null | undefined
): string | null {
  if (backend !== 'claude') return null
  const trimmed = provider?.trim()
  if (
    !trimmed ||
    trimmed === ANTHROPIC_PROVIDER_VALUE ||
    trimmed === '__default__' ||
    trimmed === 'anthropic' ||
    trimmed === 'default'
  ) {
    return null
  }
  return trimmed
}

function normalizeAutoFixSettings(
  settings: ProjectAutoFixSettings
): ProjectAutoFixSettings {
  return {
    ...DEFAULT_AUTO_FIX_SETTINGS,
    ...settings,
    planning_model: settings.planning_model?.trim() || null,
    yolo_model: settings.yolo_model?.trim() || null,
    planning_provider: normalizeAutoFixProvider(
      settings.planning_backend,
      settings.planning_provider
    ),
    yolo_provider: normalizeAutoFixProvider(
      settings.yolo_backend,
      settings.yolo_provider
    ),
    included_labels: parseLabelList((settings.included_labels ?? []).join(',')),
    excluded_labels: parseLabelList((settings.excluded_labels ?? []).join(',')),
  }
}

export function hasAutoFixSettingsChanges(
  initialSettings: ProjectAutoFixSettings,
  settings: ProjectAutoFixSettings
) {
  return (
    JSON.stringify(normalizeAutoFixSettings(settings)) !==
    JSON.stringify(normalizeAutoFixSettings(initialSettings))
  )
}

const HOUR_OPTIONS = Array.from({ length: 24 }, (_, hour) => hour)

function formatHour(hour: number): string {
  const period = hour < 12 ? 'AM' : 'PM'
  const display = hour % 12 === 0 ? 12 : hour % 12
  return `${display}:00 ${period}`
}

function Field({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-2">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
      {children}
    </div>
  )
}

function GitHubLabelMultiSelect({
  label,
  labels,
  selected,
  isLoading,
  disabled,
  onChange,
}: {
  label: string
  labels: GitHubLabel[]
  selected: string[]
  isLoading?: boolean
  disabled?: boolean
  onChange: (labels: string[]) => void
}) {
  const [open, setOpen] = useState(false)
  const options = useMemo(() => {
    const byName = new Map<string, GitHubLabel>()
    for (const label of labels) {
      byName.set(label.name.toLowerCase(), label)
    }
    for (const name of selected) {
      if (!byName.has(name.toLowerCase())) {
        byName.set(name.toLowerCase(), { name, color: '6b7280' })
      }
    }
    return Array.from(byName.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
  }, [labels, selected])
  const selectedSet = useMemo(
    () => new Set(selected.map(name => name.toLowerCase())),
    [selected]
  )
  const buttonText =
    selected.length > 0
      ? selected.join(', ')
      : isLoading
        ? 'Loading labels...'
        : 'Select labels'

  const toggleLabel = useCallback(
    (name: string) => {
      const key = name.toLowerCase()
      if (selectedSet.has(key)) {
        onChange(selected.filter(label => label.toLowerCase() !== key))
      } else {
        onChange([...selected, name])
      }
    },
    [onChange, selected, selectedSet]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          aria-label={label}
          disabled={disabled}
          className="w-full justify-between font-normal"
        >
          <span className="truncate text-left">{buttonText}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[24rem] max-w-[80vw] p-0">
        <Command>
          <CommandInput placeholder="Search labels..." />
          <CommandList>
            <CommandEmpty>No GitHub labels found.</CommandEmpty>
            {options.map(option => {
              const checked = selectedSet.has(option.name.toLowerCase())
              return (
                <CommandItem
                  key={option.name}
                  value={option.name}
                  onSelect={() => toggleLabel(option.name)}
                  className="flex items-center gap-2"
                >
                  <Check
                    className={cn(
                      'h-4 w-4',
                      checked ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                  <span
                    className="h-2.5 w-2.5 rounded-full border"
                    style={{ backgroundColor: `#${option.color}` }}
                  />
                  <span className="truncate">{option.name}</span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function getModelOptions(
  backend: string,
  provider: string | null | undefined,
  customCliProfiles: CustomCliProfile[]
) {
  switch (backend) {
    case 'codex':
      return codexDefaultModelOptions
    case 'opencode':
      return OPENCODE_MODEL_OPTIONS
    case 'cursor':
      return CURSOR_MODEL_OPTIONS
    case 'pi':
      return PI_MODEL_OPTIONS
    case 'commandcode':
      return COMMANDCODE_MODEL_OPTIONS
    case 'claude':
      return getClaudeModelOptionsForProvider(provider, customCliProfiles)
    default:
      return modelOptions
  }
}

function getModelLabel(
  backend: string,
  model: string | null | undefined,
  provider: string | null | undefined,
  customCliProfiles: CustomCliProfile[]
) {
  if (!model) return 'Backend default'

  return (
    getModelOptions(backend, provider, customCliProfiles).find(
      option => option.value === model
    )?.label ?? model
  )
}

function AutoFixProviderSelect({
  label,
  provider,
  profiles,
  disabled,
  onChange,
}: {
  label: string
  provider: string | null | undefined
  profiles: CustomCliProfile[]
  disabled?: boolean
  onChange: (provider: string | null) => void
}) {
  if (profiles.length === 0) return null

  return (
    <Select
      value={provider ?? ANTHROPIC_PROVIDER_VALUE}
      onValueChange={value =>
        onChange(value === ANTHROPIC_PROVIDER_VALUE ? null : value)
      }
      disabled={disabled}
    >
      <SelectTrigger
        aria-label={`Choose ${label} provider`}
        className="w-full"
      >
        <SelectValue placeholder="Anthropic" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ANTHROPIC_PROVIDER_VALUE}>Anthropic</SelectItem>
        {profiles.map(profile => (
          <SelectItem key={profile.name} value={profile.name}>
            {profile.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function AutoFixBackendModelPicker({
  label,
  backend,
  model,
  provider,
  customCliProfiles,
  disabled,
  onChange,
}: {
  label: string
  backend: string
  model: string | null | undefined
  provider: string | null | undefined
  customCliProfiles: CustomCliProfile[]
  disabled?: boolean
  onChange: (
    backend: string,
    model: string | null,
    provider: string | null
  ) => void
}) {
  const [open, setOpen] = useState(false)
  const { installedBackends } = useInstalledBackends()
  const selectedBackend = backend as CliBackend
  const selectedProvider = normalizeAutoFixProvider(backend, provider)
  const selectedModel = model ?? BACKEND_DEFAULT_MODEL_VALUE
  const modelLabel = getModelLabel(
    backend,
    model,
    selectedProvider,
    customCliProfiles
  )
  const providerLabel = selectedProvider ?? null
  const handleModelChange = useCallback(
    (nextModel: string) => {
      onChange(
        backend,
        nextModel === BACKEND_DEFAULT_MODEL_VALUE ? null : nextModel,
        selectedProvider
      )
    },
    [backend, onChange, selectedProvider]
  )
  const handleBackendModelChange = useCallback(
    (nextBackend: CliBackend, nextModel: string) => {
      // Switching backends drops Claude-only custom providers.
      const nextProvider =
        nextBackend === 'claude' ? selectedProvider : null
      onChange(
        nextBackend,
        nextModel === BACKEND_DEFAULT_MODEL_VALUE ? null : nextModel,
        nextProvider
      )
    },
    [onChange, selectedProvider]
  )

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Choose ${label} backend and model`}
          disabled={disabled}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-md border border-border/70 bg-background px-3 text-sm text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
            disabled && 'opacity-50'
          )}
        >
          <span className="min-w-0 flex items-center gap-1.5">
            <BackendLabel backend={selectedBackend} className="shrink-0" />
            {providerLabel && (
              <span className="truncate text-muted-foreground">
                · {providerLabel}
              </span>
            )}
            <span className="truncate">· {modelLabel}</span>
          </span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(36rem,calc(100vw-4rem))] p-0"
      >
        <BackendModelPickerContent
          open={open}
          selectedBackend={selectedBackend}
          selectedModel={selectedModel}
          selectedProvider={selectedProvider}
          installedBackends={installedBackends}
          customCliProfiles={customCliProfiles}
          onModelChange={handleModelChange}
          onBackendModelChange={handleBackendModelChange}
          onRequestClose={() => setOpen(false)}
          defaultModelOption={{
            value: BACKEND_DEFAULT_MODEL_VALUE,
            label: 'Backend default',
          }}
        />
      </PopoverContent>
    </Popover>
  )
}

export function AutoFixPane({ projectId }: { projectId: string }) {
  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === projectId)
  const updateSettings = useUpdateProjectSettings()
  const { installedBackends } = useInstalledBackends()
  const { data: preferences } = usePreferences()
  const customCliProfiles = useMemo(
    () => preferences?.custom_cli_profiles ?? [],
    [preferences?.custom_cli_profiles]
  )
  const { data: githubLabels = [], isLoading: githubLabelsLoading } =
    useGitHubLabels(project?.path ?? null, {
      enabled: Boolean(project?.path && !project?.is_folder),
    })

  const initialSettings = useMemo(
    () => buildAutoFixSettings(project?.auto_fix_settings, installedBackends),
    [project?.auto_fix_settings, installedBackends]
  )
  const [settings, setSettings] =
    useState<ProjectAutoFixSettings>(initialSettings)

  useEffect(() => {
    setSettings(initialSettings)
  }, [initialSettings])

  const hasChanges = useMemo(
    () => hasAutoFixSettingsChanges(initialSettings, settings),
    [initialSettings, settings]
  )

  const setNumber = (
    key: 'interval_minutes' | 'issue_limit' | 'max_parallel_worktrees',
    value: string
  ) => {
    const parsed = Number.parseInt(value, 10)
    setSettings(current => ({
      ...current,
      [key]: Number.isFinite(parsed) ? Math.max(1, parsed) : 1,
    }))
  }

  const saveSettings = (nextSettings = settings) => {
    if (!hasAutoFixSettingsChanges(initialSettings, nextSettings)) return

    updateSettings.mutate({
      projectId,
      autoFixSettings: normalizeAutoFixSettings(nextSettings),
    })
  }

  const save = () => saveSettings()

  const handleEnabledChange = (enabled: boolean) => {
    const nextSettings = { ...settings, enabled }
    setSettings(nextSettings)
    saveSettings(nextSettings)
  }

  const handleActiveHoursEnabledChange = (active_hours_enabled: boolean) => {
    const nextSettings = { ...settings, active_hours_enabled }
    setSettings(nextSettings)
    saveSettings(nextSettings)
  }

  const handleAutoYoloEnabledChange = (auto_yolo_enabled: boolean) => {
    const nextSettings = { ...settings, auto_yolo_enabled }
    setSettings(nextSettings)
    saveSettings(nextSettings)
  }

  const setHour = (
    key: 'active_hours_start' | 'active_hours_end',
    value: string
  ) => {
    const parsed = Number.parseInt(value, 10)
    setSettings(current => ({
      ...current,
      [key]: Number.isFinite(parsed) ? Math.max(0, Math.min(23, parsed)) : 0,
    }))
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-medium text-foreground">Mr. Robot</h3>
            <Badge
              variant="outline"
              className="px-1.5 py-0 text-[10px] uppercase tracking-wide text-muted-foreground"
            >
              {MR_ROBOT_SETTINGS_BADGE}
            </Badge>
          </div>
          <Separator className="mt-2" />
        </div>

        <div className="flex items-start justify-between gap-4 rounded-lg border bg-muted/20 p-4">
          <div className="max-w-2xl">
            <Label className="text-sm text-foreground">
              Mr. Robot issue sweeps
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Poll open GitHub issues, create one Jean worktree per issue, and
              draft a focused plan. Optionally let Mr. Robot yolo the plan too.
            </p>
          </div>
          <Switch
            checked={settings.enabled}
            onCheckedChange={handleEnabledChange}
            disabled={updateSettings.isPending}
          />
        </div>

        <div className="rounded-lg border p-4">
          <h4 className="mb-4 text-sm font-medium text-foreground">
            Schedule and limits
          </h4>
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Check every">
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  min={1}
                  value={settings.interval_minutes}
                  onChange={event =>
                    setNumber('interval_minutes', event.target.value)
                  }
                />
                <span className="text-sm text-muted-foreground">minutes</span>
              </div>
            </Field>
            <Field label="Issues per run">
              <Input
                type="number"
                min={1}
                value={settings.issue_limit}
                onChange={event => setNumber('issue_limit', event.target.value)}
              />
            </Field>
            <Field label="Max active worktrees">
              <Input
                type="number"
                min={1}
                value={settings.max_parallel_worktrees}
                onChange={event =>
                  setNumber('max_parallel_worktrees', event.target.value)
                }
              />
            </Field>
          </div>

          <Separator className="my-4" />

          <Field
            label="Included GitHub labels"
            description="When set, Mr. Robot starts from issues with any of these labels. Leave blank to include all open issues before exclusions."
          >
            <GitHubLabelMultiSelect
              label="Included GitHub labels"
              labels={githubLabels}
              selected={settings.included_labels ?? []}
              isLoading={githubLabelsLoading}
              disabled={updateSettings.isPending}
              onChange={included_labels =>
                setSettings(current => ({ ...current, included_labels }))
              }
            />
          </Field>

          <div className="pt-4">
            <Field
              label="Excluded GitHub labels"
              description="Issues with any of these labels are removed from the final Mr. Robot list."
            >
              <GitHubLabelMultiSelect
                label="Excluded GitHub labels"
                labels={githubLabels}
                selected={settings.excluded_labels ?? []}
                isLoading={githubLabelsLoading}
                disabled={updateSettings.isPending}
                onChange={excluded_labels =>
                  setSettings(current => ({ ...current, excluded_labels }))
                }
              />
            </Field>
          </div>

          <Separator className="my-4" />

          <div className="flex items-start justify-between gap-4">
            <div className="max-w-2xl">
              <Label className="text-sm text-foreground">Active hours</Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Only start new fixes during these hours (local time). Wraps past
                midnight.
              </p>
            </div>
            <Switch
              checked={settings.active_hours_enabled ?? false}
              onCheckedChange={handleActiveHoursEnabledChange}
              disabled={updateSettings.isPending}
            />
          </div>

          {settings.active_hours_enabled && (
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="From">
                <Select
                  value={String(settings.active_hours_start ?? 20)}
                  onValueChange={value => setHour('active_hours_start', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map(hour => (
                      <SelectItem key={hour} value={String(hour)}>
                        {formatHour(hour)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="To">
                <Select
                  value={String(settings.active_hours_end ?? 8)}
                  onValueChange={value => setHour('active_hours_end', value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {HOUR_OPTIONS.map(hour => (
                      <SelectItem key={hour} value={String(hour)}>
                        {formatHour(hour)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          )}
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-lg border p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium text-foreground">
                  Planning
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  Plan issues automatically based on the backend model.
                </p>
              </div>
            </div>

            {settings.planning_backend === 'claude' &&
              customCliProfiles.length > 0 && (
                <div className="mb-4">
                  <Field
                    label="Provider"
                    description="Claude custom CLI profile (Settings → Providers)."
                  >
                    <AutoFixProviderSelect
                      label="planning"
                      provider={settings.planning_provider}
                      profiles={customCliProfiles}
                      disabled={updateSettings.isPending}
                      onChange={planning_provider =>
                        setSettings(current => {
                          const nextModel =
                            planning_provider &&
                            current.planning_model &&
                            !['opus', 'sonnet', 'haiku'].includes(
                              current.planning_model
                            )
                              ? 'opus'
                              : current.planning_model
                          return {
                            ...current,
                            planning_provider,
                            planning_model: nextModel,
                          }
                        })
                      }
                    />
                  </Field>
                </div>
              )}

            <Field label="Backend + model">
              <AutoFixBackendModelPicker
                label="planning"
                backend={settings.planning_backend}
                model={settings.planning_model}
                provider={settings.planning_provider}
                customCliProfiles={customCliProfiles}
                onChange={(
                  planning_backend,
                  planning_model,
                  planning_provider
                ) =>
                  setSettings(current => ({
                    ...current,
                    planning_backend,
                    planning_model,
                    planning_provider:
                      planning_backend === 'claude'
                        ? planning_provider
                        : null,
                  }))
                }
              />
            </Field>
          </div>

          <div className="rounded-lg border p-4">
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <h4 className="text-sm font-medium text-foreground">
                  Yolo execution
                </h4>
                <p className="mt-1 text-xs text-muted-foreground">
                  Automatically approve ready plans and start execution.
                </p>
              </div>
              <Checkbox
                aria-label="Also yolo approved plans"
                checked={settings.auto_yolo_enabled ?? false}
                onCheckedChange={checked =>
                  handleAutoYoloEnabledChange(checked === true)
                }
                disabled={updateSettings.isPending}
              />
            </div>
            {settings.yolo_backend === 'claude' &&
              customCliProfiles.length > 0 && (
                <div className="mb-4">
                  <Field
                    label="Provider"
                    description="Claude custom CLI profile (Settings → Providers)."
                  >
                    <AutoFixProviderSelect
                      label="yolo"
                      provider={settings.yolo_provider}
                      profiles={customCliProfiles}
                      disabled={
                        !settings.auto_yolo_enabled || updateSettings.isPending
                      }
                      onChange={yolo_provider =>
                        setSettings(current => {
                          const nextModel =
                            yolo_provider &&
                            current.yolo_model &&
                            !['opus', 'sonnet', 'haiku'].includes(
                              current.yolo_model
                            )
                              ? 'opus'
                              : current.yolo_model
                          return {
                            ...current,
                            yolo_provider,
                            yolo_model: nextModel,
                          }
                        })
                      }
                    />
                  </Field>
                </div>
              )}
            <Field label="Backend + model">
              <AutoFixBackendModelPicker
                label="yolo"
                backend={settings.yolo_backend}
                model={settings.yolo_model}
                provider={settings.yolo_provider}
                customCliProfiles={customCliProfiles}
                disabled={!settings.auto_yolo_enabled}
                onChange={(yolo_backend, yolo_model, yolo_provider) =>
                  setSettings(current => ({
                    ...current,
                    yolo_backend,
                    yolo_model,
                    yolo_provider:
                      yolo_backend === 'claude' ? yolo_provider : null,
                  }))
                }
              />
            </Field>
          </div>
        </div>

        <Button
          onClick={save}
          disabled={updateSettings.isPending || !hasChanges}
        >
          {updateSettings.isPending && (
            <Loader2 className="h-4 w-4 animate-spin" />
          )}
          Save settings
        </Button>
      </div>
    </div>
  )
}
