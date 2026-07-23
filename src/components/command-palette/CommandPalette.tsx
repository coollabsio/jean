import { useEffect, useState, useCallback, useMemo } from 'react'
import { useUIStore } from '@/store/ui-store'
import { useCommandContext } from '@/hooks/use-command-context'
import { usePreferences } from '@/services/preferences'
import { useProjects, useAppDataDir } from '@/services/projects'
import { useChatStore } from '@/store/chat-store'
import { useProjectsStore } from '@/store/projects-store'
import { convertFileSrc, convertProjectFileSrc } from '@/lib/transport'
import { getAllCommands, executeCommand } from '@/lib/commands'
import { formatShortcutDisplay } from '@/types/keybindings'
import { Monitor, Server } from 'lucide-react'
import {
  LOCAL_CONNECTION_ID,
  getActiveConnectionId,
  getRemoteConnections,
  markConnectionSwitch,
  selectConnection,
  useRemoteConnections,
} from '@/lib/remote-connections'
import {
  fetchRemoteServerInfo,
  warnRemoteVersionMismatch,
} from '@/lib/remote-version'
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
  avatarUrl: string | null
  avatarFallback: string
  group: string
  keywords: string[]
  execute: () => void
}

interface ConnectionCommand {
  id: string
  connectionId: string
  label: string
  description: string
  local: boolean
  keywords: string[]
}

export function CommandPalette({
  reloadApp = () => window.location.reload(),
}: {
  reloadApp?: () => void
} = {}) {
  const { commandPaletteOpen, setCommandPaletteOpen } = useUIStore()
  const { data: preferences } = usePreferences()
  const commandContext = useCommandContext(preferences)
  const [search, setSearch] = useState('')
  const remoteConnections = useRemoteConnections()
  const activeConnectionId = getActiveConnectionId()

  // Fetch projects for dynamic commands
  const { data: projects = [] } = useProjects()
  const { data: appDataDir } = useAppDataDir()

  // Get project access timestamps for recency sorting
  const projectAccessTimestamps = useProjectsStore(
    state => state.projectAccessTimestamps
  )
  const selectedProjectId = useProjectsStore(state => state.selectedProjectId)

  const connectionCommands = useMemo((): ConnectionCommand[] => {
    const connections: ConnectionCommand[] = [
      {
        id: `switch-connection-${LOCAL_CONNECTION_ID}`,
        connectionId: LOCAL_CONNECTION_ID,
        label: 'Localhost',
        description: 'This device',
        local: true,
        keywords: ['connection', 'switch', 'local', 'localhost', 'device'],
      },
      ...remoteConnections.map(connection => ({
        id: `switch-connection-${connection.id}`,
        connectionId: connection.id,
        label: connection.name,
        description: connection.url,
        local: false,
        keywords: [
          'connection',
          'switch',
          'remote',
          connection.name.toLowerCase(),
          connection.url.toLowerCase(),
        ],
      })),
    ]

    return connections.filter(
      connection => connection.connectionId !== activeConnectionId
    )
  }, [activeConnectionId, remoteConnections])

  // Create dynamic project commands (sorted by last-accessed, most recent first)
  // Current project is excluded so the previous project is first (quick CMD+K → Enter switching)
  const projectCommands = useMemo((): ProjectCommand[] => {
    return projects
      .filter(p => !p.is_folder && p.id !== selectedProjectId)
      .sort((a, b) => {
        const aTime = projectAccessTimestamps[a.id] ?? 0
        const bTime = projectAccessTimestamps[b.id] ?? 0
        return bTime - aTime
      })
      .map(project => ({
        id: `goto-project-${project.id}`,
        label: project.name,
        description: 'Open',
        avatarUrl:
          project.avatar_path && appDataDir
            ? convertFileSrc(`${appDataDir}/${project.avatar_path}`)
            : project.default_avatar_path
              ? convertProjectFileSrc(project.default_avatar_path)
              : null,
        avatarFallback: project.name[0]?.toUpperCase() ?? '?',
        group: 'projects',
        keywords: ['project', 'switch', 'open', project.name.toLowerCase()],
        execute: () => {
          useChatStore.getState().clearActiveWorktree()
          useProjectsStore.getState().selectProject(project.id)
        },
      }))
  }, [projects, appDataDir, projectAccessTimestamps, selectedProjectId])

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

    return { staticGroups, projectCommands: filteredProjectCommands }
  }, [commandContext, search, projectCommands])

  // Handle command execution
  const handleCommandSelect = useCallback(
    async (commandId: string) => {
      setCommandPaletteOpen(false)
      setSearch('') // Clear search when closing

      // Check connection shortcuts before project and static commands
      const connectionCmd = connectionCommands.find(
        command => command.id === commandId
      )
      if (connectionCmd) {
        if (connectionCmd.connectionId !== LOCAL_CONNECTION_ID) {
          const connection = getRemoteConnections().find(
            item => item.id === connectionCmd.connectionId
          )
          if (!connection) {
            commandContext.showToast('Remote connection not found.', 'error')
            return
          }
          // Warn on mismatch but still switch; transport re-checks after load.
          try {
            const info = await fetchRemoteServerInfo(
              connection.url,
              connection.token
            )
            warnRemoteVersionMismatch(info.appVersion)
          } catch {
            // Unreachable remotes still switch so recovery UI can handle them.
          }
        }
        markConnectionSwitch()
        selectConnection(connectionCmd.connectionId)
        reloadApp()
        return
      }

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
    [
      commandContext,
      connectionCommands,
      projectCommands,
      reloadApp,
      setCommandPaletteOpen,
    ]
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

  // Keyboard shortcut handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setCommandPaletteOpen(!commandPaletteOpen)
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [commandPaletteOpen, setCommandPaletteOpen])

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

        {/* Projects stay at the top for quick switching */}
        {commandGroups.projectCommands.length > 0 && (
          <CommandGroup heading="Projects">
            {commandGroups.projectCommands.map(cmd => (
              <CommandItem
                key={cmd.id}
                value={`${cmd.label} ${cmd.description ?? ''}`}
                onSelect={() => handleCommandSelect(cmd.id)}
                className="items-start"
              >
                {cmd.avatarUrl ? (
                  <img
                    src={cmd.avatarUrl}
                    alt={cmd.label}
                    className="mt-0.5 size-4 shrink-0 rounded object-cover"
                  />
                ) : (
                  <div className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded bg-muted-foreground/20">
                    <span className="text-[10px] font-medium uppercase">
                      {cmd.avatarFallback}
                    </span>
                  </div>
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate leading-snug">{cmd.label}</span>
                  {cmd.description && (
                    <span className="text-xs leading-snug text-muted-foreground">
                      {cmd.description}
                    </span>
                  )}
                </div>
              </CommandItem>
            ))}
          </CommandGroup>
        )}

        {connectionCommands.length > 0 && (
          <CommandGroup heading="Connections">
            {connectionCommands.map(command => (
              <CommandItem
                key={command.id}
                value={`${command.label} ${command.description} ${command.keywords.join(' ')}`}
                onSelect={() => handleCommandSelect(command.id)}
                className="items-start"
              >
                {command.local ? (
                  <Monitor className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <Server className="mt-0.5 size-4 shrink-0" />
                )}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="truncate leading-snug">{command.label}</span>
                  <span className="truncate text-xs leading-snug text-muted-foreground">
                    {command.description}
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
                    <command.icon className="mt-0.5 size-4 shrink-0" />
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
