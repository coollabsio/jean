import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { McpSignInButton } from '@/components/mcp/McpSignInButton'
import { useState } from 'react'
import { ChevronRight } from '@/components/icons/reicon'
import { getBackendPlainLabel } from '@/components/ui/backend-label'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { cn } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { invokeForServer } from '@/lib/transport'
import {
  useAgentWorkdir,
  useUpdateAgent,
  type AgentConnector,
  type AgentSummary,
} from '@/services/agents'
import type { McpHealthResult, McpServerInfo } from '@/types/chat'
import { backendOptions, type CliBackend } from '@/types/preferences'
import {
  connectorSectionNote,
  connectorSelected,
  connectorStatus,
  connectorStatusLabel,
  jeanToolSelected,
  hasOwnMcpDiscovery,
  mcpSessionSupport,
  sameConnectors,
  sameJeanTools,
  toggleConnector,
  toggleJeanTool,
} from './agent-connectors'
import { useSavedDraft } from './use-saved-draft'
import {
  AgentBadge,
  AgentEmpty,
  AgentList,
  AgentLoading,
  AgentNotice,
  AgentPanel,
  AgentSection,
  HelpTip,
  SaveFooter,
} from './agent-ui'

function isCliBackend(value: string): value is CliBackend {
  return backendOptions.some(option => option.value === value)
}

interface JeanToolInfo {
  name: string
  dangerous: boolean
}

interface ConnectorCatalog {
  perSessionBackends: string[]
  reasons: Record<string, string>
  jeanTools: JeanToolInfo[]
}

function loginBackend(backend: string): CliBackend | null {
  if (backend === 'claude' || backend === 'codex') return backend
  return null
}

