import { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Server, Settings } from '@/components/icons/reicon'
import { useUIStore } from '@/store/ui-store'
import { useCommandContext } from '@/hooks/use-command-context'
import { usePreferences } from '@/services/preferences'
import {
  openServerProject,
  useProjects,
  useAppDataDir,
} from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { useAllSessions, useSessionMessageSearch } from '@/services/chat'
import { openSessionInWorktree } from '@/components/chat/open-session'
import { formatRecentActivity } from '@/components/projects/recent-activity'
import { getBackendIcon } from '@/components/ui/backend-label'
import { searchPreferenceEntries } from '@/components/preferences/preferences-search'
import type { Backend } from '@/types/chat'
import {
  useAgentsEnabledServers,
  useShowAgents,
} from '@/components/agents/agents-feature'
import { useAgentsList } from '@/services/agents'
import { AgentIcon } from '@/components/icons/JeanAgentIcon'
import { Badge } from '@/components/ui/badge'
import { useProjectsStore } from '@/store/projects-store'
import { projectAvatarUrl } from '@/lib/project-avatar'
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
  accessedAt: number
  keywords: string[]
  execute: () => void
}

interface SessionResult {
  sessionId: string
  name: string
  projectId: string
  projectName: string
  worktreeId: string
  worktreeName: string
  worktreePath: string
  updatedAt: number
  backend?: Backend
  /** Matched message text; only for "In messages" rows */
  snippet?: string
}

const SESSION_LIMIT = 20
const MESSAGE_LIMIT = 10
const SETTINGS_LIMIT = 6
const MESSAGE_SEARCH_DEBOUNCE_MS = 150

