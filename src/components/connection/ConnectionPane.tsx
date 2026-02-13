import { useCallback, useState } from 'react'
import { Eye, EyeOff, Wifi, WifiOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import {
  useWsConnectionStatus,
  disconnectFromServer,
} from '@/lib/transport'

export function ConnectionPane() {
  const connected = useWsConnectionStatus()
  const [serverUrl] = useState(
    () => localStorage.getItem('jean-client-server-url') || ''
  )
  const [token] = useState(
    () => localStorage.getItem('jean-http-token') || ''
  )
  const [showToken, setShowToken] = useState(false)

  const handleDisconnect = useCallback(() => {
    disconnectFromServer()
    // Reload to show connection screen
    window.location.reload()
  }, [])

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium text-foreground">Connection</h3>
        <Separator className="mt-2" />
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-2">
          {connected ? (
            <Wifi className="size-4 text-green-500" />
          ) : (
            <WifiOff className="size-4 text-red-500" />
          )}
          <span className="text-sm font-medium text-foreground">
            {connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        <div className="space-y-2">
          <Label>Server URL</Label>
          <Input value={serverUrl} readOnly className="bg-muted" />
        </div>

        <div className="space-y-2">
          <Label>Access Token</Label>
          <div className="relative">
            <Input
              type={showToken ? 'text' : 'password'}
              value={token}
              readOnly
              className="bg-muted pr-10"
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
        </div>

        <Button variant="destructive" onClick={handleDisconnect}>
          Disconnect
        </Button>
      </div>
    </div>
  )
}
