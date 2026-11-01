import {
  buildMcpEndpointHeaders,
  type McpEndpointAuth,
} from '@/services/mcp-endpoint-auth'
import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { BackendLabel } from '@/components/ui/backend-label'
import { invokeForOptionalServer } from '@/lib/transport'
import { invalidateAllMcpServers } from '@/services/mcp'
import type { CliBackend } from '@/types/preferences'
import { McpSignInButton } from './McpSignInButton'

const supported = new Set<CliBackend>([
  'claude',
  'codex',
  'opencode',
  'cursor',
  'grok',
  'kimi',
  'devin',
  'antigravity',
  'muse',
])
interface Result {
  backend: CliBackend
  name: string
  success: boolean
  message: string
}

export function AddMcpEndpoint({
  installedBackends,
  serverId,
  onAdded,
}: {
  installedBackends: CliBackend[]
  serverId: string
  onAdded: () => void
}) {
  const [endpoint, setEndpoint] = useState('')
  const [name, setName] = useState('')
  const [headers, setHeaders] = useState('')
  const [auth, setAuth] = useState<McpEndpointAuth>('default')
  const [credential, setCredential] = useState('')
  const [apiKeyHeader, setApiKeyHeader] = useState('X-API-Key')
  const [resultUsesCredentials, setResultUsesCredentials] = useState(false)
  const [excluded, setExcluded] = useState<CliBackend[]>([])
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<Result[]>([])
  const backends = installedBackends.filter(b => supported.has(b))
  const selected = backends.filter(b => !excluded.includes(b))
  let suggestedName = ''
  try {
    suggestedName = new URL(endpoint).hostname.split('.')[0] ?? ''
  } catch {
    /* Incomplete endpoint */
  }

  return (
    <form
      className="space-y-3"
      onSubmit={async event => {
        event.preventDefault()
        let parsedHeaders: Record<string, string> = {}
        try {
          parsedHeaders = buildMcpEndpointHeaders(
            headers,
            auth,
            credential,
            apiKeyHeader
          )
        } catch (error) {
          toast.error(String(error))
          return
        }
        setBusy(true)
        setResults([])
        const toastId = toast.loading('Adding MCP server...')
        try {
          const added = await invokeForOptionalServer<Result[]>(
            serverId,
            'add_remote_mcp_server',
            {
              request: {
                url: endpoint,
                name: name.trim() || null,
                headers: parsedHeaders,
                backends: selected,
              },
            }
          )
          setResults(added)
          setResultUsesCredentials(auth !== 'default')
          if (added.every(result => result.success)) {
            setCredential('')
            setHeaders('')
          }
          invalidateAllMcpServers()
          onAdded()
          const successes = added.filter(r => r.success).length
          if (successes === added.length)
            toast.success('MCP server added', { id: toastId })
          else
            toast.error(
              `Added to ${successes} of ${added.length} harnesses. Check the results below.`,
              { id: toastId }
            )
        } catch (error) {
          toast.error(String(error), { id: toastId })
        } finally {
          setBusy(false)
        }
      }}
    >
      <Label htmlFor="mcp-endpoint">MCP endpoint</Label>
      <div className="flex flex-wrap gap-2">
        <Input
          id="mcp-endpoint"
          type="url"
          required
          placeholder="https://example.com/mcp"
          value={endpoint}
          onChange={e => setEndpoint(e.target.value)}
          className="min-w-0 flex-1"
          disabled={busy}
        />
        <Button
          type="submit"
          disabled={busy || !endpoint.trim() || selected.length === 0}
        >
          {busy ? 'Adding...' : 'Add server'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Adds a remote HTTP server globally to all supported installed harnesses.
        Sign in separately where required. Start a new session after adding.
      </p>
      <details>
        <summary className="cursor-pointer text-sm">Advanced settings</summary>
        <fieldset disabled={busy} className="mt-3 space-y-3">
          <Label htmlFor="mcp-endpoint-name">Server name</Label>
          <Input
            id="mcp-endpoint-name"
            value={name}
            placeholder={suggestedName || 'From endpoint hostname'}
            onChange={e => setName(e.target.value)}
          />
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm font-medium">Authentication</legend>
            {(
              [
                ['default', 'Default (sign in if required)'],
                ['bearer', 'Bearer token (no browser)'],
                ['api-key', 'API key (no browser)'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="mcp-endpoint-auth"
                  value={value}
                  checked={auth === value}
                  onChange={() => setAuth(value)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {auth !== 'default' && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">
                Use a credential issued by this MCP server. The server must
                support this method. OAuth-only servers still require browser
                sign-in.
              </p>
              {auth === 'api-key' && (
                <>
                  <Label htmlFor="mcp-api-key-header">
                    API key header name
                  </Label>
                  <Input
                    id="mcp-api-key-header"
                    value={apiKeyHeader}
                    onChange={e => setApiKeyHeader(e.target.value)}
                    required
                  />
                </>
              )}
              <Label htmlFor="mcp-auth-credential">
                {auth === 'bearer' ? 'Bearer token' : 'API key'}
              </Label>
              <Input
                id="mcp-auth-credential"
                type="password"
                autoComplete="off"
                value={credential}
                onChange={e => setCredential(e.target.value)}
                required
              />
              <p className="text-xs text-muted-foreground">
                Credentials are saved in the selected harness configuration
                files. Jean does not refresh tokens automatically.
              </p>
            </div>
          )}
          <Label htmlFor="mcp-endpoint-headers">Headers (JSON)</Label>
          <Input
            id="mcp-endpoint-headers"
            type="password"
            autoComplete="off"
            value={headers}
            placeholder={'{"Authorization":"Bearer ..."}'}
            onChange={e => setHeaders(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Headers are saved in each selected harness configuration.
          </p>
          <div className="flex flex-wrap gap-3">
            {backends.map(backend => (
              <label key={backend} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={!excluded.includes(backend)}
                  onCheckedChange={checked =>
                    setExcluded(current =>
                      checked
                        ? current.filter(b => b !== backend)
                        : [...current, backend]
                    )
                  }
                />
                <BackendLabel backend={backend} />
              </label>
            ))}
          </div>
        </fieldset>
      </details>
      {backends.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No installed harnesses support endpoint setup.
        </p>
      )}
      {results.length > 0 && (
        <ul className="space-y-2" aria-live="polite">
          {results.map(result => (
            <li
              key={result.backend}
              className="flex flex-wrap items-center gap-2 text-sm"
            >
              <BackendLabel backend={result.backend} />
              <span
                className={
                  result.success ? 'text-muted-foreground' : 'text-destructive'
                }
              >
                {result.message}
              </span>
              {result.success && !resultUsesCredentials && (
                <McpSignInButton
                  backend={result.backend}
                  serverName={result.name}
                  serverId={serverId}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </form>
  )
}
