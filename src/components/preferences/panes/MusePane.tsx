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

  const signIn = () =>
    openCliLoginModal('muse', status.data?.path ?? 'muse', [], 'login')

  return (
    <div className="w-full space-y-8">
      <SettingsSection
        title="CLI"
        anchorId="pref-muse-section-cli"
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
            backendName="Muse CLI"
            managedDescription="Jean installs an isolated Muse CLI. Its launcher keeps itself up to date."
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
                : undefined
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            {source === 'path' ? (
              <Button
                size="sm"
                variant="outline"
                disabled={pathDetection.isFetching}
                onClick={() => pathDetection.refetch()}
              >
                {pathDetection.isFetching ? 'Refreshing…' : 'Refresh'}
              </Button>
            ) : installed ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={managedBusy}
                  onClick={() => update.mutate()}
                >
                  {update.isPending ? 'Updating…' : 'Update'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={managedBusy}
                  onClick={() => uninstall.mutate()}
                >
                  {uninstall.isPending ? 'Removing…' : 'Uninstall'}
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
        </InlineField>
        {source === 'path' && !pathDetection.data?.found && (
          <p className="text-xs text-muted-foreground">
            Install Muse on your PATH with{' '}
            <code>curl -fsSL https://dev.meta.ai/install.sh | bash</code>, then
            select Refresh.
          </p>
        )}
        {installed && !auth.isLoading && !auth.data?.authenticated && (
          <>
            <CliAuthProblem
              timedOut={!!auth.data?.timedOut}
              error={auth.data?.error}
              retrying={auth.isFetching}
              onRetry={() => auth.refetch()}
              manualCommand="muse login"
            />
            <p className="text-xs text-muted-foreground">
              Sign in runs <code>muse login</code>. Setting{' '}
              <code>META_API_KEY</code> also works.
            </p>
          </>
        )}
      </SettingsSection>

      <SettingsSection
        title="Default model"
        anchorId="pref-muse-section-settings"
      >
        <InlineField label="Model">
          <Select
            value={selectedModel}
            onValueChange={value =>
              patch.mutate({ selected_muse_model: value as MuseModel })
            }
          >
            <SelectTrigger
              aria-label="Default model"
              className="w-full sm:w-80"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {visibleModelOptions.map(model => (
                <SelectItem key={model.id} value={model.id}>
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
