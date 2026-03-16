import { GitBranch, Loader2, Plus, Settings } from 'lucide-react'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { useProjectsStore } from '@/store/projects-store'
import type { JeanConfig } from '@/services/projects'

export interface QuickActionsTabProps {
  hasBaseSession: boolean
  onCreateWorktree: () => void
  onBaseSession: () => void
  isCreating: boolean
  projectId: string | null
  jeanConfig: JeanConfig | null | undefined
}

export function QuickActionsTab({
  hasBaseSession,
  onCreateWorktree,
  onBaseSession,
  isCreating,
  projectId,
  jeanConfig,
}: QuickActionsTabProps) {
  const setupScript = jeanConfig?.scripts.setup
  const runScript = jeanConfig?.scripts.run

  const handleRunClick = () => {
    if (!projectId) return
    if (!runScript) {
      useUIStore.getState().setNewWorktreeModalOpen(false)
      useProjectsStore.getState().openProjectSettings(projectId, 'jean-json')
    }
  }

  return (
    <div className="flex flex-col items-center justify-center flex-1 p-4 sm:p-10">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6 w-full max-w-xl">
        {/* Base Session button */}
        <button
          onClick={onBaseSession}
          disabled={isCreating}
          className={cn(
            'relative flex flex-col items-center justify-center gap-4 sm:aspect-square p-4 sm:p-8 rounded-xl text-sm transition-colors',
            'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
            'border border-border'
          )}
        >
          <GitBranch className="h-10 w-10 text-muted-foreground" />
          <div className="flex flex-col items-center gap-1.5">
            <span className="font-medium text-base">
              {hasBaseSession ? 'Switch to Base Session' : 'New Base Session'}
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
        <button
          onClick={onCreateWorktree}
          disabled={isCreating}
          className={cn(
            'relative flex flex-col items-center justify-center gap-4 sm:aspect-square p-4 sm:p-8 rounded-xl text-sm transition-colors',
            'hover:bg-accent focus:outline-none focus:ring-2 focus:ring-ring',
            'border border-border'
          )}
        >
          {isCreating ? (
            <Loader2 className="h-10 w-10 text-muted-foreground animate-spin" />
          ) : (
            <Plus className="h-10 w-10 text-muted-foreground" />
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
          <kbd className="hidden sm:block absolute top-3 right-3 text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
            N
          </kbd>
        </button>
      </div>

      {/* Configure jean.json - only show when not configured */}
      {!runScript && projectId && (
        <div className="flex items-center gap-1 mt-6">
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
        </div>
      )}
    </div>
  )
}
