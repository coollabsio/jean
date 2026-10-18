import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { McpSignInButton } from '@/components/mcp/McpSignInButton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { invokeForServer } from '@/lib/transport'
import {
  useAgentWorkdir,
  useUpdateAgent,
  type AgentConnector,
  type AgentSummary,
} from '@/services/agents'
import type { McpHealthResult, McpServerInfo } from '@/types/chat'
import type { CliBackend } from '@/types/preferences'
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
export function AgentConnectors({ agent }: { agent: AgentSummary }) {
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

  return (
    <div className="flex flex-col gap-4 border-t pt-4">
      <div>
        <h2 className="text-sm font-medium">Connectors and tools</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {connectorSectionNote(support, backend || 'this backend', reason)}
        </p>
      </div>

      {backend && servers.isLoading && (
        <p className="text-xs text-muted-foreground">Loading connectors…</p>
      )}
      {backend && servers.isError && (
        <p className="text-xs text-destructive" role="alert">
          Could not list MCP servers: {String(servers.error)}
        </p>
      )}
      {backend && !canDiscover && (
        <p className="text-xs text-muted-foreground">
          This backend has no MCP server list of its own. Jean does not show
          another CLI&apos;s servers here.
        </p>
      )}
      {canDiscover && servers.data && servers.data.length === 0 && (
        <p className="text-xs text-muted-foreground">
          No MCP servers were discovered for this backend in the agent folder.
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {(servers.data ?? []).map(server => {
          const ref = { backend: server.backend || backend, name: server.name }
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
              className="flex items-center gap-3 rounded-md border px-3 py-2"
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
              <Badge variant={status === 'enabled' ? 'default' : 'muted'}>
                {connectorStatusLabel(status)}
              </Badge>
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
      </ul>

      <div>
        <h3 className="text-sm font-medium">Jean tools</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          {tools === null
            ? 'Every Jean tool is allowed, including tools added later. Turning one off saves an allowlist of the rest. Destructive tools still wait for your approval.'
            : 'Only the tools left on can be called. Tools added later stay off until you allow them. claude_permission_prompt stays available so Claude can ask for permission.'}
        </p>
      </div>
      {catalog.isLoading && (
        <p className="text-xs text-muted-foreground">Loading Jean tools…</p>
      )}
      {catalog.isError && (
        <p className="text-xs text-destructive" role="alert">
          Could not load the Jean tool list: {String(catalog.error)}
        </p>
      )}
      <JeanToolList
        tools={jeanTools.filter(tool => tool.dangerous)}
        selected={tools}
        disabled={updateAgent.isPending || jeanTools.length === 0}
        onToggle={(name, on) =>
          setTools(
            toggleJeanTool(
              tools,
              name,
              jeanTools.map(tool => tool.name),
              on
            )
          )
        }
      />
      {jeanTools.some(tool => !tool.dangerous) && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Other Jean tools
          </summary>
          <div className="mt-2">
            <JeanToolList
              tools={jeanTools.filter(tool => !tool.dangerous)}
              selected={tools}
              disabled={updateAgent.isPending}
              onToggle={(name, on) =>
                setTools(
                  toggleJeanTool(
                    tools,
                    name,
                    jeanTools.map(tool => tool.name),
                    on
                  )
                )
              }
            />
          </div>
        </details>
      )}

      <div className="flex justify-end">
        <Button onClick={handleSave} disabled={!dirty || updateAgent.isPending}>
          Save connectors
        </Button>
      </div>
    </div>
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
    <ul className="flex flex-col gap-2">
      {tools.map(tool => (
        <li key={tool.name} className="flex items-center gap-3">
          <Switch
            checked={jeanToolSelected(selected, tool.name)}
            disabled={disabled}
            aria-label={`Allow Jean tool ${tool.name}`}
            onCheckedChange={on => onToggle(tool.name, on)}
          />
          <span className="min-w-0 flex-1 truncate font-mono text-xs">
            {tool.name}
          </span>
          {tool.dangerous && <Badge variant="destructive">Dangerous</Badge>}
        </li>
      ))}
    </ul>
  )
}
