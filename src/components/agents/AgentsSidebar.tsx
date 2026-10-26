import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, Plus, Server, X } from '@/components/icons/reicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { isNativeApp } from '@/lib/environment'
import { cn } from '@/lib/utils'
import { useUIStore } from '@/store/ui-store'
import { useIsMobile } from '@/hooks/use-mobile'
import { SidebarTabRail } from '@/components/projects/SidebarTabRail'
import { AgentIcon } from '@/components/icons/JeanAgentIcon'
import type { AgentSummary } from '@/services/agents'
import { agentStatusLabel, agentSubtitle, useSelectedAgent } from './agents'
import { NewAgentDialog } from './NewAgentDialog'

/** Dot after the row: blue = unread messages, amber = needs you. */
export function agentRowDot(
  agent: AgentSummary
): 'unread' | 'attention' | null {
  if (agent.pendingApprovals > 0 || agent.status === 'waiting')
    return 'attention'
  if (agent.unreadNotifications > 0) return 'unread'
  return null
}

const ALL_SERVERS = 'all'

/** Servers that have agents, in list order: [serverId, name]. */
export function agentServers(agents: AgentSummary[]): [string, string][] {
  const servers = new Map<string, string>()
  for (const agent of agents) servers.set(agent.serverId, agent.serverName)
  return [...servers]
}

/** Agents of one server, or of all servers. */
export function filterAgentsByServer(
  agents: AgentSummary[],
  serverId: string
): AgentSummary[] {
  return serverId === ALL_SERVERS
    ? agents
    : agents.filter(agent => agent.serverId === serverId)
}

/** Built-in coordinators (Jean) first, then the agents the user created. */
export function splitCoordinators(agents: AgentSummary[]): {
  coordinators: AgentSummary[]
  custom: AgentSummary[]
} {
  return {
    coordinators: agents.filter(agent => agent.builtin),
    custom: agents.filter(agent => !agent.builtin),
  }
}

const ICON_BUTTON =
  'flex items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'

