import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { openMcpLogin, supportsMcpLogin } from '@/services/mcp-auth'
import type { CliBackend } from '@/types/preferences'

export function McpSignInButton({
  backend,
  serverName,
  worktreePath,
  serverId,
}: {
  backend: CliBackend
  serverName: string
  worktreePath?: string | null
  serverId?: string
}) {
  const [isPreparing, setIsPreparing] = useState(false)
  if (!supportsMcpLogin(backend)) return null

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-7 shrink-0 px-2 text-xs"
      disabled={isPreparing}
      aria-label={`Sign in to ${serverName}`}
      onClick={async () => {
        setIsPreparing(true)
        try {
          await openMcpLogin(backend, serverName, worktreePath, serverId)
        } finally {
          setIsPreparing(false)
        }
      }}
    >
      {isPreparing ? 'Starting...' : 'Sign in'}
    </Button>
  )
}
