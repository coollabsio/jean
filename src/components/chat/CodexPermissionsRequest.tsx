import { Button } from '@/components/ui/button'
import type { CodexPermissionRequest } from '@/types/chat'

interface CodexPermissionsRequestProps {
  request: CodexPermissionRequest
  onGrant: (scope: 'turn' | 'session') => void
  onDecline: () => void
}

export function CodexPermissionsRequest({
  request,
  onGrant,
  onDecline,
}: CodexPermissionsRequestProps) {
  const fileSystem = request.permissions.fileSystem
  const network = request.permissions.network

  return (
    <div className="my-3 rounded border border-muted bg-muted/30 p-4 font-mono text-sm">
      <div className="mb-2 font-semibold">Codex needs more permissions</div>
      {request.reason && (
        <div className="mb-3 text-muted-foreground">{request.reason}</div>
      )}

      <div className="space-y-2 text-xs text-muted-foreground">
        {fileSystem?.read?.length ? (
          <div>
            <div className="font-medium text-foreground">Read access</div>
            <div>{fileSystem.read.join(', ')}</div>
          </div>
        ) : null}
        {fileSystem?.write?.length ? (
          <div>
            <div className="font-medium text-foreground">Write access</div>
            <div>{fileSystem.write.join(', ')}</div>
          </div>
        ) : null}
        {typeof network?.enabled === 'boolean' ? (
          <div>
            <div className="font-medium text-foreground">Network</div>
            <div>{network.enabled ? 'Enabled' : 'Disabled'}</div>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => onGrant('turn')}>
          Grant for turn
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onGrant('session')}
        >
          Grant for session
        </Button>
        <Button size="sm" variant="ghost" onClick={onDecline}>
          Decline
        </Button>
      </div>
    </div>
  )
}
