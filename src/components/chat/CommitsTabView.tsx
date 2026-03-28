import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  FileText,
  Loader2,
  AlertCircle,
  Search,
  Sparkles,
  ChevronDown,
  Check,
  GitBranch,
} from 'lucide-react'
import { parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs'
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from '@/components/ui/resizable'
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { getFilename } from '@/lib/path-utils'
import { useTheme } from '@/hooks/use-theme'
import { usePreferences } from '@/services/preferences'
import {
  getCommitHistory,
  getCommitDiff,
  getRepoBranches,
} from '@/services/git-status'
import { MemoizedFileDiff, getStatusColor } from './MemoizedFileDiff'
import type { CommitInfo, GitDiff } from '@/types/git-diff'

// ============================================================================
// Helpers
// ============================================================================

/** Format ISO date string as relative time (e.g., "2 hours ago") */
function formatRelativeDate(isoDate: string): string {
  const date = new Date(isoDate)
  const now = Date.now()
  const diff = now - date.getTime()

  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`

  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`

  const years = Math.floor(months / 12)
  return `${years}y ago`
}

// ============================================================================
// Types
// ============================================================================

interface FlatFile {
  key: string
  fileName: string
  fileDiff: FileDiffMetadata
  additions: number
  deletions: number
}

interface CommitsTabViewProps {
  worktreePath: string
  baseBranch: string
  diffStyle: 'split' | 'unified'
  onExecutePrompt?: (reference: string) => void
  onClose: () => void
}

// Stable empty callback for read-only diff (no line selection)
// eslint-disable-next-line @typescript-eslint/no-empty-function
const NOOP_LINE_SELECTED = () => {}
// eslint-disable-next-line @typescript-eslint/no-empty-function
const NOOP_REMOVE_COMMENT = () => {}
const EMPTY_ANNOTATIONS: never[] = []

// ============================================================================
// Component
// ============================================================================

export function CommitsTabView({
  worktreePath,
  baseBranch,
  diffStyle,
  onExecutePrompt,
  onClose,
}: CommitsTabViewProps) {
  // Branch state
  const [branches, setBranches] = useState<string[]>([])
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null)
  const [branchPopoverOpen, setBranchPopoverOpen] = useState(false)

  // Commit list state
  const [commits, setCommits] = useState<CommitInfo[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingCommits, setIsLoadingCommits] = useState(false)
  const [commitsError, setCommitsError] = useState<string | null>(null)

  // Selected commit + diff state
  const [selectedCommitSha, setSelectedCommitSha] = useState<string | null>(
    null
  )
  const [commitDiff, setCommitDiff] = useState<GitDiff | null>(null)
  const [isLoadingDiff, setIsLoadingDiff] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  // File selection state (within a commit's diff)
  const [selectedFileIndex, setSelectedFileIndex] = useState(0)
  const [fileFilter, setFileFilter] = useState('')

  // Theme
  const { theme } = useTheme()
  const { data: preferences } = usePreferences()
  const resolvedThemeType = useMemo((): 'dark' | 'light' => {
    if (theme === 'system') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
    }
    return theme
  }, [theme])

  const commitListRef = useRef<HTMLDivElement>(null)

  // ========================================================================
  // Data loading
  // ========================================================================

  // Load branches once
  useEffect(() => {
    getRepoBranches(worktreePath).then(setBranches).catch(console.error)
  }, [worktreePath])

  // Load commits when branch changes
  const loadCommits = useCallback(
    async (branch: string | null, append = false) => {
      setIsLoadingCommits(true)
      setCommitsError(null)
      try {
        const skip = append ? commits.length : 0
        const result = await getCommitHistory(
          worktreePath,
          branch ?? undefined,
          50,
          skip
        )
        if (append) {
          setCommits(prev => [...prev, ...result.commits])
        } else {
          setCommits(result.commits)
          // Auto-select first commit
          const first = result.commits[0]
          if (first) {
            setSelectedCommitSha(first.sha)
          } else {
            setSelectedCommitSha(null)
            setCommitDiff(null)
          }
        }
        setHasMore(result.hasMore)
      } catch (err) {
        setCommitsError(String(err))
      } finally {
        setIsLoadingCommits(false)
      }
    },
    [worktreePath, commits.length]
  )

  // Initial load + branch change
  useEffect(() => {
    loadCommits(selectedBranch)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedBranch, worktreePath])

  // Load diff when selected commit changes
  useEffect(() => {
    if (!selectedCommitSha) {
      setCommitDiff(null)
      return
    }
    setIsLoadingDiff(true)
    setDiffError(null)
    setSelectedFileIndex(0)
    setFileFilter('')
    getCommitDiff(worktreePath, selectedCommitSha)
      .then(setCommitDiff)
      .catch(err => setDiffError(String(err)))
      .finally(() => setIsLoadingDiff(false))
  }, [worktreePath, selectedCommitSha])

  // ========================================================================
  // Parsed files from diff
  // ========================================================================

  const flattenedFiles: FlatFile[] = useMemo(() => {
    if (!commitDiff?.raw_patch) return []
    try {
      const parsed = parsePatchFiles(commitDiff.raw_patch)
      return parsed.flatMap((patch, patchIndex) =>
        patch.files.map((fileDiff, fileIndex) => {
          const fileName = fileDiff.name || fileDiff.prevName || 'unknown'
          let additions = 0
          let deletions = 0
          for (const hunk of fileDiff.hunks) {
            additions += hunk.additionCount
            deletions += hunk.deletionCount
          }
          return {
            key: `${patchIndex}-${fileIndex}`,
            fileName,
            fileDiff,
            additions,
            deletions,
          }
        })
      )
    } catch {
      return []
    }
  }, [commitDiff?.raw_patch])

  const filteredFiles = useMemo(() => {
    if (!fileFilter) return flattenedFiles
    const lower = fileFilter.toLowerCase()
    return flattenedFiles.filter(f => f.fileName.toLowerCase().includes(lower))
  }, [flattenedFiles, fileFilter])

  const selectedFile =
    filteredFiles.length > 0
      ? filteredFiles[Math.min(selectedFileIndex, filteredFiles.length - 1)]
      : null

  // ========================================================================
  // Handlers
  // ========================================================================

  const handleSelectCommit = useCallback((sha: string) => {
    setSelectedCommitSha(sha)
  }, [])

  const handleLoadMore = useCallback(() => {
    loadCommits(selectedBranch, true)
  }, [loadCommits, selectedBranch])

  const handleSelectBranch = useCallback(
    (branch: string) => {
      setSelectedBranch(branch === baseBranch ? null : branch)
      setBranchPopoverOpen(false)
    },
    [baseBranch]
  )

  const handleReviewCommit = useCallback(
    (commit: CommitInfo) => {
      if (!onExecutePrompt) return
      onExecutePrompt(
        `Review and explain what was implemented in commit ${commit.shortSha}: ${commit.message}`
      )
      onClose()
    },
    [onExecutePrompt, onClose]
  )

  // Keyboard navigation in commit list
  const handleCommitListKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (commits.length === 0) return
      const currentIdx = commits.findIndex(c => c.sha === selectedCommitSha)
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.min(currentIdx + 1, commits.length - 1)
        const nextCommit = commits[next]
        if (nextCommit) setSelectedCommitSha(nextCommit.sha)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = Math.max(currentIdx - 1, 0)
        const prevCommit = commits[prev]
        if (prevCommit) setSelectedCommitSha(prevCommit.sha)
      }
    },
    [commits, selectedCommitSha]
  )

  // ========================================================================
  // Render
  // ========================================================================

  const currentBranchLabel = selectedBranch ?? baseBranch ?? 'HEAD'

  return (
    <ResizablePanelGroup direction="horizontal" className="flex-1 min-h-0 mt-2">
      {/* Left panel: Branch selector + commit list */}
      <ResizablePanel defaultSize={30} minSize={20} maxSize={50}>
        <div className="h-full flex flex-col">
          {/* Branch selector */}
          <div className="shrink-0 px-2 pb-2 border-b border-border">
            <Popover
              open={branchPopoverOpen}
              onOpenChange={setBranchPopoverOpen}
            >
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm bg-muted rounded-md hover:bg-accent transition-colors"
                >
                  <GitBranch className="h-[1em] w-[1em] text-muted-foreground shrink-0" />
                  <span className="truncate flex-1 text-left">
                    {currentBranchLabel}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                className="p-0 w-64"
                align="start"
                onWheel={e => e.stopPropagation()}
              >
                <Command>
                  <CommandInput placeholder="Search branches..." />
                  <CommandList onWheel={e => e.stopPropagation()}>
                    <CommandEmpty>No branches found.</CommandEmpty>
                    <CommandGroup>
                      {branches.map(branch => (
                        <CommandItem
                          key={branch}
                          value={branch}
                          onSelect={() => handleSelectBranch(branch)}
                        >
                          <Check
                            className={cn(
                              'mr-2 h-4 w-4',
                              currentBranchLabel === branch
                                ? 'opacity-100'
                                : 'opacity-0'
                            )}
                          />
                          {branch}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
          </div>

          {/* Commit list */}
          <div
            ref={commitListRef}
            className="flex-1 overflow-y-auto"
            onKeyDown={handleCommitListKeyDown}
            tabIndex={0}
          >
            {isLoadingCommits && commits.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Loading commits...
              </div>
            ) : commitsError ? (
              <div className="flex items-center gap-2 p-3 text-sm text-destructive">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {commitsError}
              </div>
            ) : commits.length === 0 ? (
              <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
                No commits found
              </div>
            ) : (
              <>
                {commits.map(commit => (
                  <div
                    key={commit.sha}
                    role="button"
                    tabIndex={0}
                    onClick={() => handleSelectCommit(commit.sha)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        handleSelectCommit(commit.sha)
                      }
                    }}
                    className={cn(
                      'w-full text-left px-3 py-2.5 border-b border-border transition-colors hover:bg-muted/50 group cursor-pointer',
                      selectedCommitSha === commit.sha && 'bg-accent'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <code className="text-xs text-muted-foreground font-mono shrink-0">
                        {commit.shortSha}
                      </code>
                      <span className="text-sm truncate flex-1">
                        {commit.message}
                      </span>
                      {onExecutePrompt && (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={e => {
                                e.stopPropagation()
                                handleReviewCommit(commit)
                              }}
                              className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-primary/10 transition-opacity shrink-0"
                            >
                              <Sparkles className="h-3.5 w-3.5 text-primary" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent>
                            Ask AI to review this commit
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                      <span className="truncate">{commit.authorName}</span>
                      <span className="shrink-0">
                        {formatRelativeDate(commit.authorDate)}
                      </span>
                      {(commit.additions > 0 || commit.deletions > 0) && (
                        <span className="ml-auto shrink-0">
                          {commit.additions > 0 && (
                            <span className="text-green-500">
                              +{commit.additions}
                            </span>
                          )}
                          {commit.additions > 0 && commit.deletions > 0 && ' '}
                          {commit.deletions > 0 && (
                            <span className="text-red-500">
                              -{commit.deletions}
                            </span>
                          )}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {hasMore && (
                  <button
                    type="button"
                    onClick={handleLoadMore}
                    disabled={isLoadingCommits}
                    className="w-full py-3 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors disabled:opacity-50"
                  >
                    {isLoadingCommits ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Loading...
                      </span>
                    ) : (
                      'Load more commits'
                    )}
                  </button>
                )}
              </>
            )}
          </div>
        </div>
      </ResizablePanel>

      <ResizableHandle className="w-1.5 bg-border/50" />

      {/* Right panel: File list + diff for selected commit */}
      <ResizablePanel defaultSize={70} minSize={50}>
        {isLoadingDiff ? (
          <div className="flex items-center justify-center h-full text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin mr-2" />
            Loading diff...
          </div>
        ) : diffError ? (
          <div className="flex items-center justify-center h-full">
            <div className="flex items-center gap-2 py-4 px-3 bg-destructive/10 text-destructive rounded-md">
              <AlertCircle className="h-4 w-4 shrink-0" />
              <span className="text-sm">{diffError}</span>
            </div>
          </div>
        ) : !selectedCommitSha ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Select a commit to view its changes
          </div>
        ) : flattenedFiles.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No file changes in this commit
          </div>
        ) : (
          <ResizablePanelGroup direction="horizontal" className="h-full">
            {/* File sidebar */}
            <ResizablePanel defaultSize={25} minSize={15} maxSize={50}>
              <div className="h-full overflow-y-auto">
                {flattenedFiles.length > 3 && (
                  <div className="sticky top-0 z-10 bg-background border-b border-border pb-2">
                    <div className="relative">
                      <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-[1em] w-[1em] text-muted-foreground pointer-events-none" />
                      <input
                        type="text"
                        value={fileFilter}
                        onChange={e => {
                          setFileFilter(e.target.value)
                          setSelectedFileIndex(0)
                        }}
                        placeholder="Filter files..."
                        className="w-full bg-muted text-sm outline-none border border-border pl-7 pr-2 py-2.5 placeholder:text-muted-foreground focus:border-ring"
                      />
                    </div>
                  </div>
                )}
                <div>
                  {filteredFiles.map((file, index) => (
                    <Tooltip key={file.key}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => setSelectedFileIndex(index)}
                          className={cn(
                            'w-full flex items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50',
                            index === selectedFileIndex && 'bg-accent'
                          )}
                        >
                          <FileText
                            className={cn(
                              'h-[1em] w-[1em] shrink-0',
                              getStatusColor(file.fileDiff.type)
                            )}
                          />
                          <span className="truncate flex-1">
                            {getFilename(file.fileName)}
                          </span>
                          <div className="flex items-center gap-1 shrink-0">
                            {file.additions > 0 && (
                              <span className="text-green-500">
                                +{file.additions}
                              </span>
                            )}
                            {file.deletions > 0 && (
                              <span className="text-red-500">
                                -{file.deletions}
                              </span>
                            )}
                          </div>
                        </button>
                      </TooltipTrigger>
                      <TooltipContent>{file.fileName}</TooltipContent>
                    </Tooltip>
                  ))}
                </div>
              </div>
            </ResizablePanel>

            <ResizableHandle />

            {/* Diff content */}
            <ResizablePanel defaultSize={75} minSize={50}>
              <div className="h-full min-w-0 overflow-y-auto">
                {selectedFile ? (
                  <div className="px-2">
                    <MemoizedFileDiff
                      key={selectedFile.key}
                      fileDiff={selectedFile.fileDiff}
                      fileName={selectedFile.fileName}
                      annotations={EMPTY_ANNOTATIONS}
                      selectedLines={null}
                      themeType={resolvedThemeType}
                      syntaxThemeDark={
                        preferences?.syntax_theme_dark ?? 'vitesse-black'
                      }
                      syntaxThemeLight={
                        preferences?.syntax_theme_light ?? 'github-light'
                      }
                      diffStyle={diffStyle}
                      enableLineSelection={false}
                      onLineSelected={NOOP_LINE_SELECTED}
                      onRemoveComment={NOOP_REMOVE_COMMENT}
                    />
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-full text-muted-foreground">
                    Select a file to view its diff
                  </div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        )}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}
