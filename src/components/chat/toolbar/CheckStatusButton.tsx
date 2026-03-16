import { useCallback } from 'react'
import { Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import type { CheckStatus } from '@/types/pr-status'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface CheckStatusButtonProps {
  status: CheckStatus | null
  projectPath: string | undefined
}

export function CheckStatusButton({
  status,
  projectPath,
}: CheckStatusButtonProps) {
  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (!projectPath) return
      const { setWorkflowRunsModalOpen } = useUIStore.getState()
      setWorkflowRunsModalOpen(true, projectPath)
    },
    [projectPath]
  )

  if (!status) return null

  let className: string
  let tooltip: string
  switch (status) {
    case 'success':
      className =
        'bg-muted-foreground/10 text-muted-foreground/50 hover:bg-muted-foreground/20 hover:text-muted-foreground'
      tooltip = 'Checks passing'
      break
    case 'failure':
    case 'error':
      className =
        'bg-red-500/10 text-red-600 hover:bg-red-500/20 dark:text-red-400'
      tooltip = 'Checks failing'
      break
    case 'pending':
      className =
        'bg-yellow-500/10 text-yellow-600 animate-pulse hover:bg-yellow-500/20 dark:text-yellow-400'
      tooltip = 'Checks pending'
      break
    default:
      return null
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleClick}
          className={cn(
            'ml-1 shrink-0 rounded px-1.5 py-1 transition-colors',
            className
          )}
        >
          <Activity className="h-3 w-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent>{tooltip}</TooltipContent>
    </Tooltip>
  )
}
