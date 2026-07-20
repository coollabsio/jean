import React, { useCallback, useEffect, useState } from 'react'
import { Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useLinearTeams, linearQueryKeys } from '@/services/linear'
import { usePreferences } from '@/services/preferences'
import { useProjects, useUpdateProjectSettings } from '@/services/projects'
import {
  sentryQueryKeys,
  testSentryAuthToken,
  useSentryProjects,
} from '@/services/sentry'

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

const InlineField: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="space-y-2">
    <Label className="text-sm text-foreground">{label}</Label>
    {description && (
      <div className="text-xs text-muted-foreground">{description}</div>
    )}
    {children}
  </div>
)

export function IntegrationsPane({ projectId }: { projectId: string }) {
  const { data: projects = [] } = useProjects()
  const project = projects.find(candidate => candidate.id === projectId)
  const { data: preferences } = usePreferences()
  const updateSettings = useUpdateProjectSettings()
  const queryClient = useQueryClient()

  const [localLinearApiKey, setLocalLinearApiKey] = useState<string | null>(
    null
  )
  const [showLinearApiKey, setShowLinearApiKey] = useState(false)
  const [localSentryAuthToken, setLocalSentryAuthToken] = useState<
    string | null
  >(null)
  const [showSentryAuthToken, setShowSentryAuthToken] = useState(false)
  const [isTestingSentry, setIsTestingSentry] = useState(false)

  const hasLinearAccess =
    !!project?.linear_api_key || !!preferences?.linear_api_key
  const hasSentryAccess =
    !!project?.sentry_auth_token || !!preferences?.sentry_auth_token
  const { data: linearTeams = [], isLoading: teamsLoading } = useLinearTeams(
    projectId,
    { enabled: hasLinearAccess }
  )
  const {
    data: sentryProjects = [],
    isLoading: sentryProjectsLoading,
    error: sentryProjectsError,
  } = useSentryProjects(projectId, { enabled: hasSentryAccess })

  const displayedLinearApiKey =
    localLinearApiKey ?? project?.linear_api_key ?? ''
  const linearApiKeyChanged =
    localLinearApiKey !== null &&
    localLinearApiKey !== (project?.linear_api_key ?? '')

  const handleSaveLinearApiKey = useCallback(() => {
    if (localLinearApiKey === null) return
    updateSettings.mutate(
      { projectId, linearApiKey: localLinearApiKey.trim() },
      { onSuccess: () => setLocalLinearApiKey(null) }
    )
  }, [localLinearApiKey, projectId, updateSettings])

  const handleClearLinearApiKey = useCallback(() => {
    updateSettings.mutate(
      { projectId, linearApiKey: '' },
      { onSuccess: () => setLocalLinearApiKey(null) }
    )
  }, [projectId, updateSettings])

  const handleTeamChange = useCallback(
    (value: string) => {
      updateSettings.mutate(
        { projectId, linearTeamId: value === 'all' ? '' : value },
        {
          onSuccess: () => {
            queryClient.invalidateQueries({
              queryKey: linearQueryKeys.issues(projectId),
            })
            queryClient.invalidateQueries({
              queryKey: ['linear', 'issue-search', projectId],
            })
          },
        }
      )
    },
    [projectId, queryClient, updateSettings]
  )

  const handleRefreshTeams = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: linearQueryKeys.teams(projectId),
    })
  }, [projectId, queryClient])

  const displayedSentryAuthToken =
    localSentryAuthToken ?? project?.sentry_auth_token ?? ''
  const sentryAuthTokenChanged =
    localSentryAuthToken !== null &&
    localSentryAuthToken !== (project?.sentry_auth_token ?? '')
  const selectedSentryProjectId =
    sentryProjects.find(
      sentryProject =>
        sentryProject.organization.slug ===
          project?.sentry_organization_slug &&
        sentryProject.slug === project?.sentry_project_slug
    )?.id ?? ''

  const handleSaveSentryAuthToken = useCallback(async () => {
    if (localSentryAuthToken === null) return
    const authToken = localSentryAuthToken.trim()
    if (!authToken) return

    setIsTestingSentry(true)
    try {
      const accessibleProjects = await testSentryAuthToken(authToken)
      const onlyProject =
        !project?.sentry_organization_slug &&
        !project?.sentry_project_slug &&
        accessibleProjects.length === 1
          ? accessibleProjects[0]
          : null
      updateSettings.mutate(
        {
          projectId,
          sentryAuthToken: authToken,
          ...(onlyProject && {
            sentryOrganizationSlug: onlyProject.organization.slug,
            sentryProjectSlug: onlyProject.slug,
          }),
        },
        {
          onSuccess: () => {
            setLocalSentryAuthToken(null)
            queryClient.invalidateQueries({ queryKey: sentryQueryKeys.all })
            toast.success(
              onlyProject
                ? `Sentry connected to ${onlyProject.organization.slug}/${onlyProject.slug}`
                : `Sentry token verified — ${accessibleProjects.length} projects available`
            )
          },
        }
      )
    } catch (error) {
      toast.error('Sentry token test failed', {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setIsTestingSentry(false)
    }
  }, [
    localSentryAuthToken,
    project?.sentry_organization_slug,
    project?.sentry_project_slug,
    projectId,
    queryClient,
    updateSettings,
  ])

  const handleClearSentryAuthToken = useCallback(() => {
    updateSettings.mutate(
      { projectId, sentryAuthToken: '' },
      {
        onSuccess: () => {
          setLocalSentryAuthToken(null)
          queryClient.invalidateQueries({ queryKey: sentryQueryKeys.all })
        },
      }
    )
  }, [projectId, queryClient, updateSettings])

  const handleSentryProjectChange = useCallback(
    (sentryProjectId: string) => {
      const sentryProject = sentryProjects.find(
        candidate => candidate.id === sentryProjectId
      )
      if (!sentryProject) return
      updateSettings.mutate(
        {
          projectId,
          sentryOrganizationSlug: sentryProject.organization.slug,
          sentryProjectSlug: sentryProject.slug,
        },
        {
          onSuccess: () =>
            queryClient.invalidateQueries({ queryKey: sentryQueryKeys.all }),
        }
      )
    },
    [projectId, queryClient, sentryProjects, updateSettings]
  )

  useEffect(() => {
    const onlyProject = sentryProjects[0]
    if (
      sentryProjects.length === 1 &&
      onlyProject &&
      !project?.sentry_organization_slug &&
      !project?.sentry_project_slug &&
      !updateSettings.isPending
    ) {
      handleSentryProjectChange(onlyProject.id)
    }
  }, [
    handleSentryProjectChange,
    project?.sentry_organization_slug,
    project?.sentry_project_slug,
    sentryProjects,
    updateSettings.isPending,
  ])

  return (
    <div className="space-y-6">
      <SettingsSection title="Linear Integration">
        <InlineField
          label="Project API Key Override"
          description="Overrides the global key from Settings → Integrations for this project only. Leave empty to use the global key."
        >
          <div className="flex items-center gap-2">
            <Input
              type={showLinearApiKey ? 'text' : 'password'}
              placeholder="lin_api_..."
              value={displayedLinearApiKey}
              onChange={event => setLocalLinearApiKey(event.target.value)}
              className="flex-1 text-base md:text-sm font-mono"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowLinearApiKey(!showLinearApiKey)}
            >
              {showLinearApiKey ? 'Hide' : 'Show'}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveLinearApiKey}
              disabled={!linearApiKeyChanged || updateSettings.isPending}
            >
              Save
            </Button>
            {project?.linear_api_key && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearLinearApiKey}
                disabled={updateSettings.isPending}
              >
                <RotateCcw className="h-4 w-4" /> Remove
              </Button>
            )}
          </div>
        </InlineField>

        {hasLinearAccess && (
          <InlineField
            label="Team Filter"
            description="Restrict Linear issues to a specific team. Leave as 'All teams' to see everything."
          >
            <div className="flex items-center gap-2">
              <Select
                value={project?.linear_team_id ?? 'all'}
                onValueChange={handleTeamChange}
                disabled={teamsLoading || updateSettings.isPending}
              >
                <SelectTrigger className="flex-1">
                  <SelectValue
                    placeholder={
                      teamsLoading ? 'Loading teams...' : 'All teams'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All teams</SelectItem>
                  {linearTeams.map(team => (
                    <SelectItem key={team.id} value={team.id}>
                      {team.key} — {team.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="outline"
                size="sm"
                onClick={handleRefreshTeams}
                disabled={teamsLoading}
              >
                <RefreshCw
                  className={cn('h-4 w-4', teamsLoading && 'animate-spin')}
                />
              </Button>
            </div>
          </InlineField>
        )}
      </SettingsSection>

      <SettingsSection title="Sentry Integration">
        <InlineField
          label="Project Auth Token Override"
          description="Overrides the global token from Settings → Integrations for this project only. Leave empty to use the global token."
        >
          <div className="flex items-center gap-2">
            <Input
              type={showSentryAuthToken ? 'text' : 'password'}
              placeholder="sntrys_..."
              value={displayedSentryAuthToken}
              onChange={event => setLocalSentryAuthToken(event.target.value)}
              className="flex-1 text-base md:text-sm font-mono"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowSentryAuthToken(!showSentryAuthToken)}
            >
              {showSentryAuthToken ? 'Hide' : 'Show'}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveSentryAuthToken}
              disabled={
                !sentryAuthTokenChanged ||
                updateSettings.isPending ||
                isTestingSentry
              }
            >
              {isTestingSentry && <Loader2 className="h-4 w-4 animate-spin" />}
              Save & Test
            </Button>
            {project?.sentry_auth_token && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearSentryAuthToken}
                disabled={updateSettings.isPending}
              >
                <RotateCcw className="h-4 w-4" /> Remove
              </Button>
            )}
          </div>
        </InlineField>

        <InlineField
          label="Sentry Project"
          description="Choose which accessible Sentry project belongs to this Jean project. The token itself is account-scoped, not project-scoped."
        >
          {hasSentryAccess ? (
            <>
              <div className="flex items-center gap-2">
                <Select
                  value={selectedSentryProjectId}
                  onValueChange={handleSentryProjectChange}
                  disabled={
                    sentryProjectsLoading ||
                    updateSettings.isPending ||
                    sentryProjects.length === 0
                  }
                >
                  <SelectTrigger className="flex-1">
                    <SelectValue
                      placeholder={
                        sentryProjectsLoading
                          ? 'Loading Sentry projects...'
                          : 'Select a Sentry project'
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {sentryProjects.map(sentryProject => (
                      <SelectItem
                        key={sentryProject.id}
                        value={sentryProject.id}
                      >
                        {sentryProject.organization.slug}/{sentryProject.slug}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    queryClient.invalidateQueries({
                      queryKey: sentryQueryKeys.projects(projectId),
                    })
                  }
                  disabled={sentryProjectsLoading}
                  aria-label="Refresh Sentry projects"
                >
                  <RefreshCw
                    className={cn(
                      'h-4 w-4',
                      sentryProjectsLoading && 'animate-spin'
                    )}
                  />
                </Button>
              </div>
              {sentryProjectsError && (
                <p className="text-xs text-destructive">
                  {sentryProjectsError instanceof Error
                    ? sentryProjectsError.message
                    : String(sentryProjectsError)}
                </p>
              )}
              {!sentryProjectsLoading &&
                !sentryProjectsError &&
                sentryProjects.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No accessible projects found. Check that the token has the{' '}
                    <code>org:read</code> scope.
                  </p>
                )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              Add a global Sentry token in Settings → Integrations, or add an
              override above.
            </p>
          )}
        </InlineField>
      </SettingsSection>
    </div>
  )
}
