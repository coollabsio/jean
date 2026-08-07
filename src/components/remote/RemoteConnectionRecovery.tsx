import { useEffect } from 'react'
import { ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  LOCAL_CONNECTION_ID,
  markConnectionSwitch,
  selectConnection,
  type RemoteConnection,
} from '@/lib/remote-connections'
import { dismissTransientUi } from '@/lib/dismiss-transient-ui'

function reloadPage() {
  window.location.reload()
}

export function RemoteConnectionRecovery({
  connection,
  error,
}: {
  connection: RemoteConnection
  error: string
}) {
  // Drop open context menus / settings / dialogs so they cannot sit above
  // this surface or leave body pointer-events locked (issue #623).
  useEffect(() => {
    dismissTransientUi()
  }, [])

  useEffect(() => {
    const retryTimer = window.setInterval(reloadPage, 10_000)
    return () => window.clearInterval(retryTimer)
  }, [])

  return (
    // z-[100] sits above dialogs (70) and menus/popovers (80).
    <div className="fixed inset-x-0 bottom-0 top-8 z-[100] flex items-center justify-center bg-background">
      <div className="mx-4 w-full max-w-md rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-2">
          <ServerOff className="size-5 text-destructive" />
          <h2 className="font-semibold">
            Couldn&apos;t connect to {connection.name}
          </h2>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">{error}</p>
        <p className="mt-1 truncate text-xs text-muted-foreground">
          {connection.url}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button onClick={reloadPage}>Retry</Button>
          <Button
            variant="outline"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent('open-remote-connections', {
                  detail: { id: connection.id },
                })
              )
            }
          >
            Edit connection
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              markConnectionSwitch()
              selectConnection(LOCAL_CONNECTION_ID)
              reloadPage()
            }}
          >
            Switch to Local
          </Button>
        </div>
      </div>
    </div>
  )
}
