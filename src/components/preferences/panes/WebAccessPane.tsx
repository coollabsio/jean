import React, { useCallback, useEffect, useState } from 'react'
import {
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  RefreshCw,
  ShieldAlert,
} from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from '@/components/ui/tooltip'
import { usePreferences, usePatchPreferences } from '@/services/preferences'
import type { AppPreferences } from '@/types/preferences'
import { invoke } from '@/lib/transport'
import { toast } from 'sonner'
import { openExternal } from '@/lib/platform'
import { copyToClipboard } from '@/lib/clipboard'
import { SettingsSection } from '../SettingsSection'

const LOOPBACK_BIND_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])
const WILDCARD_BIND_HOSTS = new Set(['0.0.0.0', '::'])

function getConfiguredBindHost(
  preferences: AppPreferences | undefined
): string {
  const explicit = preferences?.http_server_bind_host?.trim()
  if (explicit) return explicit
  return (preferences?.http_server_localhost_only ?? true)
    ? '127.0.0.1'
    : '0.0.0.0'
}

function isLoopbackBindHost(host: string | null | undefined): boolean {
  return host != null && LOOPBACK_BIND_HOSTS.has(host.trim().toLowerCase())
}

function isWildcardBindHost(host: string | null | undefined): boolean {
  return host != null && WILDCARD_BIND_HOSTS.has(host.trim().toLowerCase())
}

function getUrlHostname(url: string | null | undefined): string | null {
  if (!url) return null

  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return null
  }
}

