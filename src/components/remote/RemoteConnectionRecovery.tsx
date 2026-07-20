import { ServerOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  LOCAL_CONNECTION_ID,
  markConnectionSwitch,
  selectConnection,
  type RemoteConnection,
} from '@/lib/remote-connections'

export function RemoteConnectionRecovery({
  connection,
  error,
}: {
  connection: RemoteConnection
  error: string
}) {
  const reload = () => window.location.reload()

  return (
    <div className="fixed inset-x-0 bottom-0 top-8 z-[55] flex items-center justify-center bg-background">
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
          <Button onClick={reload}>Retry</Button>
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
              reload()
            }}
          >
            Switch to Local
          </Button>
        </div>
      </div>
    </div>
  )
}
