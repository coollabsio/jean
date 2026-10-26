import { useLayoutEffect } from 'react'
import { useAgentsEnabledServers } from '@/components/agents/agents-feature'
import { findAgent } from '@/components/agents/agents'
import { useAgentsList } from '@/services/agents'
import { useUIStore } from '@/store/ui-store'

/**
 * Title shown in the mobile title bar and the web browser tab.
 * Agents view uses the selected agent. Project pages use the project, and on
 * desktop also the worktree.
 */
export function resolveWindowTitle({
  showAgents,
  agentName,
  projectName,
  worktreeName,
  worktreeBranch,
  isMobile,
}: {
  showAgents: boolean
  agentName?: string | null
  projectName?: string | null
  worktreeName?: string | null
  worktreeBranch?: string | null
  isMobile: boolean
}): string {
  if (showAgents) {
    const name = agentName?.trim()
    return name || 'Jean'
  }
  if (!projectName || !worktreeName) return 'Jean'
  if (isMobile) return projectName
  const branchSuffix =
    worktreeBranch && worktreeBranch !== worktreeName
      ? ` (${worktreeBranch})`
      : ''
  return `${projectName} › ${worktreeName}${branchSuffix}`
}

/** Reports the selected agent's name while the Agents view is mounted. */
export function AgentsTitleSync({
  onName,
}: {
  onName: (name: string | undefined) => void
}) {
  const enabledServers = useAgentsEnabledServers()
  const selectedAgentId = useUIStore(state => state.selectedAgentId)
  const { data: agents } = useAgentsList(enabledServers)
  const name = findAgent(agents, selectedAgentId)?.name

  useLayoutEffect(() => {
    onName(name)
  }, [name, onName])

  return null
}
