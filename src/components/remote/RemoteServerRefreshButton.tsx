import { RefreshCw } from '@/components/icons/reicon'
import { reconnectRemoteServer } from '@/lib/server-connections'
import type { ServerId } from '@/types/server-resource'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

interface RemoteServerRefreshButtonProps {
  serverId: ServerId
  serverName: string
  className?: string
}

export function RemoteServerRefreshButton({
  serverId,
  serverName,
  className,
}: RemoteServerRefreshButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`Reconnect ${serverName}`}
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded opacity-50 transition-opacity hover:bg-accent-foreground/10 hover:opacity-100',
            className
          )}
          onClick={event => {
            event.stopPropagation()
            reconnectRemoteServer(serverId)
          }}
        >
          <RefreshCw className="size-3" />
        </button>
      </TooltipTrigger>
      <TooltipContent>Reconnect {serverName}</TooltipContent>
    </Tooltip>
  )
}
