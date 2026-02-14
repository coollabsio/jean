import { useCallback, useState } from 'react'
import { Eye, EyeOff, Loader2, Wifi } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { invoke, connectToServer } from '@/lib/transport'
import { isNativeApp } from '@/lib/environment'

interface ConnectionScreenProps {
  onConnected: () => void
}

export function ConnectionScreen({ onConnected }: ConnectionScreenProps) {
  const [serverUrl, setServerUrl] = useState(
    () => localStorage.getItem('jean-client-server-url') || ''
  )
  const [token, setToken] = useState(
    () => localStorage.getItem('jean-http-token') || ''
  )
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)

  const handleConnect = useCallback(async () => {
    if (connecting) return
    setError(null)
    setConnecting(true)

    // Normalize URL: strip trailing slash
    let url = serverUrl.trim().replace(/\/+$/, '')
    if (!url) {
      setError('Please enter a server URL.')
      setConnecting(false)
      return
    }

    // Add protocol if missing
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      url = `http://${url}`
    }

    try {
      // Validate by hitting the auth endpoint
      const authUrl = token
        ? `${url}/api/auth?token=${encodeURIComponent(token)}`
        : `${url}/api/auth`

      const res = await fetch(authUrl)
      if (!res.ok) {
        setError(
          token
            ? 'Invalid access token. Check your server settings.'
            : 'Authentication failed. A token may be required.'
        )
        setConnecting(false)
        return
      }
    } catch {
      setError('Could not reach the server. Check the URL and ensure Jean is running.')
      setConnecting(false)
      return
    }

    // Save to localStorage for transport layer
    localStorage.setItem('jean-client-server-url', url)
    if (token) {
      localStorage.setItem('jean-http-token', token)
    } else {
      localStorage.removeItem('jean-http-token')
    }

    // Save to Tauri client config (if in native app)
    if (isNativeApp()) {
      try {
        await invoke('save_client_config', {
          config: { server_url: url, server_token: token },
        })
      } catch {
        // Non-fatal: localStorage is the primary store
      }
    }

    // Trigger WebSocket connection
    connectToServer()
    onConnected()
  }, [serverUrl, token, onConnected])

  return (
    <div className="flex h-screen w-full items-center justify-center bg-background">
      <div className="mx-4 w-full max-w-sm space-y-6">
        <div className="flex flex-col items-center gap-2">
          <div className="flex size-12 items-center justify-center rounded-full bg-primary/10">
            <Wifi className="size-6 text-primary" />
          </div>
          <h1 className="text-xl font-semibold text-foreground">
            Connect to Jean Server
          </h1>
          <p className="text-center text-sm text-muted-foreground">
            Enter your Jean server details to get started.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="server-url">Server URL</Label>
            <Input
              id="server-url"
              type="text"
              placeholder="http://192.168.1.100:3456"
              value={serverUrl}
              onChange={e => setServerUrl(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleConnect()}
              autoFocus
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="server-token">
              Access Token{' '}
              <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <div className="relative">
              <Input
                id="server-token"
                type={showToken ? 'text' : 'password'}
                placeholder="Leave empty if auth is disabled"
                value={token}
                onChange={e => setToken(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleConnect()}
                className="pr-10"
              />
              <button
                type="button"
                onClick={() => setShowToken(!showToken)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                tabIndex={-1}
                aria-label={showToken ? 'Hide token' : 'Show token'}
              >
                {showToken ? (
                  <EyeOff className="size-4" />
                ) : (
                  <Eye className="size-4" />
                )}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              Only required if your server has authentication enabled.
            </p>
          </div>

          {error && (
            <div className="rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          )}

          <Button
            onClick={handleConnect}
            disabled={connecting}
            className="w-full"
          >
            {connecting ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