/** Connectors and Jean tools for one agent. */
export function AgentConnectors({
  agent,
  pendingBackend,
}: {
  agent: AgentSummary
  /** Unsaved backend from Run configuration; null when it is saved */
  pendingBackend?: string | null
}) {
  const [otherOpen, setOtherOpen] = useState(false)
  const updateAgent = useUpdateAgent()
  const workdir = useAgentWorkdir(agent.id)
  const backend = agent.backend ?? ''
  const support = mcpSessionSupport(backend)
  const canDiscover = hasOwnMcpDiscovery(backend)
  const catalog = useQuery({
    queryKey: ['agent-connector-catalog', agent.serverId],
    queryFn: () =>
      invokeForServer<ConnectorCatalog>(
        agent.serverId,
        'get_agent_connector_catalog'
      ),
    staleTime: Infinity,
  })
  const servers = useQuery({
    queryKey: [
      'agent-mcp-servers',
      agent.serverId,
      workdir.data ?? '',
      backend,
    ],
    queryFn: () =>
      invokeForServer<McpServerInfo[]>(agent.serverId, 'get_mcp_servers', {
        backend,
        worktreePath: workdir.data,
      }),
    enabled: !!workdir.data && canDiscover && backend.length > 0,
  })
  const health = useQuery({
    queryKey: ['agent-mcp-health', agent.serverId, workdir.data ?? '', backend],
    queryFn: () =>
      invokeForServer<McpHealthResult>(agent.serverId, 'check_mcp_health', {
        backend,
        worktreePath: workdir.data,
      }),
    enabled: !!workdir.data && canDiscover && backend.length > 0,
    retry: false,
    staleTime: 30_000,
  })

  const savedConnectors = agent.mcpServers ?? null
  const savedTools = agent.jeanTools ?? null
  const [connectors, setConnectors] = useSavedDraft<AgentConnector[] | null>(
    savedConnectors,
    sameConnectors
  )
  const [tools, setTools] = useSavedDraft<string[] | null>(
    savedTools,
    sameJeanTools
  )

  const dirty =
    !sameConnectors(connectors, savedConnectors) ||
    !sameJeanTools(tools, savedTools)
  const limited = connectors !== null
  const reason = backend ? catalog.data?.reasons[backend] : undefined
  const jeanTools = catalog.data?.jeanTools ?? []
  const signIn = loginBackend(backend)
  const switchesDisabled = support === 'unsupported' || updateAgent.isPending

  const handleSave = () => {
    updateAgent.mutate(
      {
        agentId: agent.id,
        patch: { mcpServers: connectors, jeanTools: tools },
      },
      {
        onSuccess: () => toast.success(`${agent.name} connectors saved`),
        onError: error => toast.error(`Failed to save connectors: ${error}`),
      }
    )
  }

  const backendName = backend
    ? isCliBackend(backend)
      ? getBackendPlainLabel(backend)
      : backend
    : null
  const toggleTool = (name: string, on: boolean) =>
    setTools(
      toggleJeanTool(
        tools,
        name,
        jeanTools.map(tool => tool.name),
        on
      )
    )
  const dangerousTools = jeanTools.filter(tool => tool.dangerous)
  const otherTools = jeanTools.filter(tool => !tool.dangerous)

  return (
    <AgentSection
      title="Connectors and tools"
      description={connectorSectionNote(
        support,
        backendName ?? 'this backend',
        reason
      )}
      actions={
        <AgentBadge tone={backend ? 'active' : 'neutral'}>
          {backendName ?? 'Default backend'}
        </AgentBadge>
      }
    >
      {pendingBackend !== undefined && pendingBackend !== null && (
        <AgentNotice>
          Save the run configuration first. Connectors below are for the saved
          backend ({backendName ?? 'default'}), not{' '}
          {pendingBackend
            ? isCliBackend(pendingBackend)
              ? getBackendPlainLabel(pendingBackend)
              : pendingBackend
            : 'the default backend'}
          .
        </AgentNotice>
      )}
      <AgentPanel>
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">
            MCP servers
          </h4>
          {backend && servers.isLoading ? (
            <AgentLoading label="Loading connectors…" />
          ) : backend && servers.isError ? (
            <p className="text-xs text-destructive" role="alert">
              Could not list MCP servers: {String(servers.error)}
            </p>
          ) : !backend ? (
            <AgentEmpty title="Pick a backend to list its MCP servers." />
          ) : !canDiscover ? (
            <AgentEmpty title="This backend has no MCP server list." />
          ) : servers.data && servers.data.length === 0 ? (
            <AgentEmpty title="No MCP servers found." />
          ) : (
            <AgentList>
              {(servers.data ?? []).map(server => {
                const ref = {
                  backend: server.backend || backend,
                  name: server.name,
                }
                const selected = connectorSelected(connectors, ref)
                const status = connectorStatus({
                  support,
                  limited,
                  selected,
                  health: health.data?.statuses[server.name],
                })
                return (
                  <li
                    key={`${ref.backend}:${ref.name}`}
                    className="flex items-center gap-3 px-3 py-2.5"
                  >
                    <Switch
                      checked={selected}
                      disabled={switchesDisabled}
                      aria-label={`Allow connector ${server.name}`}
                      onCheckedChange={on =>
                        setConnectors(toggleConnector(connectors, ref, on))
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm">{server.name}</div>
                      <div className="truncate text-xs text-muted-foreground">
                        {server.scope}
                        {server.disabled ? ' · disabled in CLI config' : ''}
                      </div>
                    </div>
                    <AgentBadge
                      tone={status === 'enabled' ? 'active' : 'neutral'}
                    >
                      {connectorStatusLabel(status)}
                    </AgentBadge>
                    {signIn && (
                      <McpSignInButton
                        backend={signIn}
                        serverName={server.name}
                        worktreePath={workdir.data}
                        serverId={agent.serverId}
                      />
                    )}
                  </li>
                )
              })}
            </AgentList>
          )}
        </div>

        <div className="flex flex-col gap-2 pt-2">
          <h4 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            Jean tools
            <HelpTip label="About Jean tools">
              {tools === null
                ? 'Every Jean tool is allowed, including tools added later. Turning one off saves an allowlist of the rest. Destructive tools still wait for your approval.'
                : 'Only the tools left on can be called. Tools added later stay off until you allow them. claude_permission_prompt stays available so Claude can ask for permission.'}
            </HelpTip>
          </h4>
          {catalog.isLoading && <AgentLoading label="Loading Jean tools…" />}
          {catalog.isError && (
            <p className="text-xs text-destructive" role="alert">
              Could not load the Jean tool list: {String(catalog.error)}
            </p>
          )}
          <JeanToolList
            tools={dangerousTools}
            selected={tools}
            disabled={updateAgent.isPending || jeanTools.length === 0}
            onToggle={toggleTool}
          />
          {otherTools.length > 0 && (
            <Collapsible open={otherOpen} onOpenChange={setOtherOpen}>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground">
                <ChevronRight
                  className={cn(
                    'size-3.5 transition-transform',
                    otherOpen && 'rotate-90'
                  )}
                />
                Other Jean tools ({otherTools.length})
              </CollapsibleTrigger>
              <CollapsibleContent className="mt-2">
                <JeanToolList
                  tools={otherTools}
                  selected={tools}
                  disabled={updateAgent.isPending}
                  onToggle={toggleTool}
                />
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>

        <SaveFooter
          dirty={dirty}
          pending={updateAgent.isPending}
          label="Save connectors"
          onDiscard={() => {
            setConnectors(savedConnectors)
            setTools(savedTools)
          }}
          onSave={handleSave}
        />
      </AgentPanel>
    </AgentSection>
  )
}

function JeanToolList({
  tools,
  selected,
  disabled,
  onToggle,
}: {
  tools: JeanToolInfo[]
  selected: string[] | null
  disabled?: boolean
  onToggle: (name: string, on: boolean) => void
}) {
  if (tools.length === 0) return null
  return (
    <AgentList>
      {tools.map(tool => (
        <li key={tool.name} className="flex items-center gap-3 px-3 py-2">
          <Switch
            checked={jeanToolSelected(selected, tool.name)}
            disabled={disabled}
            aria-label={`Allow Jean tool ${tool.name}`}
            onCheckedChange={on => onToggle(tool.name, on)}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {tool.name}
          </span>
          {tool.dangerous && <AgentBadge tone="danger">Dangerous</AgentBadge>}
        </li>
      ))}
    </AgentList>
  )
}
