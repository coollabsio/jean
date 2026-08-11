/**
 * Hermes Agent preferences: CLI install, gateway, model, and scheduled jobs.
 */

import React, { useCallback, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useQueryClient } from '@tanstack/react-query'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { BackendPaneHeader, SettingsSection } from '../SettingsSection'
import { HermesJobsPane } from './HermesJobsPane'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import {
  hermesCliQueryKeys,
  useAvailableHermesModels,
  useHermesCliAuth,
  useHermesCliStatus,
  useHermesPathDetection,
  useHermesStatus,
  useStartHermesGateway,
  useUninstallHermesCli,
} from '@/services/hermes-cli'
import { useUIStore } from '@/store/ui-store'
import { copyToClipboard } from '@/lib/clipboard'
import type { HermesAuthStatus } from '@/types/hermes-cli'

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

export function HermesPane() {
  const queryClient = useQueryClient()
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const openCliUpdateModal = useUIStore(state => state.openCliUpdateModal)
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)

  const { data: hermesStatus, isLoading: isHermesLoading } =
    useHermesCliStatus()
  const { data: pathDetection } = useHermesPathDetection()
  const { data: hermesAuth, isLoading: isHermesAuthLoading } = useHermesCliAuth(
    { enabled: !!hermesStatus?.installed }
  )
  const connection = useHermesStatus()
  const startGateway = useStartHermesGateway()
  const uninstallHermes = useUninstallHermesCli()
  const { data: models = [], isLoading: modelsLoading } =
    useAvailableHermesModels({
      enabled: !!hermesStatus?.installed,
    })

  const [checkingAuth, setCheckingAuth] = useState(false)
  const [confirmUninstall, setConfirmUninstall] = useState(false)

  const selectedModel =
    preferences?.selected_hermes_model ?? 'hermes-agent'
  const modelOptions =
    models.length > 0
      ? models
      : [
          {
            id: 'hermes-agent',
            label: 'Hermes Agent (gateway default)',
            provider: '',
            model: 'hermes-agent',
            isDefault: true,
          },
        ]

  const handleCopyPath = useCallback(async (path?: string | null) => {
    if (!path) return
    try {
      await copyToClipboard(path)
      toast.success('Path copied')
    } catch {
      toast.error('Failed to copy path')
    }
  }, [])

  const handleInstall = useCallback(() => {
    // Match other backends: start from Jean-managed. Official installer still
    // places the binary on PATH and backend may patch source to `path` after.
    if (preferences?.hermes_cli_source !== 'jean') {
      patchPreferences.mutate({ hermes_cli_source: 'jean' })
    }
    openCliUpdateModal('hermes')
  }, [openCliUpdateModal, patchPreferences, preferences?.hermes_cli_source])

  const handleSourceChange = useCallback(
    (value: string) => {
      if (value !== 'jean' && value !== 'path') return
      // Do not allow selecting System PATH when no binary is discoverable.
      if (value === 'path' && !pathDetection?.found) return
      patchPreferences.mutate({ hermes_cli_source: value })
      void queryClient.invalidateQueries({ queryKey: hermesCliQueryKeys.all })
    },
    [patchPreferences, queryClient, pathDetection?.found]
  )

  const handleLogin = useCallback(async () => {
    if (!hermesStatus?.path) return
    setCheckingAuth(true)
    try {
      await queryClient.invalidateQueries({
        queryKey: hermesCliQueryKeys.auth(),
      })
      const result = await queryClient.fetchQuery<HermesAuthStatus>({
        queryKey: hermesCliQueryKeys.auth(),
      })
      if (result?.authenticated) {
        toast.success('Hermes is already authenticated')
        return
      }
    } finally {
      setCheckingAuth(false)
    }
    // Hermes owns provider OAuth / API keys via `hermes model` (or setup).
    openCliLoginModal('hermes', hermesStatus.path, ['model'])
  }, [hermesStatus?.path, openCliLoginModal, queryClient])

  const handleModelChange = useCallback(
    (value: string) => {
      patchPreferences.mutate({ selected_hermes_model: value })
    },
    [patchPreferences]
  )

  const handleBaseUrlChange = useCallback(
    (value: string) => {
      patchPreferences.mutate({
        hermes_api_base_url: value.trim() || 'http://127.0.0.1:8642',
      })
    },
    [patchPreferences]
  )

  const handleProfileChange = useCallback(
    (value: string) => {
      patchPreferences.mutate({ hermes_profile: value.trim() })
    },
    [patchPreferences]
  )

  const handleUninstall = useCallback(() => {
    uninstallHermes.mutate(undefined, {
      onSettled: () => setConfirmUninstall(false),
    })
  }, [uninstallHermes])

  const authMessage = hermesAuth?.error ?? null
  const pathFound = !!pathDetection?.found
  // Prefer Jean-managed when PATH has no hermes (same as other backends).
  const preferredSource = preferences?.hermes_cli_source ?? 'jean'
  const source =
    preferredSource === 'path' && !pathFound ? 'jean' : preferredSource
  const displayPath =
    source === 'path'
      ? (pathDetection?.path ?? hermesStatus?.path)
      : hermesStatus?.path

  return (
    <div className="flex min-h-0 flex-col gap-6">
      <BackendPaneHeader
        backend="hermes"
        description="Install the Hermes Agent CLI, keep the gateway always-on for cron, and manage scheduled jobs."
      />

      <SettingsSection
        title="CLI source"
        anchorId="pref-hermes-section-cli"
        variant="card"
        actions={
          hermesStatus?.installed ? (
            checkingAuth || isHermesAuthLoading ? (
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                <Loader2 className="size-3 animate-spin" />
                Checking...
              </span>
            ) : hermesAuth?.authenticated ? (
              <span className="text-sm text-muted-foreground flex items-center gap-2">
                Logged in
                <Button size="sm" onClick={handleLogin}>
                  Relogin
                </Button>
              </span>
            ) : (
              <Button size="sm" onClick={handleLogin}>
                Login
              </Button>
            )
          ) : (
            <Button size="sm" onClick={handleInstall}>
              Install
            </Button>
          )
        }
      >
        <div className="space-y-4">
          <InlineField
            label={hermesStatus?.installed ? 'Version' : 'Status'}
            description={
              hermesStatus?.installed
                ? 'Enables Hermes chat sessions and gateway cron jobs.'
                : 'Install via the official Hermes installer, or use a system PATH binary.'
            }
          >
            {isHermesLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : hermesStatus?.installed ? (
              <Button
                variant="outline"
                className="w-full sm:w-40 justify-between"
                onClick={handleInstall}
              >
                {hermesStatus.version ?? 'Installed'}
              </Button>
            ) : (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  Not installed
                </span>
                <Button variant="outline" size="sm" onClick={handleInstall}>
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
                    type="button"
                    onClick={() => handleCopyPath(displayPath)}
                    className="text-left hover:underline cursor-pointer"
                  >
                    {displayPath ?? 'Not installed'}
                  </button>
                </TooltipTrigger>
                <TooltipContent>Click to copy path</TooltipContent>
              </Tooltip>
            }
          >
            <div className="flex items-center gap-2">
              <Select value={source} onValueChange={handleSourceChange}>
                <SelectTrigger className="w-full sm:w-80">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="jean">Jean-managed</SelectItem>
                  <SelectItem value="path" disabled={!pathFound}>
                    System PATH
                    {!pathFound && ' (not found)'}
                  </SelectItem>
                </SelectContent>
              </Select>
              {source === 'jean' && hermesStatus?.installed && (
                <Button
                  variant="destructive"
                  size="sm"
                  disabled={uninstallHermes.isPending}
                  onClick={() => setConfirmUninstall(true)}
                >
                  Uninstall
                </Button>
              )}
            </div>
          </InlineField>

          {confirmUninstall && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm space-y-2">
              <p>
                Stops the Hermes gateway service managed by Jean. Your{' '}
                <code className="text-xs">~/.hermes</code> data is kept. Run{' '}
                <code className="text-xs">hermes uninstall</code> for a full
                wipe.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={uninstallHermes.isPending}
                  onClick={handleUninstall}
                >
                  {uninstallHermes.isPending ? 'Removing…' : 'Confirm uninstall'}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmUninstall(false)}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {hermesStatus?.installed && !hermesAuth?.authenticated && authMessage && (
            <p className="text-xs text-muted-foreground">{authMessage}</p>
          )}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Gateway & model"
        anchorId="pref-hermes-section-settings"
        variant="card"
        actions={
          connection.data?.apiReachable ? (
            <span className="text-sm text-muted-foreground">Gateway up</span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={
                !hermesStatus?.installed || startGateway.isPending
              }
              onClick={() => startGateway.mutate()}
            >
              {startGateway.isPending ? 'Starting…' : 'Start gateway'}
            </Button>
          )
        }
      >
        <div className="space-y-4">
          <InlineField
            label="API base URL"
            description="Hermes API server (no trailing /v1). Default http://127.0.0.1:8642"
          >
            <Input
              className="w-full sm:w-80"
              defaultValue={
                preferences?.hermes_api_base_url ?? 'http://127.0.0.1:8642'
              }
              key={preferences?.hermes_api_base_url ?? 'default-url'}
              onBlur={e => handleBaseUrlChange(e.target.value)}
              placeholder="http://127.0.0.1:8642"
            />
          </InlineField>

          <InlineField
            label="Profile"
            description="Hermes profile name (empty = default ~/.hermes)"
          >
            <Input
              className="w-full sm:w-80"
              defaultValue={preferences?.hermes_profile ?? ''}
              key={preferences?.hermes_profile ?? 'default-profile'}
              onBlur={e => handleProfileChange(e.target.value)}
              placeholder="default"
            />
          </InlineField>

          <InlineField
            label="Default model"
            description="Model for new Hermes sessions (from authenticated providers)"
          >
            {modelsLoading ? (
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            ) : (
              <Select value={selectedModel} onValueChange={handleModelChange}>
                <SelectTrigger className="w-full sm:w-80 max-w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map(option => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </InlineField>
        </div>
      </SettingsSection>

      <HermesJobsPane embedded />
    </div>
  )
}