function hasUsableBoundUrl(url: string | null | undefined): boolean {
  const hostname = getUrlHostname(url)
  return hostname != null && !isWildcardBindHost(hostname)
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const InlineField: React.FC<{
  label: string
  description?: React.ReactNode
  children: React.ReactNode
}> = ({ label, description, children }) => (
  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
    <div className="space-y-0.5 sm:w-56 sm:shrink-0 lg:w-72">
      <Label className="text-sm text-foreground">{label}</Label>
      {description && (
        <div className="text-xs text-muted-foreground">{description}</div>
      )}
    </div>
    {children}
  </div>
)

interface ServerStatus {
  running: boolean
  port: number | null
  url: string | null
  token: string | null
  bind_host?: string | null
  localhost_only: boolean | null
}

interface BindHostOption {
  host: string
  label: string
}

export const WebAccessPane: React.FC = () => {
  const { data: preferences } = usePreferences()
  const patchPreferences = usePatchPreferences()
  const [serverStatus, setServerStatus] = useState<ServerStatus | null>(null)
  const [bindHostOptions, setBindHostOptions] = useState<BindHostOption[]>([])
  const [tokenVisible, setTokenVisible] = useState(false)
  const [isToggling, setIsToggling] = useState(false)
  const [bindHostInput, setBindHostInput] = useState(() =>
    getConfiguredBindHost(preferences)
  )

  // Poll server status
  const refreshStatus = useCallback(async () => {
    try {
      const status = await invoke<ServerStatus>('get_http_server_status')
      setServerStatus(status)
    } catch {
      // Ignore errors
    }
  }, [])

  useEffect(() => {
    refreshStatus()
    const interval = setInterval(refreshStatus, 3000)
    return () => clearInterval(interval)
  }, [refreshStatus])

  useEffect(() => {
    let cancelled = false
    const loadBindHostOptions = async () => {
      try {
        const options = await invoke<BindHostOption[]>(
          'list_http_bind_host_options'
        )
        if (!cancelled) setBindHostOptions(options)
      } catch {
        // Ignore failures and leave manual input available
      }
    }

    void loadBindHostOptions()
    return () => {
      cancelled = true
    }
  }, [])

  const handleToggleServer = useCallback(async () => {
    if (!preferences) return
    setIsToggling(true)
    try {
      if (serverStatus?.running) {
        await invoke('stop_http_server')
        toast.success('HTTP server stopped')
      } else {
        await invoke('start_http_server')
        toast.success('HTTP server started')
      }
      await refreshStatus()
    } catch (error) {
      toast.error(`Failed: ${error}`)
    } finally {
      setIsToggling(false)
    }
  }, [preferences, serverStatus?.running, refreshStatus])

  const [portInput, setPortInput] = useState(
    String(preferences?.http_server_port ?? 3456)
  )

  // Sync local state when preferences load/change externally
  useEffect(() => {
    if (preferences?.http_server_port != null) {
      setPortInput(String(preferences.http_server_port))
    }
  }, [preferences?.http_server_port])

  useEffect(() => {
    setBindHostInput(getConfiguredBindHost(preferences))
  }, [
    preferences?.http_server_bind_host,
    preferences?.http_server_localhost_only,
  ])

  const handlePortBlur = useCallback(() => {
    const port = parseInt(portInput, 10)
    if (!isNaN(port) && port >= 1024 && port <= 65535) {
      patchPreferences.mutate({ http_server_port: port })
    } else {
      // Reset to current preference value on invalid input
      setPortInput(String(preferences?.http_server_port ?? 3456))
    }
  }, [portInput, patchPreferences, preferences])

  const handleRegenerateToken = useCallback(async () => {
    try {
      const newToken = await invoke<string>('regenerate_http_token')
      patchPreferences.mutate({ http_server_token: newToken })
      await refreshStatus()
      toast.success('Token regenerated')
    } catch (error) {
      toast.error(`Failed to regenerate token: ${error}`)
    }
  }, [patchPreferences, refreshStatus])

  const tokenRequired = preferences?.http_server_token_required ?? true

  const handleCopyUrl = useCallback(
    async (url: string) => {
      const fullUrl =
        tokenRequired && serverStatus?.token
          ? `${url}?token=${serverStatus.token}`
          : url
      try {
        await copyToClipboard(fullUrl)
        toast.success('URL copied to clipboard')
      } catch (error) {
        toast.error(getErrorMessage(error))
      }
    },
    [serverStatus?.token, tokenRequired]
  )

  const validateBindHost = useCallback(async (host: string) => {
    const trimmed = host.trim()
    if (!trimmed) {
      throw new Error('Bind address cannot be empty')
    }

    return invoke<string>('validate_http_bind_host', { host: trimmed })
  }, [])

  const applyBindHost = useCallback(
    async (nextHost: string) => {
      if (!preferences) return

      const currentBindHost = getConfiguredBindHost(preferences)
      let validatedHost: string

      try {
        validatedHost = await validateBindHost(nextHost)
      } catch (error) {
        setBindHostInput(currentBindHost)
        toast.error(getErrorMessage(error))
        return
      }

      if (validatedHost === currentBindHost) {
        setBindHostInput(validatedHost)
        return
      }

      setBindHostInput(validatedHost)
      try {
        await patchPreferences.mutateAsync({
          http_server_bind_host: validatedHost,
          http_server_localhost_only: isLoopbackBindHost(validatedHost),
        })
      } catch (error) {
        setBindHostInput(currentBindHost)
        toast.error(`Failed to save bind address: ${error}`)
        return
      }

      if (serverStatus?.running) {
        setIsToggling(true)
        try {
          await invoke('stop_http_server')
          await new Promise(resolve => setTimeout(resolve, 100))
          await invoke('start_http_server')
          toast.success('Server restarted with new binding')
        } catch (error) {
          toast.error(
            `Bind address was saved, but the server failed to restart: ${getErrorMessage(error)}`
          )
        } finally {
          await refreshStatus()
          setIsToggling(false)
        }
      }
    },
    [
      patchPreferences,
      preferences,
      refreshStatus,
      serverStatus?.running,
      validateBindHost,
    ]
  )

  const handleBindHostBlur = useCallback(() => {
    void applyBindHost(bindHostInput)
  }, [applyBindHost, bindHostInput])

  const handleBindHostOptionSelect = useCallback(
    (host: string) => {
      setBindHostInput(host)
      void applyBindHost(host)
    },
    [applyBindHost]
  )

  const handleCopyToken = useCallback(async () => {
    const token = serverStatus?.token ?? preferences?.http_server_token
    if (!token) return
    try {
      await copyToClipboard(token)
      toast.success('Token copied to clipboard')
    } catch (error) {
      toast.error(getErrorMessage(error))
    }
  }, [serverStatus, preferences?.http_server_token])

  const handleTokenRequiredChange = useCallback(
    async (checked: boolean) => {
      patchPreferences.mutate({ http_server_token_required: checked })

      // Restart server if currently running to apply the change
      if (serverStatus?.running) {
        setIsToggling(true)
        try {
          await invoke('stop_http_server')
          await new Promise(resolve => setTimeout(resolve, 100))
          await invoke('start_http_server')
          await refreshStatus()
          toast.success('Server restarted with new authentication setting')
        } catch (error) {
          toast.error(`Failed to restart server: ${error}`)
        } finally {
          setIsToggling(false)
        }
      }
    },
    [patchPreferences, serverStatus?.running, refreshStatus]
  )

  const activeBindHost =
    serverStatus?.bind_host ?? getConfiguredBindHost(preferences)
  const boundUrl = serverStatus?.url ?? null
  const selectedBindHostOption = bindHostOptions.some(
    option => option.host === bindHostInput.trim()
  )
    ? bindHostInput.trim()
    : undefined
  const showLocalhostUrl =
    isLoopbackBindHost(activeBindHost) || isWildcardBindHost(activeBindHost)
  const showBoundUrl =
    hasUsableBoundUrl(boundUrl) && !isLoopbackBindHost(activeBindHost)

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Enable HTTP server to access Jean from a web browser on your local
        network. All commands are routed over WebSocket with token
        authentication.
      </p>

      <SettingsSection title="Server" anchorId="pref-web-access-section-server">
        <div className="space-y-4">
          <InlineField
            label="Enable HTTP server"
            description="Start an HTTP + WebSocket server for browser access"
          >
            <div className="flex items-center gap-3">
              <Switch
                checked={serverStatus?.running ?? false}
                onCheckedChange={handleToggleServer}
                disabled={isToggling}
              />
              <div className="flex items-center gap-1.5">
                <div
                  className={`h-2 w-2 rounded-full ${
                    serverStatus?.running
                      ? 'bg-green-500'
                      : 'bg-muted-foreground/40'
                  }`}
                />
                <span className="text-xs text-muted-foreground">
                  {serverStatus?.running ? 'Running' : 'Stopped'}
                </span>
              </div>
            </div>
          </InlineField>

          <InlineField
            label="Port"
            description="Port number for the HTTP server (1024-65535)"
          >
            <Input
              type="number"
              min={1024}
              max={65535}
              className="w-28"
              value={portInput}
              onChange={e => setPortInput(e.target.value)}
              onBlur={handlePortBlur}
              disabled={serverStatus?.running}
            />
          </InlineField>

          <InlineField
            label="Auto-start"
            description="Start the HTTP server automatically when Jean launches"
          >
            <Switch
              checked={preferences?.http_server_auto_start ?? false}
              onCheckedChange={checked => {
                patchPreferences.mutate({ http_server_auto_start: checked })
              }}
            />
          </InlineField>

          <InlineField
            label="Bind address"
            description="Use localhost, 0.0.0.0, or a specific IP such as your Tailscale address"
          >
            <div className="flex flex-col gap-2">
              <Input
                type="text"
                className="w-64 font-mono text-base md:text-xs"
                value={bindHostInput}
                onChange={e => setBindHostInput(e.target.value)}
                onBlur={() => void handleBindHostBlur()}
                disabled={isToggling}
                placeholder="127.0.0.1"
              />
              {bindHostOptions.length > 0 && (
                <Select
                  onValueChange={handleBindHostOptionSelect}
                  value={selectedBindHostOption}
                >
                  <SelectTrigger className="w-64" disabled={isToggling}>
                    <SelectValue placeholder="Use detected address" />
                  </SelectTrigger>
                  <SelectContent>
                    {bindHostOptions.map(option => (
                      <SelectItem key={option.host} value={option.host}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </InlineField>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Authentication"
        anchorId="pref-web-access-section-authentication"
      >
        <div className="space-y-4">
          <InlineField
            label="Require access token"
            description="Require token authentication for web access"
          >
            <Switch
              checked={preferences?.http_server_token_required ?? true}
              onCheckedChange={handleTokenRequiredChange}
              disabled={isToggling}
            />
          </InlineField>

          {!tokenRequired && (
            <div className="flex items-start gap-3 rounded-md border border-amber-500/50 bg-amber-500/10 p-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
              <div className="text-sm text-amber-600 dark:text-amber-400">
                <strong>Security Warning:</strong> Anyone on your network can
                access Jean without authentication. Only disable this on trusted
                networks.
              </div>
            </div>
          )}

          {tokenRequired && (
            <InlineField
              label="Access token"
              description="Token required to connect via browser"
            >
              <div className="flex items-center gap-2">
                <Input
                  type={tokenVisible ? 'text' : 'password'}
                  className="w-64 font-mono text-base md:text-xs"
                  value={
                    serverStatus?.token ?? preferences?.http_server_token ?? ''
                  }
                  readOnly
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setTokenVisible(!tokenVisible)}
                >
                  {tokenVisible ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
                <Button variant="ghost" size="icon" onClick={handleCopyToken}>
                  <Copy className="h-4 w-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={handleRegenerateToken}
                >
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
            </InlineField>
          )}

          {serverStatus?.running && serverStatus?.port && (
            <InlineField
              label="Access URLs"
              description="Open in a browser to access Jean"
            >
              <div className="flex flex-col gap-2">
                {!isLoopbackBindHost(activeBindHost) && (
                  <div className="flex items-start gap-3 rounded-md border border-border bg-muted/40 p-3">
                    <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="text-xs text-muted-foreground">
                      Browsers only treat{' '}
                      <code className="text-foreground">https://</code> and{' '}
                      <code className="text-foreground">http://localhost</code>{' '}
                      as secure contexts. On plain HTTP over a Tailscale IP or
                      MagicDNS name, clipboard copy and some other APIs can
                      fail. Prefer{' '}
                      <code className="text-foreground">tailscale serve</code>{' '}
                      (or any reverse proxy with TLS) in front of Jean, and keep
                      token auth enabled.
                    </div>
                  </div>
                )}
                {showLocalhostUrl && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      className="w-64 font-mono text-base md:text-xs"
                      value={`http://localhost:${serverStatus.port}`}
                      readOnly
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            const base = `http://localhost:${serverStatus.port}`
                            openExternal(
                              tokenRequired && serverStatus.token
                                ? `${base}?token=${serverStatus.token}`
                                : base
                            )
                          }}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Open in browser</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() =>
                            handleCopyUrl(
                              `http://localhost:${serverStatus.port}`
                            )
                          }
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Copy URL</TooltipContent>
                    </Tooltip>
                  </div>
                )}

                {showBoundUrl && boundUrl && (
                  <div className="flex items-center gap-2">
                    <Input
                      type="text"
                      className="w-64 font-mono text-base md:text-xs"
                      value={boundUrl}
                      readOnly
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => {
                            const base = boundUrl
                            openExternal(
                              tokenRequired && serverStatus.token
                                ? `${base}?token=${serverStatus.token}`
                                : base
                            )
                          }}
                        >
                          <ExternalLink className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Open in browser</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => handleCopyUrl(boundUrl)}
                        >
                          <Copy className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>Copy URL</TooltipContent>
                    </Tooltip>
                  </div>
                )}
              </div>
            </InlineField>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}
