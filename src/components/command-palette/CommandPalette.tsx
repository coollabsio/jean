import { useState, useCallback, useMemo } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Server } from '@/components/icons/reicon'
import { useUIStore } from '@/store/ui-store'
import { useCommandContext } from '@/hooks/use-command-context'
import { usePreferences } from '@/services/preferences'
import {
  openServerProject,
  useProjects,
  useAppDataDir,
} from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { useAgentsEnabledServers } from '@/components/agents/agents-feature'
import { useAgentsList, type AgentSummary } from '@/services/agents'
import { AgentIcon } from '@/components/icons/JeanAgentIcon'
import { useProjectsStore } from '@/store/projects-store'
import {
  convertFileSrc,
  convertProjectFileSrc,
  convertServerFileSrc,
  convertServerProjectFileSrc,
} from '@/lib/transport'
import { getAllCommands, executeCommand } from '@/lib/commands'
import { formatShortcutDisplay } from '@/types/keybindings'
import { isNativeApp } from '@/lib/environment'
import {
  getActiveConnectionId,
  useRemoteConnections,
} from '@/lib/remote-connections'
import { LOCAL_SERVER_ID } from '@/types/server-resource'
import {
  isLegacyConnectionCopy,
  serverSubtitle,
} from '@/components/projects/servers/servers-view'
import {
  CommandDialog,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandShortcut,
} from '@/components/ui/command'

interface ProjectCommand {
  id: string
  label: string
  description?: string
  serverName: string
  avatarUrl: string | null
  avatarFallback: string
  isServer: boolean
  group: string
  keywords: string[]
  execute: () => void
}

/** Agent row label: agents on other servers show the server name. */
function agentDescription(agent: AgentSummary, multiServer: boolean) {
  const base = agent.description || 'Open agent'
  return multiServer ? `${base} · ${agent.serverName}` : base
}

