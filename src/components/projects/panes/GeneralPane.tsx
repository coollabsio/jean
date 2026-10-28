import { SettingsSection } from '@/components/preferences/SettingsSection'
import { InlineField } from '@/components/preferences/InlineField'
import React, { useState, useCallback, useMemo, useRef } from 'react'
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
} from '@/components/icons/reicon'
import { isLocalBackend } from '@/lib/environment'
import {
  convertFileSrc,
  convertProjectFileSrc,
  convertServerFileSrc,
  convertServerProjectFileSrc,
} from '@/lib/transport'
import { DirectoryBrowser } from '@/components/projects/DirectoryBrowser'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  useProjects,
  useProjectBranches,
  useUpdateProjectSettings,
  useAppDataDir,
  useSetProjectAvatar,
  useRemoveProjectAvatar,
} from '@/services/projects'
import { usePreferences } from '@/services/preferences'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { BackendLabel, getBackendLabel } from '@/components/ui/backend-label'
import { useInstalledBackends } from '@/hooks/useInstalledBackends'
import type { CliBackend } from '@/types/preferences'
import { overrideHint } from './override-hint'

const blurOnEnter = (event: React.KeyboardEvent<HTMLInputElement>) => {
  if (event.key === 'Enter') event.currentTarget.blur()
}

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
    isFetching: branchesFetching,
    error: branchesError,
    refetch: refetchBranches,
  } = useProjectBranches(projectId)

  const { data: preferences } = usePreferences()
  const profiles = preferences?.custom_cli_profiles ?? []
  // Show all installed backends (auth is checked at send time / backend settings).
  const { installedBackends } = useInstalledBackends()
  const installedBackendsSet = useMemo(
    () => new Set(installedBackends),
    [installedBackends]
  )

  const updateSettings = useUpdateProjectSettings()
  const { data: appDataDir = '' } = useAppDataDir()
  const setProjectAvatar = useSetProjectAvatar()
  const removeProjectAvatar = useRemoveProjectAvatar()

  const avatarInputRef = useRef<HTMLInputElement>(null)
  const [localName, setLocalName] = useState<string | null>(null)
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)
  const [localSystemPrompt, setLocalSystemPrompt] = useState<string | null>(
    null
  )
  const [localWorktreesDir, setLocalWorktreesDir] = useState<string | null>(
    null
  )
  const [worktreesBrowserOpen, setWorktreesBrowserOpen] = useState(false)
  // Track image load errors
  const avatarKey = project?.avatar_path ?? project?.default_avatar_path ?? null
  const [imgErrorKey, setImgErrorKey] = useState<string | null>(null)
  const imgError = imgErrorKey === avatarKey

  const avatarUrl =
    project?.avatar_path && !imgError
      ? project.serverId
        ? convertServerFileSrc(project.serverId, project.avatar_path)
        : appDataDir
          ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
          : null
      : project?.default_avatar_path && !imgError
        ? project.serverId
          ? convertServerProjectFileSrc(
              project.serverId,
              project.default_avatar_path
            )
          : convertProjectFileSrc(project.default_avatar_path)
        : null

  const displayedName = localName ?? project?.name ?? ''

  const savedName = project?.name ?? ''
  const handleCommitName = useCallback(() => {
    if (localName === null) return
    const name = localName.trim()
    if (!name || name === savedName) {
      setLocalName(null)
      return
    }
    updateSettings.mutate(
      { projectId, name },
      { onSuccess: () => setLocalName(null) }
    )
  }, [localName, projectId, savedName, updateSettings])

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

  const savedSystemPrompt = project?.custom_system_prompt ?? ''
  const handleCommitSystemPrompt = useCallback(() => {
    if (localSystemPrompt === null) return
    if (localSystemPrompt === savedSystemPrompt) {
      setLocalSystemPrompt(null)
      return
    }
    updateSettings.mutate(
      { projectId, customSystemPrompt: localSystemPrompt },
      { onSuccess: () => setLocalSystemPrompt(null) }
    )
  }, [localSystemPrompt, projectId, savedSystemPrompt, updateSettings])

  const displayedWorktreesDir =
    localWorktreesDir ?? project?.worktrees_dir ?? ''

  const savedWorktreesDir = project?.worktrees_dir ?? ''
  const saveWorktreesDir = useCallback(
    (value: string) => {
      const worktreesDir = value.trim()
      if (worktreesDir === savedWorktreesDir) {
        setLocalWorktreesDir(null)
        return
      }
      updateSettings.mutate(
        { projectId, worktreesDir },
        { onSuccess: () => setLocalWorktreesDir(null) }
      )
    },
    [projectId, savedWorktreesDir, updateSettings]
  )

  const handleResetWorktreesDir = useCallback(() => {
    updateSettings.mutate(
      { projectId, worktreesDir: '' },
      { onSuccess: () => setLocalWorktreesDir(null) }
    )
  }, [projectId, updateSettings])

  const handleBrowseWorktreesDir = useCallback(async () => {
    // Remote backends must browse the server filesystem — the native OS
    // picker only sees the local machine.
    if (!isLocalBackend()) {
      setWorktreesBrowserOpen(true)
      return
    }

    const { open } = await import('@tauri-apps/plugin-dialog')
    const selected = await open({
      directory: true,
      multiple: false,
      title: 'Select worktrees base directory',
    })
    if (selected) saveWorktreesDir(selected)
  }, [saveWorktreesDir])

  const globalBackend = preferences?.default_backend
  const backendHint = overrideHint(
    !!project?.default_backend,
    globalBackend ? getBackendLabel(globalBackend) : null
  )
  const providerHint = overrideHint(
    !!project?.default_provider,
    preferences ? (preferences.default_provider ?? 'Anthropic') : null
  )

  return (
    <>
      <div className="space-y-8">
        <SettingsSection title="Project">
          <InlineField
            label="Name"
            description="Renames the project, not the folder"
            htmlFor="project-name"
          >
            <Input
              id="project-name"
              value={displayedName}
              onChange={e => setLocalName(e.target.value)}
              onBlur={handleCommitName}
              onKeyDown={blurOnEnter}
              className="min-w-0 flex-1 text-base md:text-sm"
            />
          </InlineField>

          <InlineField label="Avatar" description="Shown in the sidebar">
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted-foreground/20">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={project?.name ?? 'Project avatar'}
                    className="size-full object-cover"
                    onError={() => setImgErrorKey(avatarKey)}
                  />
                ) : (
                  <span className="text-base font-medium uppercase text-muted-foreground">
                    {project?.name?.[0] ?? '?'}
                  </span>
                )}
              </div>
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (file) setProjectAvatar.mutate({ projectId, file })
                }}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => avatarInputRef.current?.click()}
                disabled={setProjectAvatar.isPending}
              >
                {setProjectAvatar.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ImageIcon className="h-4 w-4" />
                )}
                {project?.avatar_path || project?.default_avatar_path
                  ? 'Change'
                  : 'Add Image'}
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
          </InlineField>

          <InlineField
            label="Default Branch"
            description="New worktrees start from this branch"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <div className="min-w-0 flex-1">
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
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    aria-label="Refresh branches"
                    disabled={branchesFetching}
                    onClick={() => refetchBranches()}
                  >
                    <RefreshCw
                      className={cn(
                        'h-4 w-4',
                        branchesFetching && 'animate-spin'
                      )}
                    />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Fetch branches from remote</TooltipContent>
              </Tooltip>
            </div>
          </InlineField>

          <InlineField
            label="Worktrees Location"
            description="Where new worktrees are created"
            htmlFor="project-worktrees-dir"
          >
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <Input
                id="project-worktrees-dir"
                placeholder="~/jean (default)"
                value={displayedWorktreesDir}
                onChange={e => setLocalWorktreesDir(e.target.value)}
                onBlur={() => {
                  if (localWorktreesDir !== null)
                    saveWorktreesDir(localWorktreesDir)
                }}
                onKeyDown={blurOnEnter}
                className="min-w-0 flex-1 text-base md:text-sm"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleBrowseWorktreesDir}
              >
                <FolderOpen className="h-4 w-4" />
                Browse
              </Button>
              {project?.worktrees_dir && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Reset to default"
                      onClick={handleResetWorktreesDir}
                      disabled={updateSettings.isPending}
                    >
                      <RotateCcw className="h-4 w-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>Reset to ~/jean</TooltipContent>
                </Tooltip>
              )}
            </div>
          </InlineField>
        </SettingsSection>

        <SettingsSection title="Sessions">
          <InlineField
            label="Default Backend"
            description={backendHint}
            htmlFor="project-default-backend"
          >
            <Select
              value={project?.default_backend ?? 'global-default'}
              onValueChange={handleBackendChange}
            >
              <SelectTrigger
                id="project-default-backend"
                className="w-full min-w-0 flex-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global-default">
                  Use global default
                </SelectItem>
                {(
                  [
                    'claude',
                    'codex',
                    'opencode',
                    'cursor',
                    'pi',
                    'commandcode',
                    'grok',
                    'kimi',
                    'devin',
                    'antigravity',
                    'muse',
                  ] as CliBackend[]
                )
                  .filter(backend => installedBackendsSet.has(backend))
                  .map(backend => (
                    <SelectItem key={backend} value={backend}>
                      <BackendLabel backend={backend} />
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </InlineField>

          {profiles.length > 0 && (
            <InlineField
              label="Default Provider"
              description={providerHint}
              htmlFor="project-default-provider"
            >
              <Select
                value={project?.default_provider ?? 'global-default'}
                onValueChange={handleProviderChange}
              >
                <SelectTrigger
                  id="project-default-provider"
                  className="w-full min-w-0 flex-1"
                >
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
            label="System Prompt"
            description="Added to every session in this project, after the global prompt"
            htmlFor="project-system-prompt"
            layout="stacked"
          >
            <Textarea
              id="project-system-prompt"
              placeholder="e.g. Always use TypeScript strict mode. Prefer functional components..."
              value={displayedSystemPrompt}
              onChange={e => setLocalSystemPrompt(e.target.value)}
              onBlur={handleCommitSystemPrompt}
              rows={4}
              className="resize-y text-base md:text-sm"
            />
          </InlineField>
        </SettingsSection>
      </div>

      <DirectoryBrowser
        open={worktreesBrowserOpen}
        onOpenChange={setWorktreesBrowserOpen}
        onSelect={saveWorktreesDir}
        mode="select"
        title="Select worktrees base directory"
        description="Choose the parent directory where new worktrees will be created."
      />
    </>
  )
}
