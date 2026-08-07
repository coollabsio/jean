import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronsUpDown,
  GitBranch,
  GitFork,
  Loader2,
  Plus,
  Settings,
  Star,
} from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import { usePatchPreferences, usePreferences } from '@/services/preferences'
import {
  normalizeRunScripts,
  useProjectRemotes,
  type JeanConfig,
  type ProjectRemote,
} from '@/services/projects'

export interface QuickActionsTabProps {
  hasBaseSession: boolean
  onCreateWorktree: (customName?: string, baseBranch?: string) => void
  onBaseSession: () => void
  isCreating: boolean
  projectId: string | null
  jeanConfig: JeanConfig | null | undefined
  /**
   * Fallback remotes (usually for the default branch). When `projectPath` is
   * set, remotes are re-queried for the *selected* base branch so multi-remote
   * cards only offer remotes that actually have that branch.
   */
  remotes?: ProjectRemote[]
  /** Absolute path of the project repo (for remotes-with-branch lookup). */
  projectPath?: string | null
  /** Project default branch, used as the base branch on every remote. */
  defaultBranch?: string
  /** Remote (or local fallback) branches available as base for new worktrees. */
  branches?: string[]
  /** True while remote branches are being fetched. */
  isLoadingBranches?: boolean
}

const INVALID_BRANCH_CHAR = /[\s:?*~^[\\]/
/** Stable default so omit/undefined doesn't allocate a new [] each render. */
const EMPTY_BRANCHES: string[] = []

function isInvalidBranchName(trimmed: string): boolean {
  if (trimmed.length === 0) return false
  return (
    INVALID_BRANCH_CHAR.test(trimmed) ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.startsWith('.') ||
    trimmed.endsWith('.') ||
    trimmed.includes('..') ||
    trimmed.endsWith('.lock')
  )
}

export function QuickActionsTab({
  hasBaseSession,
  onCreateWorktree,
  onBaseSession,
  isCreating,
  projectId,
  jeanConfig,
  remotes,
  projectPath,
  defaultBranch,
  branches = EMPTY_BRANCHES,
  isLoadingBranches = false,
}: QuickActionsTabProps) {
  const [customBranchName, setCustomBranchName] = useState('')
  const [selectedBaseBranch, setSelectedBaseBranch] = useState(
    defaultBranch ?? ''
  )
  const [baseBranchOpen, setBaseBranchOpen] = useState(false)
  const setupScript = jeanConfig?.scripts.setup
  const runScripts = normalizeRunScripts(jeanConfig?.scripts.run)

  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const favoriteKeys = preferences?.favorite_base_branches ?? []
  const favoritePrefix = projectId ? `${projectId}:` : null
  const starredBranches = useMemo(
    () =>
      new Set(
        favoritePrefix
          ? favoriteKeys.flatMap(key =>
              key.startsWith(favoritePrefix)
                ? [key.slice(favoritePrefix.length)]
                : []
            )
          : []
      ),
    [favoriteKeys, favoritePrefix]
  )

  const trimmedBranchName = customBranchName.trim()
  const isInvalid = isInvalidBranchName(trimmedBranchName)

  // Keep selection in sync when the project default arrives/changes, and when
  // the fetched branch list no longer includes the current selection.
  useEffect(() => {
    setSelectedBaseBranch(prev => {
      if (defaultBranch && (!prev || prev === defaultBranch)) {
        return defaultBranch
      }
      if (prev && branches.length > 0 && !branches.includes(prev)) {
        return defaultBranch && branches.includes(defaultBranch)
          ? defaultBranch
          : (branches[0] ?? prev)
      }
      if (!prev && defaultBranch) return defaultBranch
      if (!prev && branches.length > 0) return branches[0] ?? ''
      return prev
    })
  }, [defaultBranch, branches])

  const effectiveBaseBranch =
    selectedBaseBranch || defaultBranch || undefined

  // Remotes that actually have the *selected* base branch fetched. Parent may
  // pass default-branch remotes as a fallback while this query loads.
  const { data: remotesForSelectedBase } = useProjectRemotes(
    projectPath,
    effectiveBaseBranch
  )
  const activeRemotes =
    remotesForSelectedBase && remotesForSelectedBase.length > 0
      ? remotesForSelectedBase
      : (remotes ?? [])

  // With several remotes (e.g. upstream + fork) the single "New Worktree"
  // action is ambiguous, so offer one explicit start point per remote instead.
  const remoteOptions =
    effectiveBaseBranch && activeRemotes.length > 1 ? activeRemotes : []
  const hasRemoteOptions = remoteOptions.length > 0
  const remoteNameSet = useMemo(
    () => new Set(remoteOptions.map(r => r.name)),
    [remoteOptions]
  )

  // Options for the combobox: ensure default is present even if fetch lags.
  // Multi-remote cards prefix the remote themselves, so only short names go
  // in the picker there (skip "fork/feature" style entries).
  // Starred branches sort to the top, then alphabetical.
  const branchOptions = useMemo(() => {
    const set = new Set(branches)
    if (defaultBranch) set.add(defaultBranch)
    if (selectedBaseBranch) set.add(selectedBaseBranch)
    let options = Array.from(set)
    if (hasRemoteOptions) {
      options = options.filter(b => {
        const slash = b.indexOf('/')
        if (slash === -1) return true
        return !remoteNameSet.has(b.slice(0, slash))
      })
    }
    return options.sort((a, b) => {
      const aStar = starredBranches.has(a) ? 0 : 1
      const bStar = starredBranches.has(b) ? 0 : 1
      if (aStar !== bStar) return aStar - bStar
      return a.localeCompare(b)
    })
  }, [
    branches,
    defaultBranch,
    selectedBaseBranch,
    hasRemoteOptions,
    remoteNameSet,
    starredBranches,
  ])

  const toggleStarredBranch = (branch: string) => {
    if (!projectId) return
    const key = `${projectId}:${branch}`
    patchPreferences.mutate({
      favorite_base_branches: favoriteKeys.includes(key)
        ? favoriteKeys.filter(favorite => favorite !== key)
        : [...favoriteKeys, key],
    })
  }

  const handleRunClick = () => {
    if (!projectId) return
    if (runScripts.length === 0) {
      useUIStore.getState().setNewWorktreeModalOpen(false)
      useProjectsStore.getState().openProjectSettings(projectId, 'jean-json')
    }
  }

  const handleCreateClick = (baseBranch?: string) => {
    if (isInvalid) return
    onCreateWorktree(
      trimmedBranchName || undefined,
      baseBranch ?? effectiveBaseBranch
    )
    setCustomBranchName('')
  }

  // Enter in the branch name field creates from the first remote, matching the
  // "N" shortcut so both keyboard paths pick the same start point.
  const primaryRemote = remoteOptions[0]
  const primaryBaseBranch = primaryRemote
    ? `${primaryRemote.name}/${effectiveBaseBranch ?? defaultBranch}`
    : effectiveBaseBranch

  const baseBranchPicker = (
    <div className="mt-1 w-full max-w-[200px] flex flex-col items-center gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        Base branch
      </span>
      <Popover open={baseBranchOpen} onOpenChange={setBaseBranchOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            role="combobox"
            aria-expanded={baseBranchOpen}
            aria-controls="quick-actions-base-branch-list"
            aria-label="Base branch"
            disabled={isCreating}
            className={cn(
              'w-full flex items-center gap-1.5 px-2 py-1 text-xs rounded border border-border bg-background',
              'hover:bg-accent focus:outline-none focus:ring-1 focus:ring-ring',
              'disabled:opacity-50'
            )}
          >
            <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" />
            <span className="truncate flex-1 text-left font-mono">
              {isLoadingBranches && !effectiveBaseBranch
                ? 'Loading…'
                : (effectiveBaseBranch ?? 'Select branch')}
            </span>
            <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-50" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          id="quick-actions-base-branch-list"
          className="p-0 w-[220px]"
          align="center"
          onWheel={e => e.stopPropagation()}
        >
          <Command>
            <CommandInput placeholder="Search branches..." />
            <CommandList onWheel={e => e.stopPropagation()}>
              <CommandEmpty>
                {isLoadingBranches ? 'Loading branches…' : 'No branches found.'}
              </CommandEmpty>
              <CommandGroup>
                {branchOptions.map(branch => {
                  const isStarred = starredBranches.has(branch)
                  return (
                    <CommandItem
                      key={branch}
                      value={branch}
                      onSelect={() => {
                        // Use the closed-over name: cmdk lowercases the onSelect arg.
                        setSelectedBaseBranch(branch)
                        setBaseBranchOpen(false)
                      }}
                      className="pr-1"
                    >
                      <Check
                        className={cn(
                          'mr-2 h-3.5 w-3.5 shrink-0',
                          effectiveBaseBranch === branch
                            ? 'opacity-100'
                            : 'opacity-0'
                        )}
                      />
                      <span className="font-mono text-xs truncate flex-1 min-w-0">
                        {branch}
                      </span>
                      {projectId && (
                        <button
                          type="button"
                          className={cn(
                            '-my-0.5 -mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded',
                            'text-muted-foreground transition-colors',
                            'hover:bg-muted hover:text-foreground',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
                          )}
                          aria-label={
                            isStarred
                              ? `Unstar ${branch}`
                              : `Star ${branch}`
                          }
                          aria-pressed={isStarred}
                          onClick={event => {
                            event.preventDefault()
                            event.stopPropagation()
                            toggleStarredBranch(branch)
                          }}
                          onPointerDown={event => {
                            // Prevent cmdk from selecting the item on press.
                            event.preventDefault()
                            event.stopPropagation()
                          }}
                        >
                          <Star
                            className={cn(
                              'h-3.5 w-3.5',
                              isStarred && 'fill-yellow-500 text-yellow-500'
                            )}
                          />
                        </button>
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )

  const branchNameInput = (
    <>
      <input
        type="text"
        value={customBranchName}
        onChange={e => setCustomBranchName(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter' && !isCreating && !isInvalid)
            handleCreateClick(primaryBaseBranch)
        }}
        placeholder="Branch name (optional)"
        disabled={isCreating}
        aria-invalid={isInvalid}
        aria-label="Branch name"
        className={cn(
          'mt-1 w-full max-w-[180px] px-2 py-1 text-xs text-center rounded border bg-background focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50',
          isInvalid ? 'border-destructive' : 'border-border'
        )}
      />
      {isInvalid && (
        <span className="text-xs text-destructive">Invalid branch name</span>
      )}
    </>
  )

  return (
    <div className="flex flex-col items-center justify-center flex-1 p-4 sm:p-10">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 w-full max-w-xl">
        {hasRemoteOptions ? (
          remoteOptions.map((remote, index) => {
            const baseBranch = `${remote.name}/${effectiveBaseBranch ?? defaultBranch}`
            const RemoteIcon = index === 0 ? Plus : GitFork
            return (
              <button
                type="button"
                key={remote.name}
                onClick={() => handleCreateClick(baseBranch)}
                disabled={isCreating || isInvalid || !effectiveBaseBranch}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-3 sm:gap-4 p-4 sm:p-8 sm:h-full rounded-xl text-sm transition-colors',
                  'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
                  'border border-border bg-card disabled:opacity-50'
                )}
              >
                {isCreating ? (
                  <Loader2 className="h-10 w-10 shrink-0 text-muted-foreground animate-spin" />
                ) : (
                  <RemoteIcon className="h-10 w-10 shrink-0 text-muted-foreground" />
                )}
                <div className="flex flex-col items-center gap-1.5">
                  <span className="font-medium text-base font-mono">
                    {baseBranch}
                  </span>
                  <span className="text-xs text-muted-foreground text-center">
                    {remote.repo
                      ? `New worktree from ${remote.repo}`
                      : `New worktree from the "${remote.name}" remote`}
                  </span>
                  {setupScript && (
                    <span className="text-xs text-muted-foreground/70 font-mono truncate max-w-[200px]">
                      Setup: {setupScript}
                    </span>
                  )}
                </div>
                {index === 0 && (
                  <kbd className="hidden sm:block absolute top-3 right-3 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    N
                  </kbd>
                )}
              </button>
            )
          })
        ) : (
          <>
            {/* Base Session button */}
            <button
              type="button"
              onClick={onBaseSession}
              disabled={isCreating}
              className={cn(
                'relative flex flex-col items-center justify-center gap-4 p-4 sm:p-8 sm:h-full rounded-xl text-sm transition-colors',
                'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
                'border border-border bg-card'
              )}
            >
              <GitBranch className="h-10 w-10 shrink-0 text-muted-foreground" />
              <div className="flex flex-col items-center gap-1.5">
                <span className="font-medium text-base">
                  {hasBaseSession
                    ? 'Switch to Base Session'
                    : 'New Base Session'}
                </span>
                <span className="text-xs text-muted-foreground text-center">
                  Work directly on the project folder
                </span>
              </div>
              <kbd className="hidden sm:block absolute top-3 right-3 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                M
              </kbd>
            </button>

            {/* New Worktree button */}
            <div
              className={cn(
                'relative flex flex-col items-center justify-center gap-3 sm:gap-4 sm:aspect-square p-4 sm:p-8 rounded-xl text-sm transition-colors',
                'border border-border bg-card'
              )}
            >
              {isCreating ? (
                <Loader2 className="h-10 w-10 shrink-0 text-muted-foreground animate-spin" />
              ) : (
                <Plus className="h-10 w-10 shrink-0 text-muted-foreground" />
              )}
              <div className="flex flex-col items-center gap-1.5">
                <span className="font-medium text-base">New Worktree</span>
                <span className="text-xs text-muted-foreground text-center">
                  Create an isolated branch for your task
                </span>
                {setupScript && (
                  <span className="text-xs text-muted-foreground/70 font-mono truncate max-w-[200px]">
                    Setup: {setupScript}
                  </span>
                )}
              </div>
              {baseBranchPicker}
              {branchNameInput}
              <button
                type="button"
                onClick={() => handleCreateClick()}
                disabled={isCreating || isInvalid}
                className={cn(
                  'px-3 py-1 rounded text-xs transition-colors',
                  'bg-primary text-primary-foreground hover:bg-primary/90',
                  'focus:outline-none focus:ring-2 focus:ring-ring',
                  'disabled:opacity-50'
                )}
              >
                Create
              </button>
              <kbd className="hidden sm:block absolute top-3 right-3 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                N
              </kbd>
            </div>
          </>
        )}
      </div>

      {/* Shared base branch + branch name for the per-remote actions */}
      {hasRemoteOptions && (
        <div className="flex flex-col items-center gap-2 mt-6">
          {baseBranchPicker}
          {branchNameInput}
        </div>
      )}

      <div
        className={cn(
          'items-center gap-1 mt-6',
          hasRemoteOptions || (runScripts.length === 0 && projectId)
            ? 'flex'
            : 'hidden'
        )}
      >
        {/* Base session stays available, just not as a headline action */}
        {hasRemoteOptions && (
          <button
            type="button"
            onClick={onBaseSession}
            disabled={isCreating}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground/40 hover:text-foreground hover:bg-accent cursor-pointer transition-colors disabled:opacity-50"
          >
            <GitBranch className="h-4 w-4" />
            <span>
              {hasBaseSession ? 'Switch to Base Session' : 'New Base Session'}
            </span>
          </button>
        )}

        {/* Configure jean.json - only show when not configured */}
        {runScripts.length === 0 && projectId && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleRunClick}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs text-muted-foreground/40 hover:text-foreground hover:bg-accent cursor-pointer transition-colors"
              >
                <Settings className="h-4 w-4" />
                <span>Configure jean.json</span>
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Configure jean.json</TooltipContent>
          </Tooltip>
        )}
      </div>
    </div>
  )
}
