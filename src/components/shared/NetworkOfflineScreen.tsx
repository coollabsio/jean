import { WifiOff } from '@/components/icons/reicon'
import { useNetworkOnline } from '@/hooks/useNetworkOnline'

/** Full-window page shown while the device has no network connection.
 *  Uses the dialog z-index so dialogs opened later (quit confirmation) stay on top. */
export function NetworkOfflineScreen() {
  const online = useNetworkOnline()
  if (online) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3 bg-background px-6 text-center font-sans"
      role="alert"
      data-testid="network-offline-screen"
    >
      <WifiOff className="size-8 text-warning" />
      <h1 className="text-2xl font-bold text-foreground">You are offline</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Jean has no network connection. This page closes automatically when the
        connection comes back.
      </p>
    </div>
  )
}
