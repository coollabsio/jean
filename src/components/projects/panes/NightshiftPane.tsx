import { useState, useCallback } from 'react'
import {
  Play,
  History,
  Loader2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select'
import {
  useNightshiftChecks,
  useNightshiftConfig,
  useSaveNightshiftConfig,
  useStartNightshiftRun,
} from '@/services/nightshift'
import { useNightshiftStore } from '@/store/nightshift-store'
import { defaultNightshiftConfig } from '@/types/nightshift'
import type {
  NightshiftConfig,
  NightshiftCheckConfig,
} from '@/types/nightshift'
import {
  MODEL_OPTIONS as CLAUDE_MODEL_OPTIONS,
  CODEX_MODEL_OPTIONS,
  OPENCODE_MODEL_OPTIONS,
} from '@/components/chat/toolbar/toolbar-options'

const DEFAULT_OPTION = { value: '', label: 'Default' }

function getModelOptionsForBackend(backend?: string) {
  switch (backend) {
    case 'codex':
      return [DEFAULT_OPTION, ...CODEX_MODEL_OPTIONS]
    case 'opencode':
      return [DEFAULT_OPTION, ...OPENCODE_MODEL_OPTIONS]
    default:
      return [DEFAULT_OPTION, ...CLAUDE_MODEL_OPTIONS]
  }
}

const BACKEND_OPTIONS = [
  { value: '', label: 'Default (Claude)' },
  { value: 'claude', label: 'Claude' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
]

const POST_ACTION_OPTIONS = [
  { value: 'nothing', label: 'Leave unstaged' },
  { value: 'commit', label: 'Commit only' },
  { value: 'commit_and_pr', label: 'Commit & PR' },
]

const SettingsSection: React.FC<{
  title: string
  children: React.ReactNode
}> = ({ title, children }) => (
  <div className="space-y-4">
    <div>
      <h3 className="text-lg font-medium text-foreground">{title}</h3>
      <Separator className="mt-2" />
    </div>
    {children}
  </div>
)

function SettingsRow({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="space-y-0.5 min-w-0">
        <Label className="text-sm text-foreground">{label}</Label>
        {description && (
          <p className="text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

export function NightshiftPane({
  projectId,
}: {
  projectId: string
  projectPath: string
}) {
  const { data: checks = [] } = useNightshiftChecks()
  const { data: config } = useNightshiftConfig(projectId)
  const saveConfig = useSaveNightshiftConfig()
  const startRun = useStartNightshiftRun()
  const activeRuns = useNightshiftStore(s => s.activeRuns)
  const isRunning = !!activeRuns[projectId]

  const currentConfig = config ?? defaultNightshiftConfig

  const [expandedChecks, setExpandedChecks] = useState<Set<string>>(new Set())

  const toggleExpanded = useCallback((checkId: string) => {
    setExpandedChecks(prev => {
      const next = new Set(prev)
      if (next.has(checkId)) next.delete(checkId)
      else next.add(checkId)
      return next
    })
  }, [])

  const updateConfig = useCallback(
    (updates: Partial<NightshiftConfig>) => {
      saveConfig.mutate({
        projectId,
        config: { ...currentConfig, ...updates },
      })
    },
    [projectId, currentConfig, saveConfig]
  )

  const handleToggleEnabled = useCallback(() => {
    updateConfig({ enabled: !currentConfig.enabled })
  }, [currentConfig.enabled, updateConfig])

  const handleToggleCheck = useCallback(
    (checkId: string, isDefault: boolean) => {
      const updatedConfig = { ...currentConfig }

      if (isDefault) {
        if (updatedConfig.disabledChecks.includes(checkId)) {
          updatedConfig.disabledChecks = updatedConfig.disabledChecks.filter(
            id => id !== checkId
          )
        } else {
          updatedConfig.disabledChecks = [
            ...updatedConfig.disabledChecks,
            checkId,
          ]
        }
      } else {
        if (updatedConfig.extraEnabledChecks.includes(checkId)) {
          updatedConfig.extraEnabledChecks =
            updatedConfig.extraEnabledChecks.filter(id => id !== checkId)
        } else {
          updatedConfig.extraEnabledChecks = [
            ...updatedConfig.extraEnabledChecks,
            checkId,
          ]
        }
      }

      saveConfig.mutate({ projectId, config: updatedConfig })
    },
    [projectId, currentConfig, saveConfig]
  )

  const isCheckEnabled = useCallback(
    (checkId: string, isDefault: boolean) => {
      if (isDefault) {
        return !currentConfig.disabledChecks.includes(checkId)
      }
      return currentConfig.extraEnabledChecks.includes(checkId)
    },
    [currentConfig]
  )

  const handleRunNow = useCallback(async () => {
    const toastId = toast.loading('Starting Nightshift run...')
    try {
      await startRun.mutateAsync(projectId)
      toast.success('Nightshift run started', { id: toastId })
    } catch (error) {
      toast.error(`Failed to start: ${error}`, { id: toastId })
    }
  }, [projectId, startRun])

  const handleViewHistory = useCallback(() => {
    useNightshiftStore.getState().openRunsModal(projectId)
  }, [projectId])

  const updateCheckConfig = useCallback(
    (checkId: string, updates: Partial<NightshiftCheckConfig>) => {
      const existingConfig = currentConfig.checkConfigs[checkId] ?? {}
      const newCheckConfigs = {
        ...currentConfig.checkConfigs,
        [checkId]: { ...existingConfig, ...updates },
      }
      updateConfig({ checkConfigs: newCheckConfigs })
    },
    [currentConfig, updateConfig]
  )

  const handleResetPrompt = useCallback(
    (checkId: string) => {
      updateCheckConfig(checkId, { customPrompt: undefined })
      toast.success('Prompt reset to default')
    },
    [updateCheckConfig]
  )

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-yellow-500/20 bg-yellow-500/5 p-4">
        <p className="text-sm text-muted-foreground">
          <strong className="text-yellow-600 dark:text-yellow-400">
            Experimental.
          </strong>{' '}
          Nightshift runs automated maintenance checks on your codebase in the
          background.
        </p>
      </div>
      <SettingsSection title="Nightshift">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <Label className="text-sm text-foreground">Enable Nightshift</Label>
            <p className="text-xs text-muted-foreground">
              AI-powered maintenance that creates sessions to fix code issues
            </p>
          </div>
          <Switch
            checked={currentConfig.enabled}
            onCheckedChange={handleToggleEnabled}
          />
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleRunNow}
            disabled={isRunning}
          >
            {isRunning ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Play className="h-4 w-4" />
            )}
            {isRunning ? 'Running...' : 'Run Now'}
          </Button>
          <Button variant="outline" size="sm" onClick={handleViewHistory}>
            <History className="h-4 w-4" />
            View History
          </Button>
        </div>
      </SettingsSection>

      <SettingsSection title="Configuration">
        <SettingsRow label="Backend" description="CLI backend for sessions">
          <NativeSelect
            value={currentConfig.backend ?? ''}
            onChange={e =>
              updateConfig({ backend: e.target.value || undefined, model: undefined })
            }
          >
            {BACKEND_OPTIONS.map(opt => (
              <NativeSelectOption key={opt.value} value={opt.value}>
                {opt.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </SettingsRow>

        <SettingsRow label="Model" description="Model for nightshift sessions">
          <NativeSelect
            value={currentConfig.model ?? ''}
            onChange={e => updateConfig({ model: e.target.value || undefined })}
          >
            {getModelOptionsForBackend(currentConfig.backend).map(opt => (
              <NativeSelectOption key={opt.value} value={opt.value}>
                {opt.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </SettingsRow>

        <SettingsRow label="After Run" description="What to do with changes">
          <NativeSelect
            value={currentConfig.postAction}
            onChange={e =>
              updateConfig({
                postAction: e.target.value as NightshiftConfig['postAction'],
              })
            }
          >
            {POST_ACTION_OPTIONS.map(opt => (
              <NativeSelectOption key={opt.value} value={opt.value}>
                {opt.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </SettingsRow>

        <SettingsRow
          label="Schedule"
          description="Time of day to auto-run (HH:MM)"
        >
          <Input
            type="time"
            className="w-28"
            value={currentConfig.scheduleTime ?? ''}
            onChange={e =>
              updateConfig({ scheduleTime: e.target.value || undefined })
            }
          />
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title="Checks">
        <p className="text-xs text-muted-foreground">
          Select which maintenance checks to run. Click a check to configure its
          cooldown and prompt.
        </p>
        <div className="space-y-2">
          {checks.map(check => {
            const isExpanded = expandedChecks.has(check.id)
            const effectiveCooldown =
              currentConfig.checkConfigs[check.id]?.cooldownHoursOverride ??
              check.cooldownHours
            const customPrompt =
              currentConfig.checkConfigs[check.id]?.customPrompt ?? ''

            return (
              <div key={check.id} className="border border-border rounded-md">
                <div className="flex items-start gap-3 p-3">
                  <Checkbox
                    id={`check-${check.id}`}
                    checked={isCheckEnabled(check.id, check.defaultEnabled)}
                    onCheckedChange={() =>
                      handleToggleCheck(check.id, check.defaultEnabled)
                    }
                    className="mt-0.5"
                  />
                  <button
                    type="button"
                    className="flex-1 text-left cursor-pointer"
                    onClick={() => toggleExpanded(check.id)}
                  >
                    <div className="flex items-center gap-1">
                      {isExpanded ? (
                        <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                      )}
                      <span className="text-sm font-medium text-foreground">
                        {check.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ({effectiveCooldown}h cooldown)
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground ml-5">
                      {check.description}
                    </p>
                  </button>
                </div>

                {isExpanded && (
                  <div className="px-3 pb-3 pt-1 space-y-3 border-t border-border">
                    <div className="flex items-center gap-2">
                      <Label className="text-xs text-muted-foreground w-20 shrink-0">
                        Cooldown
                      </Label>
                      <Input
                        type="number"
                        className="w-20"
                        min={1}
                        value={
                          currentConfig.checkConfigs[check.id]
                            ?.cooldownHoursOverride ?? check.cooldownHours
                        }
                        onChange={e => {
                          const val = Number(e.target.value)
                          if (val === check.cooldownHours) {
                            updateCheckConfig(check.id, {
                              cooldownHoursOverride: undefined,
                            })
                          } else {
                            updateCheckConfig(check.id, {
                              cooldownHoursOverride: val,
                            })
                          }
                        }}
                      />
                      <span className="text-xs text-muted-foreground">
                        hours
                      </span>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs text-muted-foreground">
                          Custom Prompt
                        </Label>
                        {customPrompt && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs"
                            onClick={() => handleResetPrompt(check.id)}
                          >
                            <RotateCcw className="h-3 w-3 mr-1" />
                            Reset
                          </Button>
                        )}
                      </div>
                      <Textarea
                        className="text-xs font-mono min-h-[80px]"
                        placeholder="Leave empty to use built-in default prompt..."
                        value={customPrompt}
                        onChange={e =>
                          updateCheckConfig(check.id, {
                            customPrompt: e.target.value || undefined,
                          })
                        }
                      />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </SettingsSection>
    </div>
  )
}