export function CommandPalette() {
  const native = isNativeApp()
  useRemoteConnections()
  const { commandPaletteOpen, setCommandPaletteOpen } = useUIStore()
  const { data: preferences } = usePreferences()
  const commandContext = useCommandContext(preferences)
  const [search, setSearch] = useState('')
  const queryClient = useQueryClient()

  // Fetch projects for dynamic commands
  const { data: projects = [] } = useProjects()
  const { data: appDataDir } = useAppDataDir()

  // Get project access timestamps for recency sorting
  const projectAccessTimestamps = useProjectsStore(
    state => state.projectAccessTimestamps
  )
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)
  const selectedProject = projects.find(
    project => project.id === selectedProjectId
  )
  const activeServerId = selectedProject
    ? (selectedProject.serverId ?? LOCAL_SERVER_ID)
    : getActiveConnectionId()

  // Agents (only when the Agents feature is on for a server)
  const agentServers = useAgentsEnabledServers()
  const { data: agents = [] } = useAgentsList(agentServers)
  const multiServerAgents = new Set(agents.map(a => a.serverId)).size > 1

  // Create dynamic project commands (sorted by last-accessed, most recent first)
  // Current project is excluded so the previous project is first (quick CMD+K → Enter switching)
  const projectCommands = useMemo((): ProjectCommand[] => {
    return projects
      .filter(
        p =>
          !p.is_folder &&
          p.id !== selectedProjectId &&
          !isLegacyConnectionCopy(p)
      )
      .sort((a, b) => {
        const aIsActive = (a.serverId ?? LOCAL_SERVER_ID) === activeServerId
        const bIsActive = (b.serverId ?? LOCAL_SERVER_ID) === activeServerId
        if (aIsActive !== bIsActive) return aIsActive ? -1 : 1

        const aTime = projectAccessTimestamps[a.id] ?? 0
        const bTime = projectAccessTimestamps[b.id] ?? 0
        return bTime - aTime
      })
      .map(project => {
        const isServer = !!project.server
        return {
          id: `goto-project-${project.id}`,
          label: project.name,
          description: isServer
            ? serverSubtitle(project)
            : native
              ? `Open on ${project.serverName ?? 'Local'}`
              : undefined,
          serverName: project.serverName ?? 'Local',
          avatarUrl: project.avatar_path
            ? project.serverId
              ? convertServerFileSrc(project.serverId, project.avatar_path)
              : appDataDir
                ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
                : null
            : project.default_avatar_path
              ? project.serverId
                ? convertServerProjectFileSrc(
                    project.serverId,
                    project.default_avatar_path
                  )
                : convertProjectFileSrc(project.default_avatar_path)
              : null,
          avatarFallback: project.name[0]?.toUpperCase() ?? '?',
          isServer,
          group: isServer ? 'servers' : 'projects',
          keywords: [
            isServer ? 'server' : 'project',
            'switch',
            'open',
            project.name.toLowerCase(),
            (project.serverName ?? 'local').toLowerCase(),
          ],
          execute: () => {
            // Leave the Agents page so the project is visible
            useUIStore.getState().setRailSection('workspace')
            useChatStore.getState().clearActiveWorktree()
            if (isServer) openServerProject(project.id, queryClient)
            else useProjectsStore.getState().selectProject(project.id)
          },
        }
      })
  }, [
    queryClient,
    projects,
    appDataDir,
    projectAccessTimestamps,
    selectedProjectId,
    native,
    activeServerId,
  ])

  // Get all available commands (memoized to prevent re-filtering on every render)
  const commandGroups = useMemo(() => {
    const staticCommands = getAllCommands(commandContext, search)

    // Filter project commands by search
    const searchLower = search.toLowerCase().trim()
    const filteredProjectCommands = searchLower
      ? projectCommands.filter(
          cmd =>
            cmd.label.toLowerCase().includes(searchLower) ||
            cmd.keywords.some(kw => kw.includes(searchLower))
        )
      : projectCommands

    const filteredAgents =
      agentServers.length === 0
        ? []
        : searchLower
          ? agents.filter(
              agent =>
                agent.name.toLowerCase().includes(searchLower) ||
                agent.serverName.toLowerCase().includes(searchLower) ||
                'agent'.includes(searchLower)
            )
          : agents

    // Group static commands
    const staticGroups = staticCommands.reduce(
      (acc, command) => {
        const group = command.group || 'other'
        if (!acc[group]) acc[group] = []
        acc[group].push(command)
        return acc
      },
      {} as Record<string, typeof staticCommands>
    )

    return {
      staticGroups,
      projectCommands: filteredProjectCommands.filter(cmd => !cmd.isServer),
      serverCommands: filteredProjectCommands.filter(cmd => cmd.isServer),
      agents: filteredAgents,
    }
  }, [commandContext, search, projectCommands, agents, agentServers.length])

  const handleAgentSelect = useCallback(
    (agentId: string) => {
      setCommandPaletteOpen(false)
      setSearch('')
      const ui = useUIStore.getState()
      ui.setRailSection('agents')
      ui.setSelectedAgentId(agentId)
    },
    [setCommandPaletteOpen]
  )

  // Handle command execution
  const handleCommandSelect = useCallback(
    async (commandId: string) => {
      setCommandPaletteOpen(false)
      setSearch('') // Clear search when closing

      const projectCmd = projectCommands.find(c => c.id === commandId)
      if (projectCmd) {
        projectCmd.execute()
        return
      }

      const result = await executeCommand(commandId, commandContext)

      if (!result.success && result.error) {
        commandContext.showToast(result.error, 'error')
      }
    },
    [commandContext, projectCommands, setCommandPaletteOpen]
  )

  // Handle dialog open/close with search clearing
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setCommandPaletteOpen(open)
      if (!open) {
        setSearch('') // Clear search when closing
      }
    },
    [setCommandPaletteOpen]
  )

  const renderProjectItem = (cmd: ProjectCommand) => (
    <CommandItem
      key={cmd.id}
      value={`${cmd.id} ${cmd.label} ${cmd.description ?? ''}`}
      onSelect={() => handleCommandSelect(cmd.id)}
      className="items-start"
    >
      {/* One line tall so the icon centers on the label's first line */}
      <span className="flex h-lh shrink-0 items-center leading-snug">
        {cmd.isServer ? (
          <Server className="size-4 text-muted-foreground" />
        ) : cmd.avatarUrl ? (
          <img
            src={cmd.avatarUrl}
            alt={cmd.label}
            className="size-4 rounded object-cover"
          />
        ) : (
          <span className="flex size-4 items-center justify-center rounded bg-muted-foreground/20 text-[10px] leading-none font-medium uppercase">
            {cmd.avatarFallback}
          </span>
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate leading-snug">{cmd.label}</span>
        {cmd.description && (
          <span className="text-xs leading-snug text-muted-foreground">
            {cmd.description}
          </span>
        )}
      </div>
    </CommandItem>
  )

  return (
    <CommandDialog
      open={commandPaletteOpen}
      onOpenChange={handleOpenChange}
      title="Command Palette"
      description="Type a command or search..."
      className="top-4 translate-y-0 sm:top-[50%] sm:translate-y-[-50%] sm:max-w-2xl"
      disablePointerSelection
    >
      <CommandInput
        placeholder="Type a command or search..."
        value={search}
        onValueChange={setSearch}
      />
      <CommandList className="max-h-[70dvh] sm:max-h-[300px]">
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Projects and servers stay at the top for quick switching */}
        {commandGroups.projectCommands.length > 0 && (
          <CommandGroup heading="Projects">
            {commandGroups.projectCommands.map(renderProjectItem)}
          </CommandGroup>
        )}
        {commandGroups.serverCommands.length > 0 && (
          <CommandGroup heading="Servers">
            {commandGroups.serverCommands.map(renderProjectItem)}
          </CommandGroup>
        )}

        {commandGroups.agents.length > 0 && (
          <CommandGroup heading="Agents">
            {commandGroups.agents.map(agent => (
              <CommandItem
                key={agent.id}
                value={`agent-${agent.id} ${agent.name} ${agent.serverName}`}
                onSelect={() => handleAgentSelect(agent.id)}
                className="items-start"
              >
                <span className="flex h-lh shrink-0 items-center leading-snug">
                  <AgentIcon icon={agent.icon} className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate leading-snug">{agent.name}</span>
                  <span className="truncate text-xs leading-snug text-muted-foreground">
                    {agentDescription(agent, multiServerAgents)}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {/* Static command groups */}
        {Object.entries(commandGroups.staticGroups).map(
          ([groupName, groupCommands]) => (
            <CommandGroup key={groupName} heading={getGroupLabel(groupName)}>
              {groupCommands.map(command => (
                <CommandItem
                  key={command.id}
                  value={`${command.id} ${command.label} ${command.description ?? ''} ${command.keywords?.join(' ') ?? ''}`}
                  onSelect={() => handleCommandSelect(command.id)}
                  className="items-start"
                >
                  {command.icon && (
                    <span className="flex h-lh shrink-0 items-center leading-snug">
                      <command.icon className="size-4" />
                    </span>
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate leading-snug">
                      {command.label}
                    </span>
                    {command.description && (
                      <span className="text-xs leading-snug text-muted-foreground">
                        {command.description}
                      </span>
                    )}
                  </div>
                  {command.shortcut && (
                    <CommandShortcut className="self-center">
                      {formatShortcutDisplay(command.shortcut)}
                    </CommandShortcut>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          )
        )}
      </CommandList>
    </CommandDialog>
  )
}

// Helper function to get readable group labels
function getGroupLabel(groupName: string): string {
  switch (groupName) {
    case 'navigation':
      return 'Navigation'
    case 'settings':
      return 'Settings'
    case 'window':
      return 'Window'
    case 'notification':
      return 'Notifications'
    case 'github':
      return 'GitHub'
    case 'sessions':
      return 'Sessions'
    case 'other':
      return 'Other'
    default:
      return groupName.charAt(0).toUpperCase() + groupName.slice(1)
  }
}

export default CommandPalette
