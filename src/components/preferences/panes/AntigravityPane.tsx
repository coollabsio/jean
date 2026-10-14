import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { SettingsSection } from '../SettingsSection'
import { BackendCliSourceSelect } from '../BackendCliSourceSelect'
import {
  antigravityCliQueryKeys,
  useAvailableAntigravityModels,
  useAvailableAntigravityVersions,
  useAntigravityCliAuth,
  useAntigravityPathDetection,
  useAntigravityCliStatus,
  useInstallAntigravityCli,
  useUninstallAntigravityCli,
} from '@/services/antigravity-cli'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useUIStore } from '@/store/ui-store'

export function AntigravityPane() {
  const status = useAntigravityCliStatus()
  const auth = useAntigravityCliAuth({ enabled: !!status.data?.installed })
  const models = useAvailableAntigravityModels({
    enabled: !!status.data?.installed,
  })
  const install = useInstallAntigravityCli()
  const uninstall = useUninstallAntigravityCli()
  const versions = useAvailableAntigravityVersions()
  const pathDetection = useAntigravityPathDetection()
  const { data: preferences } = usePreferences()
  const patch = usePatchPreferences()
  const queryClient = useQueryClient()
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)
  const source = preferences?.antigravity_cli_source ?? 'jean'
  const stableVersions = useMemo(
    () => (versions.data ?? []).filter(version => !version.prerelease),
    [versions.data]
  )
  const [selectedVersion, setSelectedVersion] = useState('latest')

  useEffect(() => {
    if (selectedVersion === 'latest' && stableVersions[0]?.version) {
      setSelectedVersion(stableVersions[0].version)
    }
  }, [selectedVersion, stableVersions])

  const setSource = (value: 'jean' | 'path') => {
    patch.mutate(
      { antigravity_cli_source: value },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: antigravityCliQueryKeys.all,
          })
        },
      }
    )
  }

  return (
    <div className="w-full max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Google&apos;s official Antigravity CLI.
      </p>
      <SettingsSection title="CLI source" variant="card">
        <BackendCliSourceSelect
          value={source}
          onValueChange={setSource}
          backendName="Antigravity CLI"
          path={pathDetection.data?.path}
          pathVersion={pathDetection.data?.version}
          pathFound={!!pathDetection.data?.found}
        />
      </SettingsSection>

      <SettingsSection title="CLI installation" variant="card">
        {source === 'jean' ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-52 flex-1 space-y-1.5">
                <Label htmlFor="antigravity-managed-version">Version</Label>
                <select
                  id="antigravity-managed-version"
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={selectedVersion}
                  disabled={versions.isFetching || install.isPending}
                  onChange={event => setSelectedVersion(event.target.value)}
                >
                  {stableVersions.length === 0 && (
                    <option value="latest">Latest stable</option>
                  )}
                  {stableVersions.map(version => (
                    <option key={version.version} value={version.version}>
                      {version.version}
                    </option>
                  ))}
                </select>
              </div>
              <Button
                size="sm"
                disabled={install.isPending}
                onClick={() => install.mutate(selectedVersion)}
              >
                {install.isPending
                  ? 'Installing…'
                  : status.data?.installed
                    ? 'Install version'
                    : 'Install'}
              </Button>
              {status.data?.installed && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={uninstall.isPending}
                  onClick={() => uninstall.mutate()}
                >
                  {uninstall.isPending ? 'Removing…' : 'Remove'}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {status.isLoading
                ? 'Checking Jean-managed installation…'
                : status.data?.installed
                  ? `Installed ${status.data.version ?? 'version unknown'} · ${status.data.path ?? 'managed path'}`
                  : 'Jean-managed Antigravity CLI is not installed.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            {pathDetection.data?.found
              ? `Using ${pathDetection.data.path}${pathDetection.data.version ? ` · ${pathDetection.data.version}` : ''}`
              : 'Install Antigravity CLI on your PATH, then select Refresh.'}
            <div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => pathDetection.refetch()}
              >
                Refresh
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Authentication" variant="card">
        <div className="flex items-center justify-between gap-4 text-sm">
          <span>
            {!status.data?.installed
              ? 'Select an installed Antigravity CLI source first.'
              : auth.isLoading
                ? 'Checking authentication…'
                : auth.data?.authenticated
                  ? 'Authenticated'
                  : auth.data?.timedOut
                    ? 'Auth check timed out. Try again or run `agy` manually.'
                    : `Not authenticated${auth.data?.error ? ` · ${auth.data.error}` : ''}`}
          </span>
          {status.data?.installed && status.data.path && (
            <div className="flex items-center gap-2">
              {auth.data?.timedOut && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={auth.isFetching}
                  onClick={() => auth.refetch()}
                >
                  {auth.isFetching ? 'Retrying…' : 'Retry'}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() =>
                  openCliLoginModal(
                    'antigravity',
                    status.data?.path ?? 'agy',
                    [],
                    'login'
                  )
                }
              >
                {auth.data?.authenticated ? 'Relogin' : 'Login'}
              </Button>
            </div>
          )}
        </div>
      </SettingsSection>
      <SettingsSection title="Default model" variant="card">
        <select
          aria-label="Default model"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={preferences?.selected_antigravity_model ?? 'antigravity/auto'}
          onChange={event =>
            patch.mutate({
              selected_antigravity_model: event.target
                .value as `antigravity/${string}`,
            })
          }
        >
          {(
            models.data ?? [
              { id: 'auto', label: 'Auto' },
              { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
              {
                id: 'gemini-3.6-flash-medium',
                label: 'Gemini 3.6 Flash (Medium)',
              },
              {
                id: 'gemini-3.5-flash-medium',
                label: 'Gemini 3.5 Flash (Medium)',
              },
              { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
            ]
          ).map(model => (
            <option key={model.id} value={`antigravity/${model.id}`}>
              {model.label}
            </option>
          ))}
        </select>
      </SettingsSection>
    </div>
  )
}
