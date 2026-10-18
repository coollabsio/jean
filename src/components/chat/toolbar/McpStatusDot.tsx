import { CheckCircle, ShieldAlert, XCircle } from '@/components/icons/reicon'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { McpHealthStatus } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'

function authHint(backend?: CliBackend): string {
  switch (backend) {
    case 'codex':
      return 'Needs authentication — use Sign in in MCP settings'
    case 'opencode':
      return "Needs authentication — run 'opencode mcp auth' to authenticate"
    case 'cursor':
      return "Needs authentication — run 'cursor-agent mcp login <server>' to authenticate"
    default:
      return 'Needs authentication — use Sign in in MCP settings'
  }
}

// eslint-disable-next-line react-refresh/only-export-components
export function mcpStatusHint(
  status: McpHealthStatus | undefined,
  backend?: CliBackend
): string | undefined {
  switch (status) {
    case 'needsAuthentication':
      return authHint(backend)
    case 'couldNotConnect':
      return 'Could not connect to server'
    default:
      return undefined
  }
}

export function McpStatusDot({
  status,
  backend,
}: {
  status: McpHealthStatus | undefined
  backend?: CliBackend
}) {
  if (!status) return null

  switch (status) {
    case 'authenticated':
    case 'connected':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <CheckCircle className="size-3 text-success" />
            </span>
          </TooltipTrigger>
          <TooltipContent>
            {status === 'authenticated' ? 'Signed in' : 'Connected'}
          </TooltipContent>
        </Tooltip>
      )
    case 'needsAuthentication':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <ShieldAlert className="size-3 text-warning" />
            </span>
          </TooltipTrigger>
          <TooltipContent>{authHint(backend)}</TooltipContent>
        </Tooltip>
      )
    case 'couldNotConnect':
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <XCircle className="size-3 text-destructive" />
            </span>
          </TooltipTrigger>
          <TooltipContent>Could not connect to server</TooltipContent>
        </Tooltip>
      )
    default:
      return null
  }
}
