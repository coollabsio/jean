import React, { useState, useCallback } from 'react'
import {
  Check,
  ChevronsUpDown,
  FolderOpen,
  GitBranch,
  ImageIcon,
  Loader2,
  RefreshCw,
  RotateCcw,
  X,
} from 'lucide-react'
import { convertFileSrc } from '@/lib/transport'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  useProjects,
  useProjectBranches,
  useUpdateProjectSettings,
  useAppDataDir,
  useSetProjectAvatar,
  useRemoveProjectAvatar,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import { useLinearTeams, linearQueryKeys } from '@/services/linear'
import { useQueryClient } from '@tanstack/react-query'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

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

export function GeneralPane({
  projectId,
}: {
  projectId: string
  projectPath: string
}) {
  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === projectId)

  const {
    data: branches = [],
    isLoading: branchesLoading,
    error: branchesError,
  } = useProjectBranches(projectId)

  const { data: preferences } = usePreferences()
  const profiles = preferences?.custom_cli_profiles ?? []

  const updateSettings = useUpdateProjectSettings()
  const { data: appDataDir = '' } = useAppDataDir()
  const setProjectAvatar = useSetProjectAvatar()
  const removeProjectAvatar = useRemoveProjectAvatar()

  const [localName, setLocalName] = useState<string | null>(null)
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [localSystemPrompt, setLocalSystemPrompt] = useState<string | null>(
    null
  )
  const [localWorktreesDir, setLocalWorktreesDir] = useState<string | null>(
    null
  )
  const [localLinearApiKey, setLocalLinearApiKey] = useState<string | null>(
    null
  )
  const [showLinearApiKey, setShowLinearApiKey] = useState(false)

  // Linear has access if either project key or global key is set
  const hasLinearAccess =
    !!project?.linear_api_key || !!preferences?.linear_api_key

  const queryClient = useQueryClient()
  const { data: linearTeams = [], isLoading: teamsLoading } = useLinearTeams(
    projectId,
    { enabled: hasLinearAccess }
  )

  const handleRefreshTeams = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: linearQueryKeys.teams(projectId),
    })
  }, [projectId, queryClient])

  // Track image load errors
  const [imgErrorKey, setImgErrorKey] = useState<string | null>(null)
  const imgError = imgErrorKey === project?.avatar_path

  const avatarUrl =
    project?.avatar_path && appDataDir && !imgError
      ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
      : null

  const displayedName = localName ?? project?.name ?? ''
  const nameChanged = localName !== null && localName !== (project?.name ?? '')

  const handleSaveName = useCallback(() => {
    if (localName === null) return
    updateSettings.mutate(
      { projectId, name: localName.trim() },
      { onSuccess: () => setLocalName(null) }
    )
  }, [localName, projectId, updateSettings])

  const selectedBranch = project?.default_branch ?? ''
  const displayedSystemPrompt =
    localSystemPrompt ?? project?.custom_system_prompt ?? ''

  const handleSelectBranch = useCallback(
    (branch: string) => {
      setBranchPopoverOpen(false)
      updateSettings.mutate({ projectId, defaultBranch: branch })
    },
    [projectId, updateSettings]
  )

  const handleProviderChange = useCallback(
    (value: string) => {
      updateSettings.mutate({
        projectId,
        defaultProvider: value === 'global-default' ? '__none__' : value,
      })
    },
    [projectId, updateSettings]
  )

  const handleBackendChange = useCallback(
    (value: string) => {
      updateSettings.mutate({
        projectId,
        defaultBackend: value === 'global-default' ? '__none__' : value,
      })
    },
    [projectId, updateSettings]
  )

  const systemPromptChanged =
    localSystemPrompt !== null &&
    localSystemPrompt !== (project?.custom_system_prompt ?? '')

  const handleSaveSystemPrompt = useCallback(() => {
    if (localSystemPrompt === null) return
    updateSettings.mutate(
      { projectId, customSystemPrompt: localSystemPrompt },
      { onSuccess: () => setLocalSystemPrompt(null) }
    )
  }, [localSystemPrompt, projectId, updateSettings])

  const displayedWorktreesDir =
    localWorktreesDir ?? project?.worktrees_dir ?? ''

  const worktreesDirChanged =
    localWorktreesDir !== null &&
    localWorktreesDir !== (project?.worktrees_dir ?? '')

  const handleSaveWorktreesDir = useCallback(() => {
    if (localWorktreesDir === null) return
    updateSettings.mutate(
      {
        projectId,
        worktreesDir: localWorktreesDir.trim(),
      },
      { onSuccess: () => setLocalWorktreesDir(null) }
    )
  }, [localWorktreesDir, projectId, updateSettings])

  const handleResetWorktreesDir = useCallback(() => {
    updateSettings.mutate(
      { projectId, worktreesDir: '' },
      { onSuccess: () => setLocalWorktreesDir(null) }
    )
  }, [projectId, updateSettings])

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
    [projectId, updateSettings, queryClient]
  )

  const handleBrowseWorktreesDir = useCallback(async () => {
    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select worktrees base directory',
    })
    if (selected) {
      setLocalWorktreesDir(selected)
    }
  }, [])

  return (
    <div className="space-y-6">
      <SettingsSection title="Project Name">
        <InlineField
          label="Display Name"
          description="Rename the project without changing the underlying folder"
        >
          <div className="flex items-center gap-2">
            <Input
              value={displayedName}
              onChange={e => setLocalName(e.target.value)}
              className="flex-1 text-sm"
            />
            <Button
              size="sm"
              onClick={handleSaveName}
              disabled={!nameChanged || updateSettings.isPending}
            >
              {updateSettings.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
          </div>
        </InlineField>
      </SettingsSection>

      <SettingsSection title="Avatar">
        <InlineField
          label="Project Avatar"
          description="Custom image displayed in the sidebar"
        >
          <div className="flex items-center gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted-foreground/20 overflow-hidden">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={project?.name ?? 'Project avatar'}
                  className="size-full object-cover"
                  onError={() => setImgErrorKey(project?.avatar_path ?? null)}
                />
              ) : (
                <span className="text-lg font-medium uppercase text-muted-foreground">
                  {project?.name?.[0] ?? '?'}
                </span>
              )}
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setProjectAvatar.mutate(projectId)}
                disabled={setProjectAvatar.isPending}
              >
                {setProjectAvatar.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ImageIcon className="h-4 w-4" />
                )}
                {project?.avatar_path ? 'Change' : 'Add Image'}
              </Button>
              {project?.avatar_path && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeProjectAvatar.mutate(projectId)}
                  disabled={removeProjectAvatar.isPending}
                >
                  {removeProjectAvatar.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  Remove
                </Button>
              )}
            </div>
          </div>
        </InlineField>
      </SettingsSection>

      <SettingsSection title="Defaults">
        <InlineField
          label="Default Branch"
          description="New worktrees will be created from this branch"
        >
          {branchesLoading ? (
            <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Fetching branches...
            </div>
          ) : branchesError ? (
            <div className="py-2 text-sm text-destructive">
              Failed to load branches
            </div>
          ) : branches.length === 0 ? (
            <div className="py-2 text-sm text-muted-foreground">
              No branches found
            </div>
          ) : (
            <Popover
              open={branchPopoverOpen}
              onOpenChange={setBranchPopoverOpen}
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  role="combobox"
                  aria-expanded={branchPopoverOpen}
                  aria-controls="default-branch-selector"
                  className="w-full justify-between"
                >
                  <span className="flex items-center gap-2 truncate">
                    <GitBranch className="h-4 w-4 shrink-0" />
                    {selectedBranch || 'Select a branch'}
                  </span>
                  <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                id="default-branch-selector"
                align="start"
                className="!w-[var(--radix-popover-trigger-width)] p-0"
              >
                <Command>
                  <CommandInput placeholder="Search branches..." />
                  <CommandList>
                    <CommandEmpty>No branch found.</CommandEmpty>
                    <CommandGroup>
                      {branches.map(branch => (
                        <CommandItem
                          key={branch}
                          value={branch}
                          onSelect={handleSelectBranch}
                        >
                          <GitBranch className="h-4 w-4" />
                          {branch}
                          <Check
                            className={cn(
                              'ml-auto h-4 w-4',
                              selectedBranch === branch
                                ? 'opacity-100'
                                : 'opacity-0'
                            )}
                          />
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          )}
        </InlineField>

        {profiles.length > 0 && (
          <InlineField
            label="Default Provider"
            description="Default provider for new sessions in this project"
          >
            <Select
              value={project?.default_provider ?? 'global-default'}
              onValueChange={handleProviderChange}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global-default">
                  Use global default
                </SelectItem>
                <SelectItem value="__anthropic__">Anthropic</SelectItem>
                {profiles.map(p => (
                  <SelectItem key={p.name} value={p.name}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </InlineField>
        )}

        <InlineField
          label="Default Backend"
          description="CLI to use for new sessions in this project"
        >
          <Select
            value={project?.default_backend ?? 'global-default'}
            onValueChange={handleBackendChange}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global-default">Use global default</SelectItem>
              <SelectItem value="claude">Claude</SelectItem>
              <SelectItem value="codex">
                Codex{' '}
                <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                  BETA
                </span>
              </SelectItem>
              <SelectItem value="opencode">
                OpenCode{' '}
                <span className="ml-1 rounded bg-primary/15 px-1 py-px text-[9px] font-semibold uppercase text-primary">
                  BETA
                </span>
              </SelectItem>
            </SelectContent>
          </Select>
        </InlineField>
      </SettingsSection>

      <SettingsSection title="Worktrees Location">
        <InlineField
          label="Base Directory"
          description={
            <>
              Where new worktrees are created. Defaults to{' '}
              <code className="text-[11px] bg-muted px-1 py-0.5 rounded">
                ~/jean
              </code>
            </>
          }
        >
          <div className="flex items-center gap-2">
            <Input
              placeholder="~/jean (default)"
              value={displayedWorktreesDir}
              onChange={e => setLocalWorktreesDir(e.target.value)}
              className="flex-1 text-sm"
            />
            <Button
              variant="outline"
              size="sm"
              onClick={handleBrowseWorktreesDir}
            >
              <FolderOpen className="h-4 w-4" />
              Browse
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={handleSaveWorktreesDir}
              disabled={!worktreesDirChanged || updateSettings.isPending}
            >
              {updateSettings.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
            {project?.worktrees_dir && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleResetWorktreesDir}
                disabled={updateSettings.isPending}
              >
                <RotateCcw className="h-4 w-4" />
                Reset to default
              </Button>
            )}
          </div>
        </InlineField>
      </SettingsSection>

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
              onChange={e => setLocalLinearApiKey(e.target.value)}
              className="flex-1 text-sm font-mono"
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
              {updateSettings.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              Save
            </Button>
            {project?.linear_api_key && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleClearLinearApiKey}
                disabled={updateSettings.isPending}
              >
                <RotateCcw className="h-4 w-4" />
                Remove
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
                disabled={teamsLoading}
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

      <SettingsSection title="System Prompt">
        <InlineField
          label="Custom System Prompt"
          description="Appended to every session's system prompt in this project"
        >
          <Textarea
            placeholder="e.g. Always use TypeScript strict mode. Prefer functional components..."
            value={displayedSystemPrompt}
            onChange={e => setLocalSystemPrompt(e.target.value)}
            rows={4}
            className="resize-y text-sm"
          />
          <Button
            size="sm"
            onClick={handleSaveSystemPrompt}
            disabled={!systemPromptChanged || updateSettings.isPending}
          >
            {updateSettings.isPending && (
              <Loader2 className="h-4 w-4 animate-spin" />
            )}
            Save
          </Button>
        </InlineField>
      </SettingsSection>
    </div>
  )
}