export function CommandPalette() {
  const native = isNativeApp()
  useRemoteConnections()
  const { commandPaletteOpen, setCommandPaletteOpen } = useUIStore()
  const { data: preferences } = usePreferences()
  const commandContext = useCommandContext(preferences)
  const [search, setSearch] = useState('')
  const queryClient = useQueryClient()
  const searchLower = search.toLowerCase().trim()

  // Sessions, settings and message bodies are searched only while typing, so
  // CMD+K → Enter still switches to the previous project.
  const { data: allSessions } = useAllSessions(commandPaletteOpen)
  const [messageQuery, setMessageQuery] = useState('')
  useEffect(() => {
    const timer = setTimeout(
      () => setMessageQuery(search),
      MESSAGE_SEARCH_DEBOUNCE_MS
    )
    return () => clearTimeout(timer)
  }, [search])
  // cmdk selects the new first row on every search change, but it scrolls to
  // the row that was selected before (its aria-selected is not updated yet).
  // New groups above push that old row down, so the list jumps away from the
  // results. Scroll back to the top, where the new selected row is.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      listRef.current?.scrollTo({ top: 0 })
    })
    return () => cancelAnimationFrame(frame)
  }, [search])
  const { data: messageSearch } = useSessionMessageSearch(
    messageQuery,
    commandPaletteOpen
  )

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
  const showAgents = useShowAgents()
  const selectedAgentId = useUIStore(state => state.selectedAgentId)
  const agentsLeftAt = useUIStore(state => state.agentsLeftAt)
  // On the Agents page the current project is not on screen, so list it too
  const hiddenProjectId = showAgents ? null : selectedProjectId

  // Create dynamic project commands (sorted by last-accessed, most recent first)
  // Current project is excluded so the previous project is first (quick CMD+K → Enter switching).
  // On the Agents page it is kept, so CMD+K → Enter returns to it.
  const projectCommands = useMemo((): ProjectCommand[] => {
    return projects
      .filter(
        p =>
          !p.is_folder && p.id !== hiddenProjectId && !isLegacyConnectionCopy(p)
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
          // Server badge beside the name; SSH servers show their target
          description: isServer
            ? serverSubtitle(project) || undefined
            : native &&
                (project.serverId ?? LOCAL_SERVER_ID) !== LOCAL_SERVER_ID
              ? project.serverName
              : undefined,
          serverName: project.serverName ?? 'Local',
          avatarUrl: projectAvatarUrl(project, appDataDir),
          avatarFallback: project.name[0]?.toUpperCase() ?? '?',
          isServer,
          group: isServer ? 'servers' : 'projects',
          accessedAt: projectAccessTimestamps[project.id] ?? 0,
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
    hiddenProjectId,
    native,
    activeServerId,
  ])

  // Get all available commands (memoized to prevent re-filtering on every render)
  const commandGroups = useMemo(() => {
    const staticCommands = getAllCommands(commandContext, search)

    // Filter project commands by search
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

    // The agent was the previous view (left after the last project switch):
    // list it first so CMD+K → Enter returns to it, like the previous project.
    const lastAgent = filteredAgents.find(a => a.id === selectedAgentId)
    const firstProject = filteredProjectCommands.find(cmd => !cmd.isServer)
    const agentIsPrevious =
      !showAgents &&
      !!lastAgent &&
      agentsLeftAt > (firstProject?.accessedAt ?? 0)

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
      agents:
        agentIsPrevious && lastAgent
          ? [lastAgent, ...filteredAgents.filter(a => a !== lastAgent)]
          : filteredAgents,
      agentIsPrevious,
    }
  }, [
    commandContext,
    search,
    searchLower,
    projectCommands,
    agents,
    agentServers.length,
    showAgents,
    selectedAgentId,
    agentsLeftAt,
  ])

  const sessionResults = useMemo((): SessionResult[] => {
    if (!searchLower || !allSessions) return []
    return allSessions.entries
      .flatMap(entry =>
        entry.sessions
          .filter(session => !session.archived_at)
          .map(session => ({
            sessionId: session.id,
            name: session.name,
            projectId: entry.project_id,
            projectName: entry.project_name,
            worktreeId: entry.worktree_id,
            worktreeName: entry.worktree_name,
            worktreePath: entry.worktree_path,
            updatedAt: session.updated_at,
            backend: session.backend,
          }))
      )
      .filter(row =>
        [row.name, row.projectName, row.worktreeName].some(text =>
          text.toLowerCase().includes(searchLower)
        )
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, SESSION_LIMIT)
  }, [allSessions, searchLower])

  const messageResults = useMemo((): SessionResult[] => {
    if (!searchLower || !messageSearch) return []
    const listed = new Set(sessionResults.map(row => row.sessionId))
    return messageSearch.hits
      .filter(hit => !listed.has(hit.session_id))
      .slice(0, MESSAGE_LIMIT)
      .map(hit => ({
        sessionId: hit.session_id,
        name: hit.session_name,
        projectId: hit.project_id,
        projectName: hit.project_name,
        worktreeId: hit.worktree_id,
        worktreeName: hit.worktree_name,
        worktreePath: hit.worktree_path,
        updatedAt: hit.updated_at,
        snippet: hit.snippet,
      }))
  }, [messageSearch, searchLower, sessionResults])

  const settingsResults = useMemo(
    () => searchPreferenceEntries(search, SETTINGS_LIMIT),
    [search]
  )

  const closePalette = useCallback(() => {
    setCommandPaletteOpen(false)
    setSearch('')
  }, [setCommandPaletteOpen])

  const handleSessionSelect = useCallback(
    (row: SessionResult) => {
      closePalette()
      openSessionInWorktree(
        {
          id: row.worktreeId,
          path: row.worktreePath,
          project_id: row.projectId,
        },
        row.sessionId
      )
    },
    [closePalette]
  )

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
      value={`${cmd.id} ${cmd.label} ${cmd.serverName}`}
      onSelect={() => handleCommandSelect(cmd.id)}
    >
      <span className="flex shrink-0 items-center">
        {cmd.isServer ? (
          <Server className="size-4 text-muted-foreground" />
        ) : cmd.avatarUrl ? (
          <img
            src={cmd.avatarUrl}
            alt={cmd.label}
            className="size-4 rounded object-cover"
          />
        ) : (
          <span className="flex size-4 items-center justify-center rounded bg-muted-foreground/20 text-2xs leading-none font-medium uppercase">
            {cmd.avatarFallback}
          </span>
        )}
      </span>
      <span className="min-w-0 truncate">{cmd.label}</span>
      {cmd.description && (
        <Badge variant="subtle" className="max-w-[45%] shrink truncate">
          {cmd.description}
        </Badge>
      )}
    </CommandItem>
  )

  const agentsGroup = commandGroups.agents.length > 0 && (
    <CommandGroup heading="Agents">
      {commandGroups.agents.map(agent => (
        <CommandItem
          key={agent.id}
          value={`agent-${agent.id} ${agent.name} ${agent.serverName}`}
          onSelect={() => handleAgentSelect(agent.id)}
        >
          <AgentIcon icon={agent.icon} className="size-4 shrink-0" />
          <span className="min-w-0 truncate">{agent.name}</span>
          {multiServerAgents && (
            <Badge variant="subtle" className="max-w-[45%] shrink truncate">
              {agent.serverName}
            </Badge>
          )}
        </CommandItem>
      ))}
    </CommandGroup>
  )

  const renderSessionItem = (row: SessionResult, group: string) => {
    const BackendIcon = row.backend ? getBackendIcon(row.backend) : null
    return (
      <CommandItem
        key={`${group}-${row.sessionId}`}
        value={`${group}-${row.sessionId} ${row.name} ${row.projectName} ${row.worktreeName}`}
        keywords={row.snippet ? [row.snippet] : undefined}
        onSelect={() => handleSessionSelect(row)}
        className="items-start"
      >
        <span className="flex h-lh shrink-0 items-center leading-snug">
          <MessageSquare className="size-4 text-muted-foreground" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate leading-snug">{row.name}</span>
          <span className="flex min-w-0 items-center gap-1 text-xs leading-snug text-muted-foreground">
            {row.snippet ? (
              <span className="truncate">{row.snippet}</span>
            ) : (
              <>
                <span className="truncate">
                  {row.projectName} · {row.worktreeName}
                </span>
                {BackendIcon && <BackendIcon className="size-3! shrink-0" />}
              </>
            )}
          </span>
        </div>
        <span className="self-center text-xs whitespace-nowrap text-muted-foreground tabular-nums">
          {formatRecentActivity(row.updatedAt)}
        </span>
      </CommandItem>
    )
  }

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
        placeholder="Search sessions, messages, settings and commands…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList ref={listRef} className="max-h-[70dvh] sm:max-h-[300px]">
        <CommandEmpty>No results found.</CommandEmpty>

        {/* Previous place first for quick CMD+K → Enter switching */}
        {commandGroups.agentIsPrevious && agentsGroup}
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
        {!commandGroups.agentIsPrevious && agentsGroup}
        {sessionResults.length > 0 && (
          <CommandGroup heading="Sessions">
            {sessionResults.map(row => renderSessionItem(row, 'session'))}
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
                  className="group items-start"
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
                      <span className="hidden text-xs leading-snug text-muted-foreground group-data-[selected=true]:block">
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

        {settingsResults.length > 0 && (
          <CommandGroup heading="Settings">
            {settingsResults.map(entry => (
              <CommandItem
                key={entry.id}
                value={`setting-${entry.id} ${entry.title} ${entry.paneTitle} ${entry.sectionTitle ?? ''}`}
                keywords={entry.keywords}
                onSelect={() => {
                  closePalette()
                  useUIStore.getState().openPreferencesEntry(entry.id)
                }}
                className="items-start"
              >
                <span className="flex h-lh shrink-0 items-center leading-snug">
                  <Settings className="size-4 text-muted-foreground" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate leading-snug">{entry.title}</span>
                  <span className="truncate text-xs leading-snug text-muted-foreground">
                    {['Settings', entry.paneTitle, entry.sectionTitle]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {messageResults.length > 0 && (
          <CommandGroup heading="In messages">
            {messageResults.map(row => renderSessionItem(row, 'message'))}
          </CommandGroup>
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