function AgentRow({
  agent,
  isSelected,
  onSelect,
}: {
  agent: AgentSummary
  isSelected: boolean
  onSelect: (agentId: string) => void
}) {
  const dot = agentRowDot(agent)
  const tooltip = [agent.name, agentStatusLabel(agent)]
    .filter(Boolean)
    .join(' · ')
  return (
    <li>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-current={isSelected ? 'page' : undefined}
            aria-label={agent.name}
            className={cn(
              'relative flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors duration-150 @max-[13rem]/agents:justify-center @max-[13rem]/agents:px-0',
              isSelected ? 'bg-accent text-foreground' : 'hover:bg-accent/50'
            )}
            onClick={() => onSelect(agent.id)}
            data-testid={`agent-row-${agent.id}`}
          >
            <span className="relative shrink-0">
              <AgentIcon icon={agent.icon} className="size-9" />
              {agent.status === 'working' && (
                <span
                  className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full bg-green-500 ring-2 ring-sidebar dark:ring-[#0b0b0b]"
                  aria-label="Working"
                />
              )}
            </span>
            <span className="min-w-0 flex-1 @max-[13rem]/agents:hidden">
              <span className="block truncate text-sm font-medium text-foreground">
                {agent.name}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                {agentSubtitle(agent)}
              </span>
            </span>
            {dot && (
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full @max-[13rem]/agents:absolute @max-[13rem]/agents:top-1.5 @max-[13rem]/agents:right-1.5',
                  dot === 'unread' ? 'bg-blue-500' : 'bg-amber-500'
                )}
                aria-label={dot === 'unread' ? 'Unread messages' : 'Needs you'}
              />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent>{tooltip}</TooltipContent>
      </Tooltip>
    </li>
  )
}

/** Coordinator row, then the user's agents. */
function AgentGroup({
  agents,
  selectedId,
  onSelect,
}: {
  agents: AgentSummary[]
  selectedId: string | undefined
  onSelect: (agentId: string) => void
}) {
  const { coordinators, custom } = splitCoordinators(agents)
  return (
    <>
      {coordinators.length > 0 && (
        <ul className="space-y-0.5 px-2">
          {coordinators.map(agent => (
            <AgentRow
              key={agent.id}
              agent={agent}
              isSelected={agent.id === selectedId}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
      {custom.length > 0 && (
        <>
          {/* Narrow sidebar: a divider replaces the heading */}
          <div className="mx-3 mt-3 mb-2 hidden border-t border-border @max-[13rem]/agents:block" />
          <h4 className="pb-1 pl-4 pr-2 pt-4 text-xs text-muted-foreground @max-[13rem]/agents:hidden">
            Your agents
            <span className="ml-1.5 tabular-nums">{custom.length}</span>
          </h4>
          <ul className="space-y-0.5 px-2">
            {custom.map(agent => (
              <AgentRow
                key={agent.id}
                agent={agent}
                isSelected={agent.id === selectedId}
                onSelect={onSelect}
              />
            ))}
          </ul>
        </>
      )}
    </>
  )
}

/** Agents sidebar panel: Jean first, then the user's agents. */
export function AgentsSidebar() {
  const isMobile = useIsMobile()
  const { agent: selected, agents, error } = useSelectedAgent()
  const [newAgentOpen, setNewAgentOpen] = useState(false)
  const serverFilter = useUIStore(state => state.agentsServerFilter)
  const servers = useMemo(() => agentServers(agents ?? []), [agents])
  // Native app with remote servers: filter and group agents by server
  const showServerFilter = isNativeApp() && servers.length > 1
  const visibleAgents = showServerFilter
    ? filterAgentsByServer(agents ?? [], serverFilter)
    : (agents ?? [])
  const groups: [string, string, AgentSummary[]][] =
    showServerFilter && serverFilter === ALL_SERVERS
      ? servers.map(([id, name]) => [
          id,
          name,
          visibleAgents.filter(agent => agent.serverId === id),
        ])
      : [['', '', visibleAgents]]
  const selectedServerLabel =
    serverFilter === ALL_SERVERS
      ? 'All servers'
      : (servers.find(([id]) => id === serverFilter)?.[1] ?? 'All servers')

  // The filtered server has no agents anymore (removed or offline)
  useEffect(() => {
    if (
      agents &&
      serverFilter !== ALL_SERVERS &&
      !servers.some(([id]) => id === serverFilter)
    ) {
      useUIStore.getState().setAgentsServerFilter(ALL_SERVERS)
    }
  }, [agents, servers, serverFilter])

  const handleSelect = useCallback(
    (agentId: string) => {
      const ui = useUIStore.getState()
      ui.setSelectedAgentId(agentId)
      if (isMobile) ui.setLeftSidebarVisible(false)
    },
    [isMobile]
  )

  return (
    <div className="flex h-full">
      {isMobile && (
        <SidebarTabRail className="border-r border-border/40">
          <button
            type="button"
            className={cn(ICON_BUTTON, 'size-12 shrink-0')}
            onClick={() => useUIStore.getState().setLeftSidebarVisible(false)}
            aria-label="Close sidebar"
          >
            <X className="size-6" />
          </button>
        </SidebarTabRail>
      )}
      {/* Narrow sidebar (container below 13rem) shows only the agent icons */}
      <div className="@container/agents flex min-w-0 flex-1 flex-col">
        {/* Same 8px offset and 48px height as the rail buttons, so they line up */}
        <div className="mt-2 flex h-12 shrink-0 items-center justify-between px-3 @max-[13rem]/agents:justify-center">
          <h2 className="text-sm font-medium text-foreground @max-[13rem]/agents:hidden">
            Agents
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(ICON_BUTTON, 'size-7')}
                onClick={() => setNewAgentOpen(true)}
                aria-label="New agent"
              >
                <Plus className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent>New agent</TooltipContent>
          </Tooltip>
        </div>
        {showServerFilter && (
          <div className="shrink-0 px-2 pb-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Filter agents by server"
                  className="flex h-7 w-full items-center gap-2 rounded-md px-2 text-xs @max-[13rem]/agents:justify-center text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <Server className="size-3.5" />
                  <span className="min-w-0 flex-1 truncate text-left @max-[13rem]/agents:hidden">
                    {selectedServerLabel}
                  </span>
                  <ChevronDown className="size-3.5 opacity-50 @max-[13rem]/agents:hidden" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuRadioGroup
                  value={serverFilter}
                  onValueChange={value =>
                    useUIStore.getState().setAgentsServerFilter(value)
                  }
                >
                  <DropdownMenuRadioItem
                    value={ALL_SERVERS}
                    className="text-xs"
                  >
                    All servers
                  </DropdownMenuRadioItem>
                  {servers.map(([id, name]) => (
                    <DropdownMenuRadioItem
                      key={id}
                      value={id}
                      className="text-xs"
                    >
                      {name}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
        {error ? (
          <p className="px-3 text-xs text-destructive">
            Agents are unavailable: {String(error)}
          </p>
        ) : null}
        <div
          className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden pb-3"
          aria-label="Agents"
        >
          {agents &&
            groups.map(([groupId, groupName, groupAgents]) => (
              <section key={groupId || 'agents'}>
                {groupName && (
                  <h3 className="truncate px-4 pb-1.5 pt-3 text-xs font-medium text-muted-foreground @max-[13rem]/agents:hidden">
                    {groupName}
                  </h3>
                )}
                <AgentGroup
                  agents={groupAgents}
                  selectedId={selected?.id}
                  onSelect={handleSelect}
                />
              </section>
            ))}
        </div>
      </div>
      <NewAgentDialog
        open={newAgentOpen}
        onOpenChange={setNewAgentOpen}
        onCreated={handleSelect}
        defaultServerId={
          serverFilter === ALL_SERVERS ? undefined : serverFilter
        }
      />
    </div>
  )
}
