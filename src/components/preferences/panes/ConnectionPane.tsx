import { useState, useCallback } from 'react'
import { Eye, EyeOff, Wifi, WifiOff } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { isClientMode, getClientServerUrl } from '@/lib/environment'
import {
  connectToServer,
  disconnectFromServer,
  useWsConnectionStatus,
} from '@/lib/transport'
import { toast } from 'sonner'

const getSavedToken = (): string => {
  if (typeof localStorage === 'undefined') return ''
  return localStorage.getItem('jean-http-token') ?? ''
}

export function ConnectionPane() {
  const clientMode = isClientMode()
  const wsConnected = useWsConnectionStatus()
  const [serverUrl, setServerUrl] = useState(() => getClientServerUrl() ?? '')
  const [token, setToken] = useState(() => getSavedToken())
  const [showToken, setShowToken] = useState(false)
  const [connecting, setConnecting] = useState(false)

  const handleConnect = useCallback(async () => {
    const trimmed = serverUrl.trim()
    if (!trimmed) {
      toast.error('Server URL is required')
      return
    }

    setConnecting(true)

    let cleanUrl = trimmed.replace(/\/+$/, '')
    if (!/^https?:\/\//i.test(cleanUrl)) {
      cleanUrl = `http://${cleanUrl}`
    }

    try {
      const parsed = new URL(cleanUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        toast.error('Server URL must start with http:// or https://')
        setConnecting(false)
        return
      }
      cleanUrl = parsed.origin
    } catch {
      toast.error('Enter a valid server URL')
      setConnecting(false)
      return
    }

    const authUrl = token
      ? `${cleanUrl}/api/auth?token=${encodeURIComponent(token)}`
      : `${cleanUrl}/api/auth`

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15_000)

    try {
      const res = await fetch(authUrl, { signal: controller.signal })

      if (!res.ok) {
        toast.error('Connection failed: invalid token or server unreachable')
        setConnecting(false)
        return
      }

      connectToServer(cleanUrl, token || undefined)
    } catch {
      toast.error('Could not reach server. Check the URL and try again.')
      setConnecting(false)
    } finally {
      clearTimeout(timeout)
    }
  }, [serverUrl, token])

  const savedUrl = getClientServerUrl() ?? ''
  const savedToken = getSavedToken()
  const maskedToken = savedToken
    ? '•'.repeat(Math.min(savedToken.length, 32))
    : 'Not set'

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-foreground">Connection</h3>
        <Separator className="mt-2" />
      </div>

      {clientMode && wsConnected ? (
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Wifi className="h-4 w-4 text-green-500" />
            <span className="text-sm font-medium">Connected to remote server</span>
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Server URL</Label>
            <Input value={savedUrl} readOnly className="bg-muted text-sm" />
          </div>

          <div className="space-y-2">
            <Label className="text-xs text-muted-foreground">Access Token</Label>
            <div className="flex gap-2">
              <Input
                value={showToken ? savedToken || 'Not set' : maskedToken}
                readOnly
                className="bg-muted text-sm font-mono"
              />
              {savedToken && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowToken(!showToken)}
                >
                  {showToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              )}
            </div>
          </div>

          <Button
            variant="destructive"
            size="sm"
            onClick={() => disconnectFromServer()}
          >
            Disconnect &amp; Switch to Server Mode
          </Button>
        </div>
      ) : (
        <>
          <div className="rounded-lg border p-4 space-y-1">
            <div className="flex items-center gap-2">
              {clientMode ? (
                <WifiOff className="h-4 w-4 text-destructive" />
              ) : (
                <Wifi className="h-4 w-4 text-green-500" />
              )}
              <span className="text-sm font-medium">
                {clientMode
                  ? 'Client mode is disconnected'
                  : 'Running as local server'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {clientMode
                ? 'Update URL/token and reconnect, or switch back to Server mode.'
                : 'All local features are available. Connect to a remote Jean server to switch to Client mode.'}
            </p>
          </div>

          <div className="space-y-4">
            <h4 className="text-sm font-medium text-foreground">
              {clientMode ? 'Reconnect to Remote Server' : 'Connect to Remote Server'}
            </h4>

            <div className="space-y-2">
              <Label htmlFor="server-url">Server URL</Label>
              <Input
                id="server-url"
                placeholder="http://192.168.1.100:3456"
                value={serverUrl}
                onChange={e => setServerUrl(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && serverUrl.trim()) handleConnect()
                }}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="server-token">
                Access Token{' '}
                <span className="text-muted-foreground font-normal">
                  (optional)
                </span>
              </Label>
              <div className="flex gap-2">
                <Input
                  id="server-token"
                  type={showToken ? 'text' : 'password'}
                  placeholder="Paste from server's Web Access settings"
                  value={token}
                  onChange={e => setToken(e.target.value)}
                  className="flex-1"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowToken(!showToken)}
                  tabIndex={-1}
                >
                  {showToken ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                onClick={handleConnect}
                disabled={connecting || !serverUrl.trim()}
              >
                {connecting
                  ? clientMode
                    ? 'Reconnecting…'
                    : 'Connecting…'
                  : clientMode
                    ? 'Reconnect'
                    : 'Connect'}
              </Button>
              {clientMode && (
                <Button
                  variant="outline"
                  onClick={() => disconnectFromServer()}
                >
                  Switch to Server Mode
                </Button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
