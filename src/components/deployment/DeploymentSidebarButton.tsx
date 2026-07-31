import { useCallback } from 'react'
import { Rocket } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useUIStore } from '@/store/ui-store'
import { useClickUpConfig } from '@/services/clickup'
import { useAiPipelineProjectId } from '@/services/ai-pipeline'

export function DeploymentSidebarButton({ isNarrow }: { isNarrow: boolean }) {
  const open = useUIStore(state => state.deploymentOpen)
  const { data: config } = useClickUpConfig()
  const { projectId } = useAiPipelineProjectId()
  const enabled =
    !!projectId &&
    !!config?.token?.trim() &&
    !!config.productionVersionUrl?.trim()

  const handleClick = useCallback(() => {
    useUIStore.getState().setDeploymentOpen(true)
  }, [])

  if (!enabled) return null

  const button = (
    <button
      type="button"
      onClick={handleClick}
      aria-label="Déploiement"
      className={cn(
        'flex h-9 w-full items-center gap-2 rounded-lg px-2 text-sm transition-colors',
        isNarrow && 'justify-center px-0',
        open
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground'
      )}
    >
      <Rocket className="size-3.5 shrink-0" />
      {!isNarrow && (
        <span className="flex-1 truncate text-left">Déploiement</span>
      )}
    </button>
  )

  return isNarrow ? (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">Déploiement</TooltipContent>
    </Tooltip>
  ) : (
    button
  )
}
