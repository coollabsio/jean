import { FolderGit2, GitBranch, Loader2, RefreshCw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import { useDetectedProjectWorktrees } from '@/services/projects'
import type { DetectedProjectWorktree } from '@/types/projects'

interface ExistingWorktreeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string | null
  onSelect: (worktree: DetectedProjectWorktree) => Promise<void> | void
  isOpening: boolean
}

export function ExistingWorktreeDialog({
  open,
  onOpenChange,
  projectId,
  onSelect,
  isOpening,
}: ExistingWorktreeDialogProps) {
  const {
    data: detectedWorktrees = [],
    isLoading,
    isFetching,
    refetch,
  } = useDetectedProjectWorktrees(projectId)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh]">
        <DialogHeader>
          <DialogTitle>Open Existing Worktree</DialogTitle>
        </DialogHeader>

        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">
            Select a detected git worktree to open, restore, or import.
          </p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')}
            />
            Refresh
          </Button>
        </div>

        <ScrollArea className="h-[52vh] rounded-md border border-border">
          {isLoading && (
            <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Detecting worktrees...
            </div>
          )}

          {!isLoading && detectedWorktrees.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-12 px-4 text-center">
              <FolderGit2 className="h-5 w-5 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                No existing worktrees detected for this repository.
              </p>
            </div>
          )}

          {!isLoading && detectedWorktrees.length > 0 && (
            <div className="p-2">
              {detectedWorktrees.map(worktree => (
                <button
                  key={worktree.path}
                  type="button"
                  disabled={isOpening}
                  onClick={() => onSelect(worktree)}
                  className="w-full rounded-md border border-transparent p-3 text-left transition-colors hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-medium truncate">{worktree.name}</span>
                    {worktree.isBase && (
                      <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                        Base
                      </span>
                    )}
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 text-[10px]',
                        worktree.tracked && worktree.archived
                          ? 'bg-amber-500/10 text-amber-600'
                          : worktree.tracked
                            ? 'bg-emerald-500/10 text-emerald-600'
                            : 'bg-primary/10 text-primary'
                      )}
                    >
                      {worktree.tracked
                        ? worktree.archived
                          ? 'Restore'
                          : 'Tracked'
                        : 'Import'}
                    </span>
                    {isOpening && (
                      <Loader2 className="ml-auto h-3.5 w-3.5 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                    <GitBranch className="h-3 w-3" />
                    <span className="truncate">{worktree.branch || 'unknown'}</span>
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground/80">
                    {worktree.path}
                  </p>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
