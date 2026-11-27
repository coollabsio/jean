import { RefreshCw } from '@/components/icons/reicon'
import { useQueryClient } from '@tanstack/react-query'
import { SettingsSection } from '@/components/preferences/SettingsSection'
import { InlineField } from '@/components/preferences/InlineField'
import { PlaneSettingsForm } from '@/components/shared/PlaneSettingsForm'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { usePreferences } from '@/services/preferences'
import { useProjects } from '@/services/projects'
import {
  planeQueryKeys,
  usePlaneProjects,
  useUpdateProjectPlaneSettings,
} from '@/services/plane'
import type { PlaneProjectSettings } from '@/types/projects'
import { overrideHint } from './override-hint'

const ALL_PROJECTS = 'all'

/** Per-project Plane overrides and Plane project filter. */
export function PlaneProjectSection({ projectId }: { projectId: string }) {
  const { data: projects = [] } = useProjects()
  const project = projects.find(candidate => candidate.id === projectId)
  const { data: preferences } = usePreferences()
  const updatePlane = useUpdateProjectPlaneSettings()
  const queryClient = useQueryClient()

  const settings: PlaneProjectSettings = project?.plane ?? {}
  const hasAccess =
    !!(settings.api_key || preferences?.plane_api_key) &&
    !!(settings.workspace_slug || preferences?.plane_workspace_slug)
  const {
    data: planeProjects = [],
    isFetching: projectsLoading,
    error: projectsError,
  } = usePlaneProjects(projectId, { enabled: hasAccess })

  const save = (patch: Partial<PlaneProjectSettings>) =>
    updatePlane.mutateAsync({
      projectId,
      settings: { ...settings, ...patch },
    })

  return (
    <SettingsSection title="Plane Integration">
      <PlaneSettingsForm
        saved={{
          apiKey: settings.api_key ?? '',
          workspaceSlug: settings.workspace_slug ?? '',
          baseUrl: settings.base_url ?? '',
        }}
        hints={{
          apiKey: overrideHint(
            !!settings.api_key,
            preferences?.plane_api_key ? 'key set' : 'none'
          ),
          workspaceSlug: overrideHint(
            !!settings.workspace_slug,
            preferences?.plane_workspace_slug
          ),
          baseUrl: overrideHint(
            !!settings.base_url,
            preferences?.plane_base_url || 'Plane Cloud'
          ),
        }}
        isSaving={updatePlane.isPending}
        onSave={changes =>
          save({
            ...(changes.apiKey !== undefined && {
              api_key: changes.apiKey || null,
            }),
            ...(changes.workspaceSlug !== undefined && {
              workspace_slug: changes.workspaceSlug || null,
            }),
            ...(changes.baseUrl !== undefined && {
              base_url: changes.baseUrl || null,
            }),
          })
        }
      />

      {hasAccess && (
        <InlineField
          label="Project Filter"
          description={
            projectsError
              ? `Could not load Plane projects: ${projectsError instanceof Error ? projectsError.message : String(projectsError)}`
              : 'Only show work items from this Plane project'
          }
        >
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <Select
              value={settings.project_id ?? ALL_PROJECTS}
              onValueChange={value =>
                void save({
                  project_id: value === ALL_PROJECTS ? null : value,
                })
              }
              disabled={projectsLoading || updatePlane.isPending}
            >
              <SelectTrigger className="flex-1">
                <SelectValue placeholder="All projects" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROJECTS}>
                  All projects (first 10)
                </SelectItem>
                {planeProjects.map(planeProject => (
                  <SelectItem key={planeProject.id} value={planeProject.id}>
                    {planeProject.identifier} — {planeProject.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant="outline"
              size="icon"
              onClick={() =>
                queryClient.invalidateQueries({
                  queryKey: planeQueryKeys.projects(projectId),
                })
              }
              disabled={projectsLoading}
              aria-label="Refresh Plane projects"
            >
              <RefreshCw
                className={cn('h-4 w-4', projectsLoading && 'animate-spin')}
              />
            </Button>
          </div>
        </InlineField>
      )}
    </SettingsSection>
  )
}
