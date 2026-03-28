import { useEffect, useMemo } from 'react'
import { useChatStore } from '@/store/chat-store'
import {
  useMcpServers,
  invalidateMcpServers,
  getNewServersToAutoEnable,
} from '@/services/mcp'
import type { Project } from '@/types/projects'
import type { AppPreferences, CliBackend } from '@/types/preferences'

interface UseMcpServerResolutionParams {
  activeWorktreePath: string | null | undefined
  deferredSessionId: string | undefined
  project: Project | undefined | null
  preferences: AppPreferences | undefined
  selectedBackend: CliBackend
}

/**
 * Resolves the enabled MCP servers for a session by cascading:
 * session override → project setting → global default, then auto-enabling
 * any newly discovered servers.
 *
 * Uses the selected backend for MCP server discovery so the server list
 * updates when switching backends in the toolbar.
 */
export function useMcpServerResolution({
  activeWorktreePath,
  deferredSessionId,
  project,
  preferences,
  selectedBackend,
}: UseMcpServerResolutionParams) {
  const { data: mcpServersData } = useMcpServers(
    activeWorktreePath,
    selectedBackend
  )
  const availableMcpServers = useMemo(
    () => mcpServersData ?? [],
    [mcpServersData]
  )

  // Re-read MCP config when switching worktrees or backends
  useEffect(() => {
    if (activeWorktreePath)
      invalidateMcpServers(activeWorktreePath, selectedBackend)
  }, [activeWorktreePath, selectedBackend])

  const sessionEnabledMcpServers = useChatStore(state =>
    deferredSessionId ? state.enabledMcpServers[deferredSessionId] : undefined
  )

  // Explicit session override (including empty array) must take precedence.
  // Auto-enable should not re-add servers the user just disabled in-session.
  const hasSessionOverride = sessionEnabledMcpServers !== undefined

  // Resolve enabled servers from session → project → global defaults
  const baseEnabledMcpServers = useMemo(() => {
    if (sessionEnabledMcpServers !== undefined) return sessionEnabledMcpServers
    if (project?.enabled_mcp_servers != null) return project.enabled_mcp_servers
    return preferences?.default_enabled_mcp_servers ?? []
  }, [
    sessionEnabledMcpServers,
    project?.enabled_mcp_servers,
    preferences?.default_enabled_mcp_servers,
  ])

  const knownMcpServers = useMemo(
    () => project?.known_mcp_servers ?? preferences?.known_mcp_servers ?? [],
    [project?.known_mcp_servers, preferences?.known_mcp_servers]
  )

  const newAutoEnabled = useMemo(() => {
    if (hasSessionOverride) return []
    return getNewServersToAutoEnable(
      availableMcpServers,
      baseEnabledMcpServers,
      knownMcpServers
    )
  }, [
    hasSessionOverride,
    availableMcpServers,
    baseEnabledMcpServers,
    knownMcpServers,
  ])

  const enabledMcpServers = useMemo(
    () =>
      newAutoEnabled.length > 0
        ? [...baseEnabledMcpServers, ...newAutoEnabled]
        : baseEnabledMcpServers,
    [baseEnabledMcpServers, newAutoEnabled]
  )

  return {
    availableMcpServers,
    enabledMcpServers,
    mcpServersData,
  }
}
