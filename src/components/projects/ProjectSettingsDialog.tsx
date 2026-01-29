import { useCallback, useState } from 'react'
import {
  Check,
  ChevronsUpDown,
  FolderOpen,
  GitBranch,
  ImageIcon,
  Loader2,
  Trash2,
  X,
} from 'lucide-react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useProjectsStore } from '@/store/projects-store'
import {
  useAppDataDir,
  useProjectAdditionalDirs,
  useProjectBranches,
  useProjects,
  useRemoveProjectAvatar,
  useSetProjectAdditionalDirs,
  useSetProjectAvatar,
  useUpdateProjectSettings,
} from '@/services/projects'

export function ProjectSettingsDialog() {
  const {
    projectSettingsDialogOpen,
    projectSettingsProjectId,
    closeProjectSettings,
  } = useProjectsStore()

  const { data: projects = [] } = useProjects()
  const project = projects.find(p => p.id === projectSettingsProjectId)

  const {
    data: branches = [],
    isLoading: branchesLoading,
    error: branchesError,
  } = useProjectBranches(projectSettingsProjectId)

  // Read additionalDirectories from .claude/settings.local.json
  const { data: savedAdditionalDirs = [] } = useProjectAdditionalDirs(
    projectSettingsDialogOpen ? projectSettingsProjectId : null
  )

  const updateSettings = useUpdateProjectSettings()
  const setAdditionalDirs = useSetProjectAdditionalDirs()
  const { data: appDataDir = '' } = useAppDataDir()
  const setProjectAvatar = useSetProjectAvatar()
  const removeProjectAvatar = useRemoveProjectAvatar()

  // Use project's default_branch as the initial value, allow local overrides
  const [localBranch, setLocalBranch] = useState<string | null>(null)
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)

  // External directories state (null = no local changes, array = local override)
  const [localExternalDirs, setLocalExternalDirs] = useState<string[] | null>(
    null
  )

  // Track image load errors - use avatar_path as key to reset error state when it changes
  const [imgErrorKey, setImgErrorKey] = useState<string | null>(null)
  const imgError = imgErrorKey === project?.avatar_path

  // Build the full avatar URL if project has an avatar
  const avatarUrl =
    project?.avatar_path && appDataDir && !imgError
      ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
      : null

  const handleChangeAvatar = () => {
    if (!projectSettingsProjectId) return
    setProjectAvatar.mutate(projectSettingsProjectId)
  }

  const handleRemoveAvatar = () => {
    if (!projectSettingsProjectId) return
    removeProjectAvatar.mutate(projectSettingsProjectId)
  }

  // If user hasn't made a selection, use project's default
  const selectedBranch = localBranch ?? project?.default_branch ?? ''

  const setSelectedBranch = (branch: string) => {
    setLocalBranch(branch)
  }

  // External dirs: use local state if changed, otherwise the value from settings.local.json
  const currentExternalDirs = localExternalDirs ?? savedAdditionalDirs

  const handleAddExternalDir = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false })
    if (!selected) return

    setLocalExternalDirs(prev => {
      const current = prev ?? savedAdditionalDirs
      // Prevent duplicates
      if (current.includes(selected)) return current
      return [...current, selected]
    })
  }, [savedAdditionalDirs])

  const handleRemoveExternalDir = useCallback(
    (dir: string) => {
      setLocalExternalDirs(prev => {
        const current = prev ?? savedAdditionalDirs
        return current.filter(d => d !== dir)
      })
    },
    [savedAdditionalDirs]
  )

  const handleSave = async () => {
    if (!projectSettingsProjectId) return

    // Save branch settings if changed
    const branchChanged =
      selectedBranch && selectedBranch !== project?.default_branch
    if (branchChanged) {
      await updateSettings.mutateAsync({
        projectId: projectSettingsProjectId,
        defaultBranch: selectedBranch,
      })
    }

    // Save additional dirs if changed
    if (localExternalDirs !== null) {
      await setAdditionalDirs.mutateAsync({
        projectId: projectSettingsProjectId,
        dirs: localExternalDirs,
      })
    }

    closeProjectSettings()
  }

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setLocalBranch(null) // Reset local state when closing
      setLocalExternalDirs(null)
      closeProjectSettings()
    }
  }

  const branchChanged = project && selectedBranch !== project.default_branch
  const externalDirsChanged = localExternalDirs !== null
  const hasChanges = branchChanged || externalDirsChanged
  const isPending = updateSettings.isPending || setAdditionalDirs.isPending

  return (
    <Dialog open={projectSettingsDialogOpen} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Project Settings</DialogTitle>
          <DialogDescription>
            {project?.name ?? 'Configure project settings'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-4">
          {/* Avatar Section */}
          <div className="space-y-2">
            <label className="text-sm font-medium leading-none">
              Project Avatar
            </label>
            <p className="text-xs text-muted-foreground">
              Custom image displayed in the sidebar
            </p>
            <div className="flex items-center gap-3">
              {/* Avatar Preview */}
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
              {/* Avatar Actions */}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleChangeAvatar}
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
                    onClick={handleRemoveAvatar}
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
          </div>

          {/* Base Branch Section */}
          <div className="space-y-2">
            <label
              htmlFor="base-branch"
              className="text-sm font-medium leading-none"
            >
              Base Branch
            </label>
            <p className="text-xs text-muted-foreground">
              New worktrees will be created from this branch
            </p>

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
                            onSelect={value => {
                              setSelectedBranch(value)
                              setBranchPopoverOpen(false)
                            }}
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

          {/* External Directories Section */}
          <div className="space-y-2">
            <label className="text-sm font-medium leading-none">
              External Directories
            </label>
            <p className="text-xs text-muted-foreground">
              Additional directories Claude can read (outside the worktree)
            </p>

            {currentExternalDirs.length > 0 && (
              <ScrollArea className="max-h-32">
                <div className="space-y-1">
                  {currentExternalDirs.map(dir => (
                    <div
                      key={dir}
                      className="flex items-center gap-2 rounded-md border px-2 py-1.5 text-sm"
                    >
                      <FolderOpen className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate" title={dir}>
                        {dir}
                      </span>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 shrink-0"
                        onClick={() => handleRemoveExternalDir(dir)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}

            <Button variant="outline" size="sm" onClick={handleAddExternalDir}>
              <FolderOpen className="h-4 w-4" />
              Add Directory
            </Button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeProjectSettings}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={!hasChanges || isPending || branchesLoading}
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
