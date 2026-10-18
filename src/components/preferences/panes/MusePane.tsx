import { Button } from '@/components/ui/button'
import { SettingsSection } from '../SettingsSection'
import { BackendCliSourceSelect } from '../BackendCliSourceSelect'
import {
  MUSE_FALLBACK_MODELS,
  museCliQueryKeys,
  useAvailableMuseModels,
  useInstallMuseCli,
  useMuseCliAuth,
  useMuseCliStatus,
  useMusePathDetection,
  useUninstallMuseCli,
  useUpdateMuseCli,
} from '@/services/muse-cli'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import type { MuseModel } from '@/types/preferences'
import { useQueryClient } from '@tanstack/react-query'
import { useUIStore } from '@/store/ui-store'

export function MusePane() {
  const status = useMuseCliStatus()
  const installed = !!status.data?.installed
  const auth = useMuseCliAuth({ enabled: installed })
  const models = useAvailableMuseModels({ enabled: installed })
  const install = useInstallMuseCli()
  const update = useUpdateMuseCli()
  const uninstall = useUninstallMuseCli()
  const openCliLoginModal = useUIStore(state => state.openCliLoginModal)
  const pathDetection = useMusePathDetection()
  const { data: preferences } = usePreferences()
  const patch = usePatchPreferences()
  const queryClient = useQueryClient()
  const source = preferences?.muse_cli_source ?? 'jean'
  const selectedModel = preferences?.selected_muse_model ?? 'muse/default'
  const modelOptions = models.data ?? MUSE_FALLBACK_MODELS
  // Keep a saved model selectable before the live model list has loaded.
  const visibleModelOptions = modelOptions.some(
    model => model.id === selectedModel
  )
    ? modelOptions
    : [
        ...modelOptions,
        { id: selectedModel, label: selectedModel.replace(/^muse\//, '') },
      ]
  const managedBusy =
    install.isPending || update.isPending || uninstall.isPending

  const setSource = (value: 'jean' | 'path') => {
    patch.mutate(
      { muse_cli_source: value },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: museCliQueryKeys.all })
        },
      }
    )
  }

  return (
    <div className="w-full max-w-3xl space-y-6">
      <p className="text-sm text-muted-foreground">
        Meta&apos;s Muse Code CLI.
      </p>
      <SettingsSection title="CLI source" variant="card">
        <BackendCliSourceSelect
          value={source}
          onValueChange={setSource}
          backendName="Muse CLI"
          managedDescription="Jean installs an isolated Muse CLI. Its launcher keeps itself up to date."
          path={pathDetection.data?.path}
          pathVersion={pathDetection.data?.version}
          pathFound={!!pathDetection.data?.found}
        />
      </SettingsSection>

      <SettingsSection title="CLI installation" variant="card">
        {source === 'jean' ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              {installed ? (
                <>
                  <Button
                    size="sm"
                    disabled={managedBusy}
                    onClick={() => update.mutate()}
                  >
                    {update.isPending ? 'Updating…' : 'Update'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={managedBusy}
                    onClick={() => uninstall.mutate()}
                  >
                    {uninstall.isPending ? 'Removing…' : 'Remove'}
                  </Button>
                </>
              ) : (
                <Button
                  size="sm"
                  disabled={managedBusy || status.isLoading}
                  onClick={() => install.mutate('latest')}
                >
                  {install.isPending ? 'Installing…' : 'Install latest'}
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {status.isLoading
                ? 'Checking Jean-managed installation…'
                : installed
                  ? `Installed ${status.data?.version ?? 'version unknown'} · ${status.data?.path ?? 'managed path'}`
                  : 'Jean-managed Muse CLI is not installed.'}
            </p>
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            {pathDetection.data?.found ? (
              `Using ${pathDetection.data.path}${pathDetection.data.version ? ` · ${pathDetection.data.version}` : ''}`
            ) : (
              <>
                Install Muse on your PATH with{' '}
                <code className="rounded bg-muted px-1 py-0.5 text-xs">
                  curl -fsSL https://dev.meta.ai/install.sh | bash
                </code>
                , then select Refresh.
              </>
            )}
            <div>
              <Button
                size="sm"
                variant="outline"
                disabled={pathDetection.isFetching}
                onClick={() => pathDetection.refetch()}
              >
                {pathDetection.isFetching ? 'Refreshing…' : 'Refresh'}
              </Button>
            </div>
          </div>
        )}
      </SettingsSection>

      <SettingsSection title="Authentication" variant="card">
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span>
              {!installed
                ? 'Select an installed Muse CLI source first.'
                : auth.isLoading
                  ? 'Checking authentication…'
                  : auth.data?.authenticated
                    ? 'Authenticated'
                    : auth.data?.timedOut
                      ? 'Auth check timed out. Try again or run `muse login` manually.'
                      : `Not authenticated${auth.data?.error ? ` · ${auth.data.error}` : ''}`}
            </span>
            {installed && (
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
                      'muse',
                      status.data?.path ?? 'muse',
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
          <p className="text-xs text-muted-foreground">
            Login runs{' '}
            <code className="rounded bg-muted px-1 py-0.5">muse login</code>.
            Setting the{' '}
            <code className="rounded bg-muted px-1 py-0.5">META_API_KEY</code>{' '}
            environment variable also authenticates Muse.
          </p>
        </div>
      </SettingsSection>

      <SettingsSection title="Default model" variant="card">
        <select
          aria-label="Default model"
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={selectedModel}
          onChange={event =>
            patch.mutate({
              selected_muse_model: event.target.value as MuseModel,
            })
          }
        >
          {visibleModelOptions.map(model => (
            <option key={model.id} value={model.id}>
              {model.label}
            </option>
          ))}
        </select>
      </SettingsSection>
    </div>
  )
}
