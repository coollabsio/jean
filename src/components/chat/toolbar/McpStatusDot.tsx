import { CheckCircle, ShieldAlert, XCircle } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { McpHealthStatus } from '@/types/chat'

// eslint-disable-next-line react-refresh/only-export-components
export function mcpStatusHint(
  status: McpHealthStatus | undefined
): string | undefined {
  switch (status) {
    case 'needsAuthentication':
      return "Needs authentication — run 'claude /mcp' to authenticate"
    case 'couldNotConnect':
      return 'Could not connect to server'
    default:
      return undefined
  }
}

export function McpStatusDot({
  status,
}: {
  status: McpHealthStatus | undefined
}) {
  if (!status) return null

  switch (status) {
    case 'connected':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <CheckCircle className="size-3 text-green-600 dark:text-green-400" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Connected</TooltipContent>
        </Tooltip>
      )
    case 'needsAuthentication':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <ShieldAlert className="size-3 text-amber-600 dark:text-amber-400" />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {"Needs authentication — run 'claude /mcp' to authenticate"}
          </TooltipContent>
        </Tooltip>
      )
    case 'couldNotConnect':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <XCircle className="size-3 text-red-600 dark:text-red-400" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Could not connect to server</TooltipContent>
        </Tooltip>
      )
    default:
      return null
  }
}
