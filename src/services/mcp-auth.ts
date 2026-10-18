import { toast } from 'sonner'
import { invokeForOptionalServer } from '@/lib/transport'
import { queryClient } from '@/lib/query-client'
import { resolveServerCommand } from '@/lib/server-command-routing'
import { useUIStore, type McpLoginContext } from '@/store/ui-store'
import { MCP_HEALTH_KEY, MCP_SERVERS_KEY } from '@/services/mcp'
import type { CliBackend } from '@/types/preferences'
import type { McpHealthResult } from '@/types/chat'

export function supportsMcpLogin(
  backend: CliBackend
): backend is 'claude' | 'codex' {
  return backend === 'claude' || backend === 'codex'
}

export async function openMcpLogin(
  backend: CliBackend,
  serverName: string,
  worktreePath?: string | null,
  ownerServerId?: string
): Promise<boolean> {
  if (!supportsMcpLogin(backend)) return false
  if (useUIStore.getState().cliLoginModalOpen) {
    toast.error('Close the current CLI window before you start MCP sign-in')
    return false
  }
  const toastId = toast.loading(`Preparing sign-in for ${serverName}...`)
  try {
    const serverId =
      ownerServerId ??
      resolveServerCommand({ worktreePath })?.serverId ??
      'local'
    const prepared = await invokeForOptionalServer<{
      command: string
      commandArgs: string[]
      worktreePath: string
    }>(serverId, 'prepare_mcp_login', {
      backend,
      serverName,
      worktreePath: worktreePath ?? null,
    })
    // A second click or another login action must not replace a running PTY.
    if (useUIStore.getState().cliLoginModalOpen) {
      toast.dismiss(toastId)
      return false
    }
    // Update the loading toast before opening the modal. Immediate dismissal
    // can race Sonner's deferred insertion when preparation finishes quickly.
    toast.success(`Sign-in ready for ${serverName}`, {
      id: toastId,
      duration: 1500,
    })
    useUIStore
      .getState()
      .openCliLoginModal(
        backend,
        prepared.command,
        prepared.commandArgs,
        'login',
        { serverName, worktreePath: prepared.worktreePath, serverId }
      )
    return true
  } catch (error) {
    toast.error(`Could not start MCP sign-in: ${error}`, { id: toastId })
    return false
  }
}

/** Health queries are manually enabled, so invalidation alone cannot refresh them. */
export async function refreshMcpLoginHealth(
  backend: CliBackend,
  context: McpLoginContext
): Promise<void> {
  await queryClient.invalidateQueries({
    queryKey: [MCP_SERVERS_KEY],
    predicate: query => query.queryKey[3] === (context.serverId ?? 'local'),
  })
  // Refresh each existing directory for this backend on this owner. With global
  // settings, discovery can use an empty path but login runs from the home dir.
  const queries = queryClient.getQueryCache().findAll({
    queryKey: [MCP_HEALTH_KEY, backend],
  })
  await Promise.all(
    queries.map(async query => {
      const path = query.queryKey[2] as string
      const owner = query.queryKey[3]
      if ((owner ?? 'local') !== (context.serverId ?? 'local')) return
      await queryClient.cancelQueries({ queryKey: query.queryKey, exact: true })
      return queryClient.fetchQuery({
        queryKey: query.queryKey,
        staleTime: 0,
        queryFn: () =>
          invokeForOptionalServer<McpHealthResult>(
            context.serverId,
            'check_mcp_health',
            { backend, worktreePath: path || null }
          ),
      })
    })
  )
}
