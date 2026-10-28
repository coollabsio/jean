import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from '../SettingsSection'
import { InlineField } from '../InlineField'
import { CliAuthActions, CliAuthProblem } from '../CliAuthActions'
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

const FALLBACK_MODELS = [
  { id: 'auto', label: 'Auto' },
  { id: 'gemini-3.6-flash-high', label: 'Gemini 3.6 Flash (High)' },
  { id: 'gemini-3.6-flash-medium', label: 'Gemini 3.6 Flash (Medium)' },
  { id: 'gemini-3.5-flash-medium', label: 'Gemini 3.5 Flash (Medium)' },
  { id: 'gemini-3.1-pro-high', label: 'Gemini 3.1 Pro (High)' },
]

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

  const installed = !!status.data?.installed
  const signIn = () =>
    openCliLoginModal('antigravity', status.data?.path ?? 'agy', [], 'login')
  const modelOptions = models.data ?? FALLBACK_MODELS

  return (
    <div className="w-full space-y-8">
      <SettingsSection
        title="CLI"
        anchorId="pref-antigravity-section-cli"
        actions={
          <CliAuthActions
            installed={installed}
            checking={auth.isLoading}
            authenticated={!!auth.data?.authenticated}
            onSignIn={signIn}
            onSignInAgain={signIn}
          />
        }
      >
        <InlineField label="Source">
          <BackendCliSourceSelect
            value={source}
            onValueChange={setSource}
            backendName="Antigravity CLI"
            path={pathDetection.data?.path}
            pathVersion={pathDetection.data?.version}
            pathFound={!!pathDetection.data?.found}
          />
        </InlineField>
        <InlineField
          label={installed ? 'Version' : 'Status'}
          description={
            source === 'jean'
              ? status.isLoading
                ? 'Checking installation…'
                : installed
                  ? `${status.data?.version ?? 'Version unknown'} · ${status.data?.path ?? 'managed path'}`
                  : undefined
              : pathDetection.data?.found
                ? `Using ${pathDetection.data.path}${pathDetection.data.version ? ` · ${pathDetection.data.version}` : ''}`
                : 'Install Antigravity CLI on your PATH, then select Refresh.'
          }
        >
          {source === 'path' ? (
            <Button
              size="sm"
              variant="outline"
              className="w-fit"
              onClick={() => pathDetection.refetch()}
            >
              Refresh
            </Button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={selectedVersion}
                onValueChange={setSelectedVersion}
                disabled={versions.isFetching || install.isPending}
              >
                <SelectTrigger
                  aria-label="Managed version"
                  size="sm"
                  className="w-40"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {stableVersions.length === 0 && (
                    <SelectItem value="latest">Latest stable</SelectItem>
                  )}
                  {stableVersions.map(version => (
                    <SelectItem key={version.version} value={version.version}>
                      {version.version}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                variant={installed ? 'outline' : 'default'}
                disabled={install.isPending}
                onClick={() => install.mutate(selectedVersion)}
              >
                {install.isPending
                  ? 'Installing…'
                  : installed
                    ? 'Install version'
                    : 'Install'}
              </Button>
              {installed && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={uninstall.isPending}
                  onClick={() => uninstall.mutate()}
                >
                  {uninstall.isPending ? 'Removing…' : 'Uninstall'}
                </Button>
              )}
            </div>
          )}
        </InlineField>
        {installed && !auth.isLoading && !auth.data?.authenticated && (
          <CliAuthProblem
            timedOut={!!auth.data?.timedOut}
            error={auth.data?.error}
            retrying={auth.isFetching}
            onRetry={() => auth.refetch()}
            manualCommand="agy"
          />
        )}
      </SettingsSection>

      <SettingsSection
        title="Default model"
        anchorId="pref-antigravity-section-settings"
      >
        <InlineField label="Model">
          <Select
            value={
              preferences?.selected_antigravity_model ?? 'antigravity/auto'
            }
            onValueChange={value =>
              patch.mutate({
                selected_antigravity_model: value as `antigravity/${string}`,
              })
            }
          >
            <SelectTrigger
              aria-label="Default model"
              className="w-full sm:w-80"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modelOptions.map(model => (
                <SelectItem key={model.id} value={`antigravity/${model.id}`}>
                  {model.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </InlineField>
      </SettingsSection>
    </div>
  )
}
